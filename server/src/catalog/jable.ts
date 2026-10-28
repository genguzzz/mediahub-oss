// Jable.TV: hot lists (today / week / month / all time), latest uploads, the actress index and
// per-actress lists, search; and an online stream source: a 番号 maps to /videos/<code>/ (or
// <code>-c with Chinese subtitles), whose page carries a time-limited HLS URL (AES-128, CDN open,
// played by the phone directly). Pages load through FlareSolverr (Cloudflare challenge), using
// KVS's async blocks so a page of a list is one small request.
import { chunks, decode, flare, img, num, text, UA } from "./http.ts";
import { avIntro } from "./intro.ts";
import type { CatalogDetail, CatalogItem, CatalogProvider, HomeRow, ListQuery, Page, Person, ResolvedStream, StreamProvider, StreamSource } from "./types.ts";

const BASE = "https://jable.tv";
const CODE = /^([A-Z0-9]{2,10}-\d{2,6}[A-Z]?)\s*/i;
// Only titles that explicitly describe minors are dropped (owner's call: no other filtering).
export const REJECT = /ロリ|ショタ|幼女|幼[児少稚齢]|小学|中学|JS|JC|未成年|女子校生|女子[●〇]生/i;

const block = (path: string, id: string, params: Record<string, string | number>) =>
  `${BASE}${path}?${new URLSearchParams({ mode: "async", function: "get_block", block_id: id, ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])), lang: "jp" })}`;

function card(h: string): CatalogItem | null {
  const slug = /href="https:\/\/jable\.tv\/videos\/([^/"]+)\/"/.exec(h)?.[1];
  if (!slug) return null;
  const full = decode(/<h6 class="title"><a[^>]*>([^<]*)<\/a>/.exec(h)?.[1] ?? "").trim();
  if (REJECT.test(full)) return null;
  const m = CODE.exec(full);
  const sub = /<p class="sub-title">([\s\S]*?)<\/p>/.exec(h)?.[1] ?? "";
  const nums = sub.split(/<svg/).slice(1).map((part) => num(text(`<svg${part}`)));
  return {
    id: slug, code: (m?.[1] ?? slug.replace(/-c$/, "")).toUpperCase(), title: m ? full.slice(m[0].length) : full,
    poster: img(/data-src="([^"]+)"/.exec(h)?.[1]),
    rating: null, views: nums[0] || undefined, votes: nums[1] || undefined,
    date: null, subtitle: /<span class="label">([^<]+)<\/span>/.exec(h)?.[1],
    tags: slug.endsWith("-c") ? ["中文字幕"] : [],
  };
}

function page(html: string, n: number, size = 24): Page<CatalogItem> {
  const raw = chunks(html, /<div class="video-img-box/);
  const items = raw.map(card).filter((x): x is CatalogItem => !!x);
  return { items, total: 0, page: n, hasMore: raw.length >= size };
}

const HOT: Record<string, string> = { week: "video_viewed_week", today: "video_viewed_today", month: "video_viewed_month", all: "video_viewed" };
const PERSON_SORT: Record<string, string> = { released: "post_date", views: "video_viewed", favs: "most_favourited" };

async function list(q: ListQuery): Promise<Page<CatalogItem>> {
  let url: string;
  if (q.person) url = block(`/models/${encodeURIComponent(q.person)}/`, "list_videos_common_videos_list", { sort_by: PERSON_SORT[q.sort] ?? "post_date", from: q.page });
  else if (q.q) url = block(`/search/${encodeURIComponent(q.q)}/`, "list_videos_videos_list_search_result", { q: q.q, sort_by: "post_date_and_popularity", from_videos: q.page, from: q.page });
  else if (q.sort === "latest") url = block("/latest-updates/", "list_videos_latest_videos_list", { sort_by: "post_date", from: q.page });
  else url = block("/hot/", "list_videos_common_videos_list", { sort_by: HOT[q.sort] ?? HOT.week, from: q.page });
  return page(await flare(url, q.sort === "latest" || q.sort === "today" ? 20 * 60_000 : 60 * 60_000), q.page);
}

interface VideoPage { title: string; code: string; cover: string | null; hls: string | null; people: { id: string; name: string }[]; tags: string[]; views: number; note: string }

async function video(slug: string, ttlMs = 15 * 60_000): Promise<VideoPage | null> {
  const html = await flare(`${BASE}/videos/${encodeURIComponent(slug)}/?lang=jp`, ttlMs);
  if (!html || /<title>404/.test(html)) return null;
  const og = (p: string) => decode(new RegExp(`<meta property="og:${p}" content="([^"]*)"`).exec(html)?.[1] ?? "");
  const full = og("title");
  const m = CODE.exec(full);
  const views = [...html.matchAll(/<span class="mr-3">([\d ]+)<\/span>/g)].map((x) => num(x[1]))[0] ?? 0;
  return {
    title: m ? full.slice(m[0].length) : full, code: (m?.[1] ?? slug.replace(/-c$/, "")).toUpperCase(), cover: og("image") || null,
    hls: /hlsUrl\s*=\s*'([^']+)'/.exec(html)?.[1] ?? null,
    people: [...html.matchAll(/<a class="model" href="https:\/\/jable\.tv\/models\/([^/"]+)\/">[\s\S]*?(?:data-original-title|title)="([^"]+)"/g)].map((x) => ({ id: x[1], name: decode(x[2]) })),
    tags: [...html.matchAll(/href="https:\/\/jable\.tv\/(?:tags|categories)\/[^/"]+\/"[^>]*>([^<]+)</g)].map((x) => decode(x[1]).trim()).filter(Boolean),
    views, note: og("description"),
  };
}

