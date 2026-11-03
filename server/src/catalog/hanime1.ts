// Hanime1.me: a 里番 index (mostly Chinese-subtitled) and an online source. Lists are its genre / keyword
// searches (40 cards a page, sorts 本週排行 / 最新上市 …); a watch page has the Chinese and Japanese titles,
// the plot, tags (each a keyword search), views, date, studio, the series' episodes and plain <source> MP4
// links (480/720/1080, time-limited `secure` token, not tied to an IP — the phone plays them directly).
//
// The site refuses datacenter addresses (Cloudflare block page), so it needs an exit set for the source
// `hanime1` in SOURCE_PROXY (egress.ts); without one the index is not offered. Its stream plays its own works and,
// matched by Japanese title and episode, hanime works (hanime.tv's own stream needs a signed session).
import { proxyOf } from "../egress.ts";
import { decode, proxied, text, UA } from "./http.ts";
import type { CatalogDetail, CatalogItem, CatalogProvider, HomeRow, ListQuery, Page, ResolvedStream, StreamProvider, StreamSource } from "./types.ts";

const BASE = "https://hanime1.me";
export const hanime1Enabled = () => !!proxyOf("hanime1");

const SORT: Record<string, string> = {
  week: "本週排行", day: "本日排行", month: "本月排行", new: "最新上市", upload: "最新上傳", views: "觀看次數", likes: "讚好比例",
};

// The same request a plain HTTP client sends to the site (headers and user agent), which it serves.
const HEADERS = {
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "zh-TW,zh;q=0.9,en;q=0.8,ja;q=0.7",
  referer: `${BASE}/`,
};
const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}_]+/gu, "");

/** Episode number in a title: "＃6", "#6", or a trailing number (before a [tag]); none = 1. */
function epOf(t: string): number {
  const m = /[#＃]\s*(\d{1,3})/.exec(t) ?? /(\d{1,3})\s*(?:\[[^\]]*\]\s*)*$/.exec(t.trim());
  return m ? Number(m[1]) : 1;
}

const page = (path: string) => proxied(`${BASE}${path}`, "", "hanime1", HEADERS);

// Cards: genre lists use portrait covers ("home-rows-videos-div"), keyword searches landscape thumbnails.
export function cards(html: string): CatalogItem[] {
  const out: CatalogItem[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/href="https:\/\/hanime1\.me\/watch\?v=(\d+)"[^>]*>([\s\S]{0,1600}?)<\/a>/g)) {
    const id = m[1];
    const h = m[2];
    if (seen.has(id)) continue;
    const img = /<img[^>]*src="(https:\/\/vdownload\.hembed\.com\/image\/(cover|thumbnail)\/[^"]+)"/.exec(h);
    const title = text(/class="home-rows-videos-title"[^>]*>([\s\S]*?)<\/div>/.exec(h)?.[1] ?? /<div class="title">([\s\S]*?)<\/div>/.exec(h)?.[1] ?? "");
    if (!img || !title) continue;
    seen.add(id);
    const likes = /thumb_up<\/i>\s*(\d+)%/.exec(h)?.[1];
    out.push({
      id, title, poster: decode(img[1]),
      ...(img[2] === "thumbnail" ? { posterAspect: 16 / 9 } : {}),
      rating: likes ? Math.round(Number(likes)) / 10 : null,
      date: null, tags: [],
    });
  }
  return out;
}

// Tag name → its search link from the watch pages ("/search?tags[]=後宮&genre=裏番", "/search?query=…").
const tagLinks = new Map<string, string>();

async function list(q: ListQuery): Promise<Page<CatalogItem>> {
  const link = q.tag ? tagLinks.get(q.tag) : undefined;
  const params = new URLSearchParams(link ? link.split("?")[1] : "");
  // A tag not seen on a watch page yet is searched as a keyword (that is what the site's own keyword tags are).
  if (!link && (q.q || q.tag)) params.set("query", q.q ?? q.tag!);
  else if (!link) params.set("genre", "裏番");
  params.set("sort", SORT[q.sort] ?? SORT.week);
  if (q.page > 1) params.set("page", String(q.page));
  const html = await page(`/search?${params}`);
  return { items: cards(html), total: 0, page: q.page, hasMore: /rel="next"/.test(html) };
}

