// Direct Emby client (REST, no SDK: the official Emby.SDK has no maintained JS/RN package, and the
// handful of calls an app needs are plain JSON). The phone talks to Emby itself; the account comes
// once from the backend (/v1/emby/account) and only the access token is kept.
// Playback goes through /Videos/{id}/stream, which the NAS nginx hands to go-emby2openlist: it
// 302s to the 115 CDN, so the player streams straight from 115.
import { Platform } from "react-native";
import * as Application from "expo-application";
import { device, nativeCaps } from "../../modules/mediahub-player";
import { api, ApiError } from "./api";
import { connection } from "./device";
import { logger } from "./log";
import { getSettings, setSettings, type EmbyAccount } from "./settings";

const log = logger("emby");
// Header values must be ASCII (fetch rejects others), so the client name is the English one.
const CLIENT = "MediaHub";
// 115 CDN links are bound to the User-Agent that resolved them; ge2o forwards ours, so every
// request of one playback must carry the same UA.
export const PLAYER_UA = `MediaHub/${Application.nativeApplicationVersion ?? "dev"} (iPhone; AetherEngine)`;

export interface UserData { Played?: boolean; PlaybackPositionTicks?: number; PlayedPercentage?: number; IsFavorite?: boolean; UnplayedItemCount?: number }

export interface MediaStream {
  Type: "Video" | "Audio" | "Subtitle" | string;
  Codec?: string;
  Language?: string;
  DisplayTitle?: string;
  Title?: string;
  Index: number;
  IsExternal?: boolean;
  DeliveryUrl?: string;
  IsDefault?: boolean;
  Width?: number;
  Height?: number;
  VideoRange?: string;
  ExtendedVideoType?: string;
  ExtendedVideoSubTypeDescription?: string;
  Channels?: number;
  ChannelLayout?: string;
  Profile?: string;
}

export interface MediaSource { Id: string; Path?: string; Protocol?: string; Container?: string; Size?: number; Bitrate?: number; MediaStreams?: MediaStream[]; RunTimeTicks?: number; DirectStreamUrl?: string; Name?: string }

export interface Item {
  Id: string;
  Name: string;
  Type: string; // Movie / Series / Season / Episode / BoxSet / Folder / CollectionFolder / Video
  CollectionType?: string;
  ProductionYear?: number;
  PremiereDate?: string;
  CommunityRating?: number;
  OfficialRating?: string;
  Overview?: string;
  Genres?: string[];
  RunTimeTicks?: number;
  SeriesId?: string;
  SeriesName?: string;
  SeasonId?: string;
  SeasonName?: string;
  ParentIndexNumber?: number;
  IndexNumber?: number;
  ImageTags?: Record<string, string>;
  BackdropImageTags?: string[];
  ParentBackdropItemId?: string;
  ParentBackdropImageTags?: string[];
  ParentThumbItemId?: string;
  ParentThumbImageTag?: string;
  SeriesPrimaryImageTag?: string;
  PrimaryImageAspectRatio?: number;
  UserData?: UserData;
  ChildCount?: number;
  RecursiveItemCount?: number;
  Status?: string;
  ProviderIds?: Record<string, string>;
  MediaSources?: MediaSource[];
  MediaStreams?: MediaStream[];
  DateCreated?: string;
  Path?: string;
  People?: { Name: string; Role?: string; Type: string; Id: string; PrimaryImageTag?: string }[];
  Studios?: { Name: string }[];
}

export interface ItemsResult { Items: Item[]; TotalRecordCount: number }

export class EmbyError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function account(): EmbyAccount {
  return getSettings().emby;
}

function authHeader(token?: string) {
  const a = account();
  const device = Platform.OS === "ios" ? "iPhone" : Platform.OS;
  return `MediaBrowser Client="${CLIENT}", Device="${device}", DeviceId="${a.deviceId}", Version="${Application.nativeApplicationVersion ?? "0"}"${token ? `, Token="${token}"` : ""}`;
}

