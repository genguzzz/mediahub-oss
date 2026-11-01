// Video search on Bilibili and YouTube (UGC: talks, reviews, explainers, clips, trailers), for the assistant
// and the app. Bilibili: its web search API with a visitor cookie (buvid3), retried on its rate-limit
// codes. YouTube: the InnerTube search the youtube.com web client calls (its public web key), video
// results only. Both go out per egress.ts (sources `bilibili` / `youtube`, direct unless SOURCE_PROXY sets one).
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