interface Watch { detail: CatalogDetail; sources: { uri: string; size: number }[] }

async function watch(id: string): Promise<Watch | null> {
  const html = await page(`/watch?v=${encodeURIComponent(id)}`);
  return html ? parseWatch(html, id) : null;
}

export function parseWatch(html: string, id: string): Watch {
  const jp = text(/<h3 id="shareBtn-title"[^>]*>([\s\S]*?)<\/h3>/.exec(html)?.[1] ?? "");
  const caption = /<div class="video-caption-text[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(html);
  const cn = text(html.slice(Math.max(0, (caption?.index ?? 0) - 400), caption?.index ?? 0).match(/>([^<>]{2,80})<\/div>\s*$/)?.[1] ?? "") || jp;
  const thumb = decode(/<meta property="og:image" content="([^"]+)"/.exec(html)?.[1] ?? "");
  const meta = /觀看次數：([^&<]+)&nbsp;&nbsp;(\d{4}-\d{2}-\d{2})/.exec(html);
  const studio = text(/<img[^>]*class="[^"]*video-user-avatar[^"]*"[^>]*alt="([^"]*)"/.exec(html)?.[1] ?? /alt="([^"]+)">\s*<img style="position: absolute/.exec(html)?.[1] ?? "");
  // Tags: keyword ones (artist, circle: ?query=…) and genre ones (?tags[]=…&genre=裏番, with a count).
  const tags = [...html.matchAll(/<div class="single-video-tag"[^>]*><a[^>]*href="(\/search\?[^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => {
    const name = text(m[2]).replace(/^#\s*/, "").replace(/\s*\(\d+\)$/, "").trim();
    if (name) tagLinks.set(name, decode(m[1]));
    return name;
  }).filter((t, i, a) => t && a.indexOf(t) === i);
  const pl = html.indexOf("playlist-scroll");
  const episodes: CatalogItem[] = pl < 0 ? [] : [...html.slice(pl).matchAll(/data-href="https:\/\/hanime1\.me\/watch\?v=(\d+)"[\s\S]*?<img class="main-thumb" src="([^"]+)"[\s\S]*?<h4 class="video-title">\s*<a[^>]*>([\s\S]*?)<\/a>/g)]
    .map((m) => ({ id: m[1], title: text(m[3]), poster: decode(m[2]), posterAspect: 16 / 9, rating: null, date: null, tags: [] }))
    .filter((e, i, a) => a.findIndex((x) => x.id === e.id) === i);   // the page has a desktop and a mobile playlist
  const sources = [...html.matchAll(/<source\b([^>]*)>/g)].map((m) => {
    const attr = (k: string) => new RegExp(`${k}="([^"]*)"`).exec(m[1])?.[1] ?? "";
    return { uri: decode(attr("src")), size: Number(attr("size")) || 0 };
  }).filter((s) => /^https:\/\//.test(s.uri) && /\.mp4/.test(s.uri));
  const best = Math.max(0, ...sources.map((s) => s.size));
  return {
    sources,
    detail: {
      id, title: cn, originalTitle: jp !== cn ? jp : undefined,
      poster: `https://vdownload.hembed.com/image/cover/${id}.jpg`, landscape: thumb || null,
      rating: null, date: meta?.[2] ?? null, tags,
      overview: text(caption?.[1] ?? ""),
      facts: [{ label: "厂牌", value: studio }, { label: "上架", value: meta?.[2] ?? "" }, { label: "播放", value: meta?.[1]?.trim() ?? "" }, { label: "画质", value: best ? `${best}p` : "" }].filter((f) => f.value),
      episodes, keyword: jp || cn, refs: { hanime1: id }, sourceUrl: `${BASE}/watch?v=${id}`, sourceName: "Hanime1",
    },
  };
}

export const hanime1: CatalogProvider = {
  id: "hanime1",
  name: "Hanime1",
  kind: "hentai",
  note: "hanime1.me 里番（多为中文字幕；需在 SOURCE_PROXY 给 hanime1 配出口）",
  sorts: [{ id: "week", label: "本周排行" }, { id: "new", label: "最新上市" }, { id: "day", label: "今日排行" }, { id: "month", label: "本月排行" }, { id: "views", label: "播放最多" }, { id: "likes", label: "好评率" }, { id: "upload", label: "最新上传" }],
  tagFilter: true,          // a tag is a keyword search on the site
  async home(): Promise<HomeRow[]> {
    const rows = [["week", "本周排行"], ["new", "最新上市"], ["likes", "好评率最高"]] as const;
    const got = await Promise.all(rows.map(([sort]) => list({ sort, page: 1, size: 40 }).catch(() => null)));
    return rows.map(([sort, title], i) => ({ id: sort, title, query: { sort }, items: got[i]?.items.slice(0, 20) ?? [] }));
  },
  list,
  async item(id: string) {
    if (!/^\d{1,9}$/.test(id)) return null;
    return (await watch(id))?.detail ?? null;
  },
  async tags() {
    return [];
  },
};

export const hanime1Streams: StreamProvider = {
  id: "hanime1",
  name: "Hanime1",
  kinds: ["hentai"],
  slow: true,
  async find(item: CatalogDetail): Promise<StreamSource[]> {
    const own = item.refs?.hanime1;
    const one = (id: string, w: Watch): StreamSource => {
      const best = Math.max(0, ...w.sources.map((s) => s.size));
      const zh = /中文字幕|中字/.test(w.detail.originalTitle ?? w.detail.title);
      return { provider: "hanime1", label: "Hanime1 在线", note: [zh ? "中文字幕" : "", best ? `${best}p MP4` : "MP4"].filter(Boolean).join(" · "), ref: id };
    };
    if (own) {
      const w = await watch(own).catch(() => null);
      return w?.sources.length ? [one(own, w)] : [];
    }
    // A hanime (hanime.tv) work: its own stream needs a signed session, so Hanime1 is how it plays — search by the
    // Japanese title and confirm the episode on each candidate's watch page; Chinese-subtitled ones first.
    const jp = (item.originalTitle ?? "").trim();
    if (!jp) return [];
    const m = /^(.*?)[\s　]*(\d{1,3})$/.exec(jp);
    const base = (m ? m[1] : jp).trim();
    const ep = m ? Number(m[2]) : 1;
    if (norm(base).length < 2) return [];
    const cands = (await list({ q: base, sort: "views", page: 1, size: 40 })).items.filter((c) => epOf(c.title) === ep).slice(0, 4);
    const found = await Promise.all(cands.map(async (c) => {
      const w = await watch(c.id).catch(() => null);
      const jt = w?.detail.originalTitle ?? w?.detail.title ?? "";
      return w?.sources.length && norm(jt).includes(norm(base)) && epOf(jt) === ep ? one(c.id, w) : null;
    }));
    return found.filter((x): x is StreamSource => !!x).sort((a, b) => Number(b.note?.startsWith("中文字幕")) - Number(a.note?.startsWith("中文字幕")));
  },
  // The MP4 link expires: read the watch page again (5-min cache) right before playing.
  async resolve(ref: string): Promise<ResolvedStream> {
    if (!/^\d{1,9}$/.test(ref)) throw new Error("播放源参数不对");
    const w = await watch(ref);
    const best = w?.sources.sort((a, b) => b.size - a.size)[0];
    if (!best) throw new Error("Hanime1 页面里没有播放地址");
    return { uri: best.uri, headers: { Referer: `${BASE}/`, "User-Agent": UA }, title: w!.detail.originalTitle ?? w!.detail.title, poster: w!.detail.landscape ?? null };
  },
};