async function request<T>(path: string, opts: { method?: string; body?: unknown; timeoutMs?: number; server?: string; token?: string } = {}): Promise<T> {
  const a = account();
  const server = (opts.server ?? a.server).replace(/\/+$/, "");
  const token = opts.token ?? a.token;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20_000);
  const t0 = Date.now();
  try {
    const res = await fetch(`${server}/emby${path}`, {
      method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
      headers: {
        "X-Emby-Authorization": authHeader(token),
        ...(token ? { "X-Emby-Token": token } : {}),
        accept: "application/json",
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: ctrl.signal,
    });
    log.info("call", { path: path.split("?")[0], status: res.status, ms: Date.now() - t0 });
    if (res.status === 401) throw new EmbyError("Emby 登录已失效", 401);
    if (!res.ok) throw new EmbyError(`Emby 返回 ${res.status}`, res.status);
    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  } catch (e) {
    if (e instanceof EmbyError) throw e;
    const aborted = (e as { name?: string }).name === "AbortError";
    throw new EmbyError(aborted ? "连接 Emby 超时" : "无法连接 Emby", 0);
  } finally {
    clearTimeout(timer);
  }
}

export async function login(server: string, username: string, password: string): Promise<EmbyAccount> {
  const clean = server.trim().replace(/\/+$/, "");
  const r = await request<{ AccessToken: string; User: { Id: string; Name: string } }>("/Users/AuthenticateByName", {
    server: clean, token: "", body: { Username: username, Pw: password }, timeoutMs: 20_000,
  });
  const next = { ...account(), server: clean, username: r.User.Name, token: r.AccessToken, userId: r.User.Id };
  setSettings({ emby: next });
  log.info("login", { user: r.User.Name });
  return next;
}

export function logout() {
  const a = account();
  if (a.token) void request("/Sessions/Logout", { method: "POST", body: {} }).catch(() => {});
  setSettings({ emby: { ...a, token: "", userId: "" } });
}

let auto: Promise<boolean> | null = null;

// First launch: fetch the account the backend holds and log in once.
export function ensureLogin(): Promise<boolean> {
  if (account().token) return Promise.resolve(true);
  if (!getSettings().token) return Promise.resolve(false);
  auto ??= (async () => {
    try {
      const acc = await api<{ server: string; username: string; password: string }>("/v1/emby/account");
      if (!acc.username) return false;
      await login(acc.server, acc.username, acc.password);
      return true;
    } catch (e) {
      log.warn("auto login failed", e instanceof ApiError || e instanceof EmbyError ? e.message : e);
      return false;
    } finally {
      auto = null;
    }
  })();
  return auto;
}

// Every read goes through here: logs in on first use and once more when the token expires.
// Paths are functions so they're built after login (they contain the user id).
export async function emby<T>(path: string | (() => string), opts: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
  if (!(await ensureLogin())) throw new EmbyError("还没有登录 Emby，请在设置里登录", 401);
  const p = () => (typeof path === "function" ? path() : path);
  try {
    return await request<T>(p(), opts);
  } catch (e) {
    if (e instanceof EmbyError && e.status === 401) {
      setSettings({ emby: { ...account(), token: "" } });
      if (await ensureLogin()) return request<T>(p(), opts);
    }
    throw e;
  }
}

const uid = () => account().userId;
const FIELDS = "PrimaryImageAspectRatio,Overview,Genres,ProductionYear,CommunityRating,OfficialRating,RunTimeTicks,ChildCount,RecursiveItemCount,DateCreated,Status,ProviderIds";

function qs(params: Record<string, string | number | boolean | undefined | null>) {
  return Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");
}

