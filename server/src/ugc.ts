// Video search on Bilibili and YouTube (UGC: talks, reviews, explainers, clips, trailers), for the assistant
// and the app. Bilibili: its web search API with a visitor cookie (buvid3), retried on its rate-limit
// codes. YouTube: the InnerTube search the youtube.com web client calls (its public web key), video
// results only. Creators: find the account (user / channel search) and list its latest uploads (Bilibili:
// newest search results kept to that UP 主's id; YouTube: the channel's uploads playlist). All go out per egress.ts (sources `bilibili` / `youtube`, direct unless SOURCE_PROXY sets one).
import { randomBytes } from "node:crypto";
import { fetch as ufetch } from "undici";
import { dispatcherFor } from "./egress.ts";
import { logger } from "./log.ts";

const log = logger("ugc");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export interface Video {
  site: "bilibili" | "youtube";
  id: string;            // BV id / YouTube video id
  title: string;
  author: string;
  cover: string | null;
  duration: string;      // "12:34", "" for live
  views: number | null;
  published: string;     // "2025-03-02" (bilibili) or "3 年前" (YouTube's own text)
  url: string;
}

const strip = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- Bilibili ----------

const cookie = `buvid3=${randomBytes(18).toString("hex")}infoc; b_nut=${Math.floor(Date.now() / 1000)}; _uuid=${randomBytes(16).toString("hex")}`;
const B_ORDER = { relevance: "", latest: "pubdate", views: "click", favorites: "stow", danmaku: "dm" } as const;
export type Sort = keyof typeof B_ORDER;

export async function bilibili(q: string, sort: Sort = "relevance", page = 1): Promise<Video[]> {
  const order = B_ORDER[sort] ? `&order=${B_ORDER[sort]}` : "";
  const url = `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(q)}&page=${page}${order}`;
  for (let attempt = 0; ; attempt++) {
    const r = await ufetch(url, { dispatcher: dispatcherFor("bilibili"), headers: { "user-agent": UA, referer: "https://www.bilibili.com/", cookie }, signal: AbortSignal.timeout(15_000) });
    const d = (await r.json().catch(() => ({}))) as { code?: number; message?: string; data?: { result?: Record<string, unknown>[] } };
    // -412 blocked, -509 too frequent, -1200 degraded: short back-off, then give up with the site's message
    if ((d.code === -412 || d.code === -509 || d.code === -1200) && attempt < 2) {
      await sleep(800 * (attempt + 1));
      continue;
    }
    if (d.code !== 0) throw new Error(`B站搜索失败：${d.message || d.code || r.status}`);
    return (d.data?.result ?? []).filter((x) => x.bvid).map((x) => {
      const pic = String(x.pic ?? "");
      return {
        site: "bilibili",
        id: String(x.bvid),
        title: strip(String(x.title ?? "")),
        author: String(x.author ?? ""),
        cover: pic ? (pic.startsWith("//") ? `https:${pic}` : pic.replace(/^http:/, "https:")) : null,
        duration: String(x.duration ?? "").replace(/^(\d+):(\d)$/, "$1:0$2"),
        views: typeof x.play === "number" ? x.play : Number(x.play) || null,
        published: x.pubdate ? new Date(Number(x.pubdate) * 1000).toISOString().slice(0, 10) : "",
        url: `https://www.bilibili.com/video/${x.bvid}`,
      };
    });
  }
}

// ---------- YouTube ----------

const YT_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8"; // the key youtube.com's own web client sends (public)
const YT_SORT: Partial<Record<Sort, string>> = { latest: "CAI%3D", views: "CAM%3D" };
type Runs = { runs?: { text?: string }[]; simpleText?: string };
const text = (t?: Runs) => t?.simpleText ?? (t?.runs ?? []).map((r) => r.text ?? "").join("");

function ytViews(t: string): number | null {
  const m = /([\d.,]+)\s*(万|亿|[KMB])?/i.exec(t.replace(/,/g, ""));
  if (!m) return null;
  const n = Number(m[1]);
  const mul = { 万: 1e4, 亿: 1e8, k: 1e3, m: 1e6, b: 1e9 }[(m[2] ?? "").toLowerCase() as "k"] ?? 1;
  return Number.isFinite(n) ? Math.round(n * mul) : null;
}

