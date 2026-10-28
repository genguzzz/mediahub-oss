// Backend client (mediahub backend → MoviePilot + Prowlarr115 plugin). Every call carries
// the app token and a request id that the server logs (`journalctl -u mediahub | grep <rid>`).
import * as Application from "expo-application";
import { getSettings } from "./settings";
import { logger } from "./log";
import { runningLabel } from "./updates";

const log = logger("api");
export const appVersion = `${Application.nativeApplicationVersion ?? "dev"} (${Application.nativeBuildVersion ?? "0"}) ${runningLabel()}`;

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function rid() {
  return Math.random().toString(36).slice(2, 10);
}

export async function api<T>(path: string, opts: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
  const { server, token } = getSettings();
  if (!token) throw new ApiError("还没有设置访问令牌，请在设置里填写", 0);
  const id = rid();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30_000);
  const t0 = Date.now();
  try {
    const res = await fetch(server + path, {
      method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
      headers: {
        authorization: `Bearer ${token}`,
        "x-request-id": id,
        "x-app-version": appVersion,
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    log.info("call", { path: path.split("?")[0], status: res.status, ms: Date.now() - t0, rid: id });
    if (!res.ok) {
      const msg = (data && typeof data === "object" && "error" in data ? String((data as { error: unknown }).error) : "") || `服务器返回 ${res.status}`;
      throw new ApiError(res.status === 401 ? "访问令牌不正确" : msg, res.status);
    }
    return data as T;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    const aborted = (e as { name?: string }).name === "AbortError";
    log.warn("call failed", { path: path.split("?")[0], rid: id, aborted, err: e });
    throw new ApiError(aborted ? "请求超时" : "无法连接服务器", 0);
  } finally {
    clearTimeout(timer);
  }
}

// expo-image source for backend image routes ("/v1/img/...").
export function img(path: string | null | undefined) {
  if (!path) return undefined;
  if (/^https?:\/\//.test(path)) return { uri: path };
  const { server, token } = getSettings();
  return { uri: server + path, headers: { authorization: `Bearer ${token}` } };
}

export function embyImg(ref: { id: string; tag?: string } | null | undefined, w = 400, type = "Primary") {
  if (!ref) return undefined;
  return img(`/v1/img/emby/${ref.id}?type=${type}&w=${w}${ref.tag ? `&tag=${ref.tag}` : ""}`);
}

// ---------- types ----------

export type Kind = "movie" | "tv";

export interface LibHit { id: string; name: string; lib: string }

export interface MediaBrief {
  type: Kind;
  tmdbid: number | null;
  title: string;
  year: string;
  originalTitle: string;
  poster: string | null;
  backdrop: string | null;
  overview: string;
  vote: number;
  library?: LibHit | null;
}

export interface Subscription {
  id: number;
  title: string;
  year: string;
  type: Kind;
  season: number | null;
  tmdbid: number | null;
  source: string;
  poster: string | null;
  state: string;
  total: number | null;
  lack: number | null;
  start: number | null;
  lastSearch: string | null;
  lastUpdate: string | null;
  by: string;
}

export interface MediaDetail {
  media: MediaBrief & { genres: string[]; status: string; seasons: number | null; episodes: number | null; date: string; lastAir: string; country: string[]; names?: SearchName[] };
  seasons: { season: number; name: string; episodes: number; airDate: string; poster: string | null }[];
  library: { ok: boolean; found: boolean; id?: string; name?: string; path?: string; lib?: string; added?: string; seasons?: Record<string, number[]>; numbering?: "tvdb" | "tmdb" } | null;
  subscriptions: Subscription[];
}

// A search keyword for a work, in the order the backend recommends (see searchNames on the server).
export interface SearchName { text: string; lang: "zh" | "ja" | "romaji" | "en" | "ko" | "original" }
export const LANG_LABEL: Record<SearchName["lang"], string> = { zh: "中文", ja: "日文", romaji: "罗马音", en: "英文", ko: "韩文", original: "原名" };

// A search source with metadata from Prowlarr (language, content tags, description) or the plugin.
export interface Source {
  id: string;
  name: string;
  kind: "direct" | "adult" | "prowlarr";
  enabled: boolean;
  note: string;
  lang?: string;
  langName?: string;
  privacy?: string;
  privacyName?: string;
  tags?: string[];
  desc?: string;
  url?: string;
  definition?: string;
  pid?: number;              // Prowlarr indexer id
  prowlarrEnabled?: boolean;
  excluded?: boolean;        // excluded in the plugin config
  downTill?: string;         // Prowlarr paused it after failures until this time
}

// One indexer definition Prowlarr can add (Settings → 索引源 → 添加).
export interface CatalogItem {
  name: string;
  definition: string;
  addedId: number | null;
  addable: boolean;
  lang: string;
  langName: string;
  privacy: string;
  privacyName: string;
  tags: string[];
  desc: string;
  url: string;
}

export interface Resource {
  id: string;
  title: string;
  size: number;
  seeders: number;
  peers: number;
  magnet: string;
  source: string;
  kind: "prowlarr" | "direct" | "adult";
  indexer: string;
  pubdate: string;
  page: string;
  group: string;
  res: string;
  codec: string;
  rtype: string;
  effect: string;
  season: number | null;
  episodes: number[];
  se: string;
  score: number | null;
  why: string[];
  excluded: string | null;
  recommended: boolean;
  have: number;
  tags: string[];
}

export interface SearchResult {
  ok: boolean;
  error?: string | null;
  elapsed: number;
  mode: "smart" | "raw";
  season: number | null;
  media: { tmdbid: number; title: string; year: string; type: Kind } | null;
  library: { have: number[]; aired: number[] } | null;
  groups: [string, number][];
  sources: [string, number][];
  results: Resource[];
}

export interface Step {
  key: string;
  label: string;
  state: "done" | "active" | "pending" | "error" | "skipped";
  start?: number | null;   // epoch seconds
  end?: number | null;
  events?: number;         // log lines recorded for this step
  last?: string;           // latest log line
  warn?: boolean;          // any warning/error line
}

export interface TaskEvent { at: number; step: string; group: string; level: "info" | "warn" | "error" | "notice"; msg: string }

export interface Task {
  hash: string;
  kind: "media";
  status: string;
  stage: string;
  steps: Step[];
  failed: boolean;
  dir: string;
  name: string;
  added: number;
  done?: number;
  emby?: number | null;
  percent?: number | null;
  strm: number;
  title: string;
  year?: string;
  tmdbid?: number;
  season?: number;
  type: Kind;
  size?: number;
  rate?: number;
  eta?: number;
  peers?: number;
  buffer?: { reason: string; since: number; uploaded: number; uploading: string[] };
}

// key: identifier for /v1/av/cancel; step: offline (115) | scrape (strm written, MDC) | done.
export interface AdultRow { kind: "av"; key?: string; step?: "offline" | "scrape" | "done"; strm?: string; code: string; stage: string; at: number; hash?: string; percent?: number | null; name: string; failed: boolean; done?: boolean; error?: string }

export interface Pipeline { ok: boolean; tasks: Task[]; adult: AdultRow[]; ts: number }

export interface Overview {
  pipeline: { downloading: number; waiting: number; failed: number; av: number } | null;
  qb: { active: number; dl: number; up: number } | null;
  emby: { running: { name: string; progress: number | null }[] } | null;
  subscriptions: number | null;
  errors: string[];
}

export interface OfflineTask { hash: string; name: string; size: number; percent: number; status: number; rate: number; peers: number; added: number; updated: number; dir: string | null; ours: boolean }

export interface QbTorrent {
  hash: string; name: string; size: number; total_size: number; progress: number; dlspeed: number; upspeed: number; eta: number; state: string;
  category: string; added_on: number; completion_on: number; num_seeds: number; num_leechs: number; ratio: number; save_path: string; tags: string;
}

export interface OlTask { id: string; name: string; state: number; status: string; progress: number; error: string; total: number; start: string; end: string }
export type OpenListTasks = { ok: boolean } & Record<"copy" | "upload" | "offline_download" | "offline_download_transfer", { undone: OlTask[]; done: OlTask[] }>;

export interface EmbyBrief {
  id: string; name: string; type: string; year: number | null; series: string | null; seriesId: string | null; season: number | null; episode: number | null;
  image: { id: string; tag: string } | null; tmdbid: string | null; added: string | null; count: number | null; scraped: boolean;
}

export interface EmbyDetail {
  item: EmbyBrief & { overview: string; genres: string[]; rating: number | null; status: string; path: string; providers: Record<string, string>; backdrop: { id: string; tag: string } | null };
  seasons: { season: number; episodes: EmbyBrief[] }[];
}

export interface EmbyActivity {
  running: { id: string; name: string; category: string; progress: number | null; state: string }[];
  library_tasks: { id: string; name: string; status: string; end: string }[];
  log: { name: string; type: string; date: string; severity: string; overview: string | null }[];
}

export interface HistoryItem { id: number; title: string; year: string; type: Kind; se: string; poster: string | null; torrent: string; site: string; date: string; by: string; hash: string; path: string; source: string; sourceId: string; tmdbid: number | null }

export interface IngestResult { ok: boolean; hash?: string; dir?: string; error?: string | null; dry_run?: boolean; meta?: Record<string, unknown>; warnings?: string[] }

export const pipelineQuery = () => api<Pipeline>("/v1/pipeline?limit=80", { timeoutMs: 45_000 });