export const embyApi = {
  views: () => emby<ItemsResult>(() => `/Users/${uid()}/Views`),
  resume: (limit = 20) => emby<ItemsResult>(() => `/Users/${uid()}/Items/Resume?${qs({ Limit: limit, Fields: FIELDS, MediaTypes: "Video", EnableImageTypes: "Primary,Backdrop,Thumb" })}`),
  nextUp: (limit = 20, seriesId?: string) => emby<ItemsResult>(() => `/Shows/NextUp?${qs({ UserId: uid(), Limit: limit, SeriesId: seriesId, Fields: FIELDS })}`),
  latest: (parentId: string, limit = 16) => emby<Item[]>(() => `/Users/${uid()}/Items/Latest?${qs({ ParentId: parentId, Limit: limit, Fields: FIELDS, GroupItems: true })}`),
  items: (p: { parentId?: string; search?: string; start?: number; limit?: number; sort?: "added" | "name" | "year" | "rating"; types?: string; filters?: string }) =>
    emby<ItemsResult>(() => `/Users/${uid()}/Items?${qs({
      ParentId: p.parentId, SearchTerm: p.search, StartIndex: p.start ?? 0, Limit: p.limit ?? 40, Recursive: true,
      IncludeItemTypes: p.types ?? "Movie,Series", Fields: FIELDS, Filters: p.filters,
      SortBy: { added: "DateCreated,SortName", name: "SortName", year: "ProductionYear,SortName", rating: "CommunityRating,SortName" }[p.sort ?? "added"],
      SortOrder: p.sort === "name" ? "Ascending" : "Descending",
    })}`),
  item: (id: string) => emby<Item>(() => `/Users/${uid()}/Items/${id}?${qs({ Fields: `${FIELDS},People,Studios,MediaSources,Path` })}`),
  seasons: (seriesId: string) => emby<ItemsResult>(() => `/Shows/${seriesId}/Seasons?${qs({ UserId: uid(), Fields: FIELDS })}`),
  episodes: (seriesId: string, seasonId?: string) => emby<ItemsResult>(() => `/Shows/${seriesId}/Episodes?${qs({ UserId: uid(), SeasonId: seasonId, Fields: `${FIELDS},MediaSources` })}`),
  setPlayed: (id: string, played: boolean) => emby(() => `/Users/${uid()}/PlayedItems/${id}`, { method: played ? "POST" : "DELETE", body: played ? {} : undefined }),
  setFavorite: (id: string, fav: boolean) => emby(() => `/Users/${uid()}/FavoriteItems/${id}`, { method: fav ? "POST" : "DELETE", body: fav ? {} : undefined }),
};

// Image URL straight from Emby (images need no auth; tags make them cacheable forever).
export function embyImage(id: string | undefined, type: "Primary" | "Backdrop" | "Thumb" | "Logo" = "Primary", opts: { tag?: string; w?: number } = {}) {
  if (!id) return undefined;
  const a = account();
  if (!a.server) return undefined;
  return { uri: `${a.server}/emby/Items/${id}/Images/${type}?${qs({ maxWidth: opts.w ?? 400, tag: opts.tag, quality: 90 })}` };
}

// Best poster (2:3) / landscape (16:9) image for any item.
export function posterOf(i: Item, w = 400) {
  if (i.Type === "Episode" && i.SeriesId) return embyImage(i.SeriesId, "Primary", { tag: i.SeriesPrimaryImageTag, w });
  return i.ImageTags?.Primary ? embyImage(i.Id, "Primary", { tag: i.ImageTags.Primary, w }) : undefined;
}

export function landscapeOf(i: Item, w = 640) {
  if (i.Type === "Episode" && i.ImageTags?.Primary) return embyImage(i.Id, "Primary", { tag: i.ImageTags.Primary, w });
  if (i.ImageTags?.Thumb) return embyImage(i.Id, "Thumb", { tag: i.ImageTags.Thumb, w });
  if (i.ParentThumbItemId) return embyImage(i.ParentThumbItemId, "Thumb", { tag: i.ParentThumbImageTag, w });
  if (i.BackdropImageTags?.[0]) return embyImage(i.Id, "Backdrop", { tag: i.BackdropImageTags[0], w });
  if (i.ParentBackdropItemId) return embyImage(i.ParentBackdropItemId, "Backdrop", { tag: i.ParentBackdropImageTags?.[0], w });
  return posterOf(i, w);
}

export function backdropOf(i: Item, w = 1280) {
  if (i.BackdropImageTags?.[0]) return embyImage(i.Id, "Backdrop", { tag: i.BackdropImageTags[0], w });
  if (i.ParentBackdropItemId) return embyImage(i.ParentBackdropItemId, "Backdrop", { tag: i.ParentBackdropImageTags?.[0], w });
  return undefined;
}

export const ticks = (s: number) => Math.round(s * 10_000_000);
export const seconds = (t?: number) => (t ? t / 10_000_000 : 0);