export async function youtube(q: string, sort: Sort = "relevance"): Promise<Video[]> {
  const params = YT_SORT[sort];
  const r = await ufetch(`https://www.youtube.com/youtubei/v1/search?key=${YT_KEY}&prettyPrint=false`, {
    method: "POST",
    dispatcher: dispatcherFor("youtube"),
    headers: { "content-type": "application/json", "user-agent": UA, "x-youtube-client-name": "1", "x-youtube-client-version": "2.20250101.00.00" },
    body: JSON.stringify({ context: { client: { clientName: "WEB", clientVersion: "2.20250101.00.00", hl: "zh-CN", gl: "US" } }, query: q, ...(params ? { params: decodeURIComponent(params) } : {}) }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`YouTube 搜索失败：HTTP ${r.status}`);
  const d = (await r.json()) as Record<string, any>;
  const sections = d?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents ?? [];
  const out: Video[] = [];
  for (const sec of sections) {
    for (const item of sec?.itemSectionRenderer?.contents ?? []) {
      const v = item?.videoRenderer;
      if (!v?.videoId) continue;
      const views = text(v.viewCountText) || text(v.shortViewCountText);
      out.push({
        site: "youtube",
        id: v.videoId,
        title: text(v.title),
        author: text(v.ownerText) || text(v.longBylineText),
        cover: `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`,
        duration: text(v.lengthText),
        views: views ? ytViews(views) : null,
        published: text(v.publishedTimeText),
        url: `https://www.youtube.com/watch?v=${v.videoId}`,
      });
    }
  }
  return out;
}

// ---------- creators: find the account, list its latest uploads ----------

export interface Creator {
  site: "bilibili" | "youtube"; id: string; name: string; followers: number | null; videos: number | null; avatar: string | null; sign: string; url: string;
  live?: LiveRoom | null;   // Bilibili: the UP 主's live room (live = on air now)
}
export interface LiveRoom { roomId: string; live: boolean; title: string; online: number | null; area: string; cover: string | null; uname: string; uid: string; since: string; url: string }

const https = (u: unknown) => {
  const s = String(u ?? "");
  return s ? (s.startsWith("//") ? `https:${s}` : s.replace(/^http:/, "https:")) : null;
};

/** Live rooms on Bilibili by keyword (streamer, game, topic): on-air rooms, most watched first. */
export async function bilibiliLiveSearch(q: string): Promise<LiveRoom[]> {
  const r = await ufetch(`https://api.bilibili.com/x/web-interface/search/type?search_type=live_room&keyword=${encodeURIComponent(q)}`, { dispatcher: dispatcherFor("bilibili"), headers: { "user-agent": UA, referer: "https://www.bilibili.com/", cookie }, signal: AbortSignal.timeout(15_000) });
  const d = (await r.json().catch(() => ({}))) as { code?: number; message?: string; data?: { result?: Record<string, unknown>[] } };
  if (d.code !== 0) throw new Error(`B站直播搜索失败：${d.message || d.code || r.status}`);
  return (d.data?.result ?? []).map((x) => ({
    roomId: String(x.roomid), live: Number(x.live_status) === 1, title: strip(String(x.title ?? "")), online: Number(x.online) || null,
    area: strip(String(x.cate_name ?? "")), cover: https(x.cover) ?? https(x.user_cover), uname: strip(String(x.uname ?? "")), uid: String(x.uid ?? ""),
    since: x.live_time ? String(x.live_time) : "", url: `https://live.bilibili.com/${x.roomid}`,
  })).sort((a, b) => Number(b.live) - Number(a.live) || (b.online ?? 0) - (a.online ?? 0));
}

/** Live state of UP 主 by uid (room, on air or not, title, viewers). */
export async function bilibiliLiveStatus(uids: string[]): Promise<Record<string, LiveRoom>> {
  if (!uids.length) return {};
  const r = await ufetch(`https://api.live.bilibili.com/room/v1/Room/get_status_info_by_uids?${uids.map((u) => `uids[]=${encodeURIComponent(u)}`).join("&")}`, { dispatcher: dispatcherFor("bilibili"), headers: { "user-agent": UA }, signal: AbortSignal.timeout(15_000) });
  const d = (await r.json().catch(() => ({}))) as { code?: number; message?: string; data?: Record<string, Record<string, unknown>> };
  if (d.code !== 0) throw new Error(`B站直播状态读取失败：${d.message || d.code || r.status}`);
  return Object.fromEntries(Object.entries(d.data ?? {}).map(([uid, v]) => [uid, {
    roomId: String(v.room_id), live: Number(v.live_status) === 1, title: strip(String(v.title ?? "")), online: Number(v.online) || null,
    area: String(v.area_v2_name ?? ""), cover: https(v.cover_from_user) ?? https(v.keyframe), uname: String(v.uname ?? ""), uid,
    since: Number(v.live_time) ? new Date(Number(v.live_time) * 1000).toISOString().slice(0, 16) : "", url: `https://live.bilibili.com/${v.room_id}`,
  }]));
}

export async function bilibiliUsers(q: string): Promise<Creator[]> {
  const r = await ufetch(`https://api.bilibili.com/x/web-interface/search/type?search_type=bili_user&keyword=${encodeURIComponent(q)}`, { dispatcher: dispatcherFor("bilibili"), headers: { "user-agent": UA, referer: "https://www.bilibili.com/", cookie }, signal: AbortSignal.timeout(15_000) });
  const d = (await r.json().catch(() => ({}))) as { code?: number; message?: string; data?: { result?: Record<string, unknown>[] } };
  if (d.code !== 0) throw new Error(`B站用户搜索失败：${d.message || d.code || r.status}`);
  return (d.data?.result ?? []).slice(0, 8).map((u) => ({
    site: "bilibili", id: String(u.mid), name: strip(String(u.uname ?? "")), followers: Number(u.fans) || null, videos: Number(u.videos) || null,
    avatar: https(u.upic), sign: strip(String(u.usign ?? "")).slice(0, 80), url: `https://space.bilibili.com/${u.mid}`,
    live: Number(u.room_id) ? { roomId: String(u.room_id), live: Number(u.is_live) === 1, title: "", online: null, area: "", cover: null, uname: strip(String(u.uname ?? "")), uid: String(u.mid), since: "", url: `https://live.bilibili.com/${u.room_id}` } : null,
  }));
}


/** An UP 主's recent uploads. Bilibili refuses its per-account listings (space videos, archives) to datacenter
 *  addresses, and the search API is the one that serves us: the newest-first pages and the most relevant pages
 *  for their name, kept to their own videos (mid), newest first. Recent uploads, not a complete feed. */
export async function bilibiliUploads(mid: string, name: string): Promise<Video[]> {
  const queries = [["pubdate", 1], ["pubdate", 2], ["pubdate", 3], ["", 1], ["", 2]] as const;
  const pages = await Promise.all(queries.map(async ([order, page]) => {
    const url = `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(name)}${order ? `&order=${order}` : ""}&page=${page}`;
    const r = await ufetch(url, { dispatcher: dispatcherFor("bilibili"), headers: { "user-agent": UA, referer: "https://www.bilibili.com/", cookie }, signal: AbortSignal.timeout(15_000) });
    const d = (await r.json().catch(() => ({}))) as { code?: number; message?: string; data?: { result?: Record<string, unknown>[] } };
    if (d.code !== 0) {
      log.warn({ mid, order, page, code: d.code }, "bilibili uploads page failed");
      return [];
    }
    return (d.data?.result ?? []).filter((x) => String(x.mid) === mid && x.bvid);
  }));
  const seen = new Set<string>();
  return pages.flat().filter((x) => (seen.has(String(x.bvid)) ? false : (seen.add(String(x.bvid)), true))).map((x) => {
    const pic = String(x.pic ?? "");
    return {
      site: "bilibili" as const, id: String(x.bvid), title: strip(String(x.title ?? "")), author: String(x.author ?? ""),
      cover: pic ? (pic.startsWith("//") ? `https:${pic}` : pic.replace(/^http:/, "https:")) : null,
      duration: String(x.duration ?? ""), views: Number(x.play) || null,
      published: x.pubdate ? new Date(Number(x.pubdate) * 1000).toISOString().slice(0, 10) : "", url: `https://www.bilibili.com/video/${x.bvid}`,
    };
  }).sort((p, q) => q.published.localeCompare(p.published)).slice(0, 20);
}

export async function youtubeChannels(q: string): Promise<Creator[]> {
  const r = await ufetch(`https://www.youtube.com/youtubei/v1/search?key=${YT_KEY}&prettyPrint=false`, {
    method: "POST", dispatcher: dispatcherFor("youtube"),
    headers: { "content-type": "application/json", "user-agent": UA, "x-youtube-client-name": "1", "x-youtube-client-version": "2.20250101.00.00" },
    body: JSON.stringify({ context: { client: { clientName: "WEB", clientVersion: "2.20250101.00.00", hl: "zh-CN", gl: "US" } }, query: q, params: "EgIQAg==" }), // filter: channels
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`YouTube 频道搜索失败：HTTP ${r.status}`);
  const d = (await r.json()) as Record<string, any>;
  const out: Creator[] = [];
  for (const sec of d?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents ?? []) {
    for (const item of sec?.itemSectionRenderer?.contents ?? []) {
      const c = item?.channelRenderer;
      if (!c?.channelId) continue;
      // YouTube puts the @handle in subscriberCountText and the subscriber count in videoCountText on new layouts
      const a = text(c.subscriberCountText), b = text(c.videoCountText);
      const subs = /订阅|subscriber/i.test(b) ? b : a;
      out.push({ site: "youtube", id: c.channelId, name: text(c.title), followers: ytViews(subs), videos: null, avatar: c.thumbnail?.thumbnails?.at(-1)?.url ? String(c.thumbnail.thumbnails.at(-1).url).replace(/^\/\//, "https://") : null, sign: text(c.descriptionSnippet).slice(0, 80), url: `https://www.youtube.com/channel/${c.channelId}` });
    }
  }
  return out.slice(0, 8);
}

/** A channel's latest uploads: its uploads playlist (UU…) through the same InnerTube interface as search. */
export async function youtubeUploads(channelId: string): Promise<Video[]> {
  if (!/^UC[\w-]{22}$/.test(channelId)) throw new Error("YouTube 频道 id 不对");
  const r = await ufetch(`https://www.youtube.com/youtubei/v1/browse?key=${YT_KEY}&prettyPrint=false`, {
    method: "POST", dispatcher: dispatcherFor("youtube"),
    headers: { "content-type": "application/json", "user-agent": UA, "x-youtube-client-name": "1", "x-youtube-client-version": "2.20250101.00.00" },
    body: JSON.stringify({ context: { client: { clientName: "WEB", clientVersion: "2.20250101.00.00", hl: "zh-CN", gl: "US" } }, browseId: `VLUU${channelId.slice(2)}` }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`YouTube 频道视频读取失败：HTTP ${r.status}`);
  const d = (await r.json()) as Record<string, any>;
  const author = text(d?.header?.pageHeaderRenderer?.pageTitle ? { simpleText: d.header.pageHeaderRenderer.pageTitle } : d?.metadata?.playlistMetadataRenderer?.title ? { simpleText: d.metadata.playlistMetadataRenderer.title } : undefined).replace(/^Uploads from /, "").replace(/^来自[“"](.+)[”"]的上传内容$/, "$1");
  const out: Video[] = [];
  const walk = (o: any) => {
    if (!o || typeof o !== "object") return;
    const l = o.lockupViewModel;
    if (l?.contentId && /VIDEO/.test(l.contentType ?? "VIDEO")) {
      // new layout: title in lockupMetadataViewModel, "12万次观看 · 3天前" in its metadata rows, duration as a badge
      const md = l.metadata?.lockupMetadataViewModel;
      const parts: string[] = [];
      const collect = (x: any) => {
        if (!x || typeof x !== "object") return;
        if (typeof x.content === "string") parts.push(x.content);
        for (const k in x) if (k !== "content") collect(x[k]);
      };
      collect(md?.metadata);
      const badge = /"text":"(\d{1,2}(?::\d{2}){1,2})"/.exec(JSON.stringify(l.contentImage ?? {}))?.[1] ?? "";
      const views = parts.find((p) => /观看|view/i.test(p)) ?? "";
      const when = parts.find((p) => /前|ago|天|小时|月|年/.test(p) && p !== views) ?? "";
      out.push({
        site: "youtube", id: l.contentId, title: md?.title?.content ?? "", author: author.replace(/^来自[“"](.+)[”"]的上传内容$/, "$1"),
        cover: `https://i.ytimg.com/vi/${l.contentId}/mqdefault.jpg`, duration: badge, views: views ? ytViews(views) : null, published: when,
        url: `https://www.youtube.com/watch?v=${l.contentId}`,
      });
      return;
    }
    const v = o.playlistVideoRenderer;
    if (v?.videoId) {
      const info = (v.videoInfo?.runs ?? []).map((x: { text?: string }) => x.text ?? "").join("");   // "12万次观看 • 3天前"
      const [views, when] = info.split(/\s*•\s*/);
      out.push({
        site: "youtube", id: v.videoId, title: text(v.title), author: text(v.shortBylineText) || author,
        cover: `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`, duration: text(v.lengthText), views: views ? ytViews(views) : null, published: when ?? "",
        url: `https://www.youtube.com/watch?v=${v.videoId}`,
      });
      return;
    }
    for (const k in o) walk(o[k]);
  };
  walk(d?.contents);
  return out.slice(0, 30);
}

export async function searchVideos(site: "bilibili" | "youtube", q: string, sort: Sort = "relevance"): Promise<Video[]> {
  const t0 = Date.now();
  try {
    const list = site === "bilibili" ? await bilibili(q, sort) : await youtube(q, sort);
    log.info({ site, n: list.length, ms: Date.now() - t0 }, "video search");
    return list;
  } catch (e) {
    log.warn({ site, ms: Date.now() - t0, err: e instanceof Error ? e.message : String(e) }, "video search failed");
    throw Object.assign(e instanceof Error ? e : new Error(String(e)), { statusCode: 502 });
  }
}