async function persons(sort: string, n: number): Promise<Page<Person>> {
  const by: Record<string, string> = { hot: "avg_videos_popularity", count: "total_videos", recent: "last_content_date", name: "title" };
  // "人气" is the site's own default order of /models/ (the avg-popularity sort favours one-hit names).
  const url = sort === "hot" || !by[sort] ? `${BASE}/models/${n > 1 ? `${n}/` : ""}?lang=jp` : block("/models/", "list_models_models_list", { sort_by: by[sort], from: n });
  const html = await flare(url, 6 * 3600_000);
  const raw = chunks(html, /<div class="horizontal-img-box/);
  const items = raw.map((h): Person | null => {
    const id = /href="https:\/\/jable\.tv\/models\/([^/"]+)\/"/.exec(h)?.[1];
    if (!id) return null;
    return { id, name: decode(/<h6 class="title">([^<]*)<\/h6>/.exec(h)?.[1] ?? "").trim(), count: num(/(\d+)\s*本映画/.exec(h)?.[1]) || null, latest: null, poster: img(/<img[^>]*src="([^"]+)"/.exec(h)?.[1]) };
  }).filter((x): x is Person => !!x);
  return { items, total: 0, page: n, hasMore: raw.length >= 20 };
}

export const jable: CatalogProvider = {
  id: "jable",
  name: "Jable",
  kind: "av",
  note: "Jable 热门与新片（可在线播放）",
  sorts: [{ id: "week", label: "本周热门" }, { id: "today", label: "今日热门" }, { id: "month", label: "本月热门" }, { id: "all", label: "总榜" }, { id: "latest", label: "最新上架" }],
  personSorts: [{ id: "released", label: "最新" }, { id: "views", label: "播放" }, { id: "favs", label: "收藏" }],
  personIndexSorts: [{ id: "hot", label: "人气" }, { id: "count", label: "作品数" }, { id: "recent", label: "最近更新" }, { id: "name", label: "名字" }],
  tagFilter: false,

  async home(): Promise<HomeRow[]> {
    const rows = [["week", "本周热门"], ["today", "今日热门"], ["latest", "最新上架"], ["month", "本月热门"]] as const;
    const got = await Promise.all(rows.map(([sort]) => list({ sort, page: 1, size: 24 }).catch(() => null)));
    return rows.map(([sort, title], i) => ({ id: sort, title, query: { sort }, items: got[i]?.items ?? [] }));
  },
  list,
  async item(id: string): Promise<CatalogDetail | null> {
    const v = await video(id);
    if (!v) return null;
    return {
      id, code: v.code, title: v.title, poster: img(v.cover), posterCrop: "right", landscape: img(v.cover),
      rating: null, views: v.views || undefined, date: null, tags: v.tags, people: v.people,
      overview: avIntro(v.title, { people: v.people.map((x) => x.name), tags: v.tags.filter((t) => t !== "中国語字幕") }),
      facts: [{ label: "番号", value: v.code }, { label: "播放", value: v.views ? v.views.toLocaleString("en-US") : "" }, { label: "字幕", value: id.endsWith("-c") ? "中文字幕" : "" }].filter((f) => f.value),
      episodes: [], keyword: v.code, refs: { jable: id },
    };
  },
  async tags() {
    return [];
  },
  persons,
};

export const jableStreams: StreamProvider = {
  id: "jable",
  name: "Jable",
  kinds: ["av"],
  slow: true,
  async find(item): Promise<StreamSource[]> {
    const code = (item.code ?? (CODE.test(item.keyword) ? item.keyword : "")).toLowerCase();
    const base = (item.refs?.jable ?? code).replace(/-c$/, "");
    const slugs = base ? [base, `${base}-c`] : [];
    const found = await Promise.all(slugs.map(async (slug) => ((await video(slug).catch(() => null))?.hls ? slug : null)));
    return found.filter((s): s is string => !!s)
      .sort((a, b) => Number(b.endsWith("-c")) - Number(a.endsWith("-c")))
      .map((slug) => ({ provider: "jable", label: "Jable 在线", note: slug.endsWith("-c") ? "中文字幕 · HLS" : "原版 · HLS", ref: slug }));
  },
  async resolve(ref: string): Promise<ResolvedStream> {
    if (!/^[\w-]{3,60}$/.test(ref)) throw new Error("播放源参数不对");
    const v = await video(ref);
    if (!v?.hls) throw new Error("Jable 页面里没有播放地址");
    return { uri: v.hls, headers: { Referer: `${BASE}/`, Origin: BASE, "User-Agent": UA }, title: `${v.code} ${v.title}`, poster: img(v.cover) };
  },
};