export function runtime(t?: number) {
  const m = Math.round(seconds(t) / 60);
  if (!m) return "";
  return m >= 60 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分` : `${m} 分钟`;
}

// "HEVC · 4K · Dolby Vision · Atmos" from the first media source.
export function techBadges(i: Item): string[] {
  const streams = i.MediaSources?.[0]?.MediaStreams ?? i.MediaStreams ?? [];
  const v = streams.find((s) => s.Type === "Video");
  const a = streams.find((s) => s.Type === "Audio" && s.IsDefault) ?? streams.find((s) => s.Type === "Audio");
  const out: string[] = [];
  if (v?.Width) out.push(v.Width >= 3800 ? "4K" : v.Width >= 1900 ? "1080p" : v.Width >= 1260 ? "720p" : `${v.Height}p`);
  if (v?.Codec) out.push(v.Codec.toUpperCase().replace("H264", "AVC"));
  const range = `${v?.ExtendedVideoType ?? ""} ${v?.ExtendedVideoSubTypeDescription ?? ""} ${v?.VideoRange ?? ""}`;
  if (/dolby ?vision|dovi/i.test(range)) out.push("Dolby Vision");
  else if (/hdr10\+/i.test(range)) out.push("HDR10+");
  else if (/hdr|pq|hlg/i.test(range)) out.push("HDR");
  if (a) out.push(/atmos/i.test(`${a.DisplayTitle} ${a.Profile}`) ? "Atmos" : `${(a.Codec ?? "").toUpperCase()}${a.Channels && a.Channels > 2 ? ` ${a.ChannelLayout ?? a.Channels + "ch"}` : ""}`);
  return out.filter(Boolean);
}

// ---------- playback ----------

export interface PlaybackPlan {
  uri: string;
  headers: Record<string, string>;
  mediaSourceId: string;
  playSessionId: string;
  externalSubtitles: { uri: string; name: string; language: string }[];
  sourcePath: string; // what the strm points at (OpenList link on 115), for finding sibling subtitle files
}

// Ask Emby for the source (direct play of everything: the player demuxes and decodes it all), then
// build the static stream URL that ge2o turns into a 115 CDN redirect.
export async function playbackPlan(itemId: string, startSeconds: number): Promise<PlaybackPlan> {
  const info = await emby<{ MediaSources: MediaSource[]; PlaySessionId: string }>(
    () => `/Items/${itemId}/PlaybackInfo?${qs({ UserId: uid(), StartTimeTicks: ticks(startSeconds), IsPlayback: true, AutoOpenLiveStream: true, MaxStreamingBitrate: 400_000_000 })}`,
    {
      body: {
        DeviceProfile: {
          MaxStreamingBitrate: 400_000_000,
          DirectPlayProfiles: [{ Type: "Video" }, { Type: "Audio" }],
          TranscodingProfiles: [],
          SubtitleProfiles: [{ Format: "srt", Method: "External" }, { Format: "ass", Method: "External" }, { Format: "ssa", Method: "External" }, { Format: "vtt", Method: "External" }, { Format: "pgssub", Method: "Embed" }, { Format: "subrip", Method: "Embed" }],
        },
      },
      timeoutMs: 30_000,
    },
  );
  const src = info.MediaSources?.[0];
  if (!src) throw new EmbyError("Emby 没有给出可播放的来源", 0);
  const a = account(); // after emby(): it may have just logged in
  const uri = `${a.server}/emby/Videos/${itemId}/stream?${qs({ static: true, MediaSourceId: src.Id, PlaySessionId: info.PlaySessionId, DeviceId: a.deviceId, api_key: a.token })}`;
  const externalSubtitles = (src.MediaStreams ?? [])
    .filter((s) => s.Type === "Subtitle" && s.IsExternal && s.DeliveryUrl)
    .map((s) => ({
      uri: s.DeliveryUrl!.startsWith("http") ? s.DeliveryUrl! : `${a.server}${s.DeliveryUrl!.startsWith("/emby") ? "" : "/emby"}${s.DeliveryUrl}${s.DeliveryUrl!.includes("api_key") ? "" : `${s.DeliveryUrl!.includes("?") ? "&" : "?"}api_key=${a.token}`}`,
      name: s.DisplayTitle ?? s.Title ?? s.Language ?? "外挂字幕",
      language: s.Language ?? "",
    }));
  return { uri, headers: { "User-Agent": PLAYER_UA }, mediaSourceId: src.Id, playSessionId: info.PlaySessionId, externalSubtitles, sourcePath: src.Path ?? "" };
}

// The player starts PlaybackInfo as soon as it has the item id, alongside the Items fetch, and takes
// the result once the item (resume position) is known. StartTimeTicks only matters for transcoding,
// which this client never asks for, so a plan fetched with start 0 is valid for any start position.
// Entries are single-use (a retry gets a fresh PlaySessionId) and expire after five minutes (the
// detail page warms one; ge2o's 115 link stays valid far longer).
const PLAN_TTL = 5 * 60_000;
const planCache = new Map<string, { at: number; plan: Promise<PlaybackPlan> }>();

export function prefetchPlan(itemId: string): Promise<PlaybackPlan> {
  const hit = planCache.get(itemId);
  if (hit && Date.now() - hit.at < PLAN_TTL) return hit.plan;
  const plan = playbackPlan(itemId, 0);
  plan.catch(() => planCache.delete(itemId));
  planCache.set(itemId, { at: Date.now(), plan });
  return plan;
}

export function takePlan(itemId: string, startSeconds: number): Promise<PlaybackPlan> {
  const hit = planCache.get(itemId);
  planCache.delete(itemId);
  return hit && Date.now() - hit.at < PLAN_TTL ? hit.plan : playbackPlan(itemId, startSeconds);
}

// Detail page → likely play target: get the plan and let the player fetch the file's first 8 MB
// now (runtime 4 prewarm; the 115 redirect, TLS and head reads are then paid before the tap).
// Wi-Fi only: it costs a 115 link and 8 MB per detail view.
const warmed = new Map<string, number>();
const warmBytes = new Map<string, number>();
// Bytes the detail page prewarmed for this item (0 when it didn't), for the play timeline.
export const prewarmedBytes = (itemId: string) => warmBytes.get(itemId) ?? 0;
export async function warmPlayback(itemId: string) {
  if ((warmed.get(itemId) ?? 0) > Date.now() - PLAN_TTL) return;
  warmed.set(itemId, Date.now());
  const caps = await nativeCaps();
  if (!caps?.prewarm) return;
  const net = await connection();
  if (net?.cellular) return;
  try {
    const t0 = Date.now();
    const plan = await prefetchPlan(itemId);
    const r = await device.prewarm(plan.uri, plan.headers);
    warmBytes.set(itemId, r?.bytes ?? 0);
    log.info("prewarm", { item: itemId, bytes: r?.bytes ?? 0, declined: r?.declined || undefined, ms: Date.now() - t0 });
  } catch (e) {
    log.warn("prewarm failed", { item: itemId, err: e instanceof Error ? e.message : e });
  }
}

export function report(kind: "start" | "progress" | "stopped", p: { itemId: string; plan: PlaybackPlan; position: number; paused?: boolean }) {
  const path = { start: "/Sessions/Playing", progress: "/Sessions/Playing/Progress", stopped: "/Sessions/Playing/Stopped" }[kind];
  return emby(path, {
    body: {
      ItemId: p.itemId, MediaSourceId: p.plan.mediaSourceId, PlaySessionId: p.plan.playSessionId, PositionTicks: ticks(p.position),
      IsPaused: !!p.paused, CanSeek: true, PlayMethod: "DirectPlay", EventName: kind === "progress" ? "timeupdate" : undefined,
    },
    timeoutMs: 10_000,
  }).catch((e) => log.warn("report failed", { kind, err: e instanceof Error ? e.message : e }));
}

// Episode after this one (same series, next index across seasons).
export async function nextEpisode(ep: Item): Promise<Item | null> {
  if (ep.Type !== "Episode" || !ep.SeriesId) return null;
  const all = (await embyApi.episodes(ep.SeriesId)).Items.filter((e) => (e.ParentIndexNumber ?? 0) > 0);
  const i = all.findIndex((e) => e.Id === ep.Id);
  return i >= 0 && i + 1 < all.length ? all[i + 1] : null;
}
