// 里番 index from hanime.tv's public search database: the site's search runs in the browser over one
// JSON file listing every release (~3.5k) with likes, dislikes, views, release and upload dates,
// brand and tags. We download it every 6 h and sort / filter locally. Streams on hanime need a
// signed session, so this provider is index-only; watching goes through the stream providers.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.ts";
import { extImage } from "../images.ts";
import type { CatalogDetail, CatalogItem, CatalogProvider, HomeRow, ListQuery, Page } from "./types.ts";

const DB_URL = "https://guest.freeanimehentai.net/api/v11/search_hvs";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36";
const REFRESH_MS = 6 * 3600_000;
const FILE = path.join(config.cacheDir, "catalog", "hanime.json");
// Minor-coded settings stay hidden (the only filter; see REJECT in jable.ts).
const HIDDEN_TAGS = new Set(["school girl", "2000-year-old dragon girl"]);

const TAG_ZH: Record<string, string> = {
  "blow job": "口交", hd: "高清", "big boobs": "巨乳", censored: "有码", creampie: "中出", plot: "剧情", uncensored: "无码", facial: "颜射",
  anal: "肛交", harem: "后宫", bondage: "捆绑", "boob job": "乳交", virgin: "处女", toys: "道具", fantasy: "奇幻", gangbang: "群交",
  "hand job": "手交", "public sex": "野外", yuri: "百合", glasses: "眼镜", monster: "怪物", incest: "近亲", "x-ray": "透视", teacher: "教师",
  vanilla: "纯爱", ahegao: "阿嘿颜", tentacle: "触手", masturbation: "自慰", cosplay: "角色扮演", maid: "女仆", filmed: "偷拍", ntr: "NTR",
  swimsuit: "泳装", bdsm: "SM", milf: "人妻", watersports: "放尿", comedy: "喜剧", orgy: "乱交", threesome: "3P", horror: "恐怖",
  "ugly bastard": "丑男", "dark skin": "黑皮", pov: "主观视角", "mind break": "恶堕", lactation: "母乳", "mind control": "催眠", nurse: "护士",
  futanari: "扶她", "foot job": "足交", inflation: "腹胀", rimjob: "舔肛", scat: "重口", pregnant: "怀孕", "3d": "3D", tsundere: "傲娇",
  nekomimi: "猫耳", softcore: "轻口", trap: "伪娘", yaoi: "耽美",
};
const zh = (t: string) => TAG_ZH[t] ?? t;
const fromZh = (t: string) => Object.entries(TAG_ZH).find(([, v]) => v === t)?.[0] ?? t;

interface Raw {
  id: string | number; name: string; search_titles?: string; slug: string; description?: string; views?: string | number;
  cover_url?: string; poster_url?: string; brand?: string; likes?: string | number; dislikes?: string | number;
  tags?: string[] | string; created_at?: string; released_at?: string;
}

interface Entry {
  id: string; name: string; slug: string; series: string; part: number; jp: string; titles: string; norm: string; overview: string;
  views: number; likes: number; dislikes: number; score: number; rating: number | null; brand: string;
  tags: string[]; released: string | null; created: string | null; poster: string | null; cover: string | null; rawPoster: string | null;
}

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const img = (u?: string) => (u ? `/v1/img/ext?u=${encodeURIComponent(u)}` : null);

// Lower bound of the Wilson interval: ranks 950 likes / 50 dislikes above 9 / 0.
function wilson(up: number, down: number) {
  const n = up + down;
  if (!n) return 0;
  const z = 1.96, p = up / n;
  return (p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n)) / (1 + (z * z) / n);
}

function strip(html = "") {
  return html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n\s*\n\s*/g, "\n\n").trim();
}

// The Japanese title hidden in search_titles ("Rhythm 2 Pure Love Rhythm 恋の律動 …") — the better
// keyword for sukebei/Nyaa, where releases carry the original name.
function japanese(titles: string, part: number) {
  const m = /[぀-ヿ㐀-鿿][　-ヿ㐀-鿿＀-￯0-9０-９！？!?〜~・･ 　]*/.exec(titles);
  let jp = m ? m[0].trim() : "";
  if (jp && part && !/\d|[０-９]/.test(jp)) jp = `${jp} ${part}`;
  return jp;
}

function entry(r: Raw): Entry {
  const tags = (Array.isArray(r.tags) ? r.tags : String(r.tags ?? "").replace(/[[\]']/g, "").split(",")).map((t) => t.trim().toLowerCase()).filter(Boolean);
  const m = /^(.*?)\s+(\d+)$/.exec(r.name.trim());
  const likes = num(r.likes), dislikes = num(r.dislikes);
  const series = (m ? m[1] : r.name).trim();
  const part = m ? Number(m[2]) : 0;
  return {
    id: String(r.id), name: r.name.trim(), slug: r.slug, series, part,
    jp: japanese(r.search_titles ?? "", part), titles: (r.search_titles ?? r.name).toLowerCase(), norm: normTitle(`${r.name} ${r.search_titles ?? ""}`), overview: strip(r.description),
    views: num(r.views), likes, dislikes, score: wilson(likes, dislikes), rating: likes + dislikes >= 5 ? Math.round((likes / (likes + dislikes)) * 100) / 10 : null,
    brand: r.brand ?? "", tags, released: r.released_at?.slice(0, 10) ?? null, created: r.created_at?.slice(0, 10) ?? null,
    // hanime's naming is inverted: cover_url is the 268×394 box art, poster_url the wide key art.
    poster: img(r.cover_url), cover: img(r.poster_url), rawPoster: r.cover_url ?? null,
  };
}

let db: { at: number; items: Entry[]; bySeries: Map<string, Entry[]> } | null = null;
let loading: Promise<void> | null = null;

function index(raw: Raw[]) {
  const items = raw.filter((r) => r && r.id && r.name).map(entry).filter((e) => !e.tags.some((t) => HIDDEN_TAGS.has(t)));
  const bySeries = new Map<string, Entry[]>();
  for (const e of items) bySeries.set(e.series, [...(bySeries.get(e.series) ?? []), e]);
  for (const list of bySeries.values()) list.sort((a, b) => a.part - b.part);
  return { items, bySeries };
}

async function download() {
  const res = await fetch(DB_URL, { headers: { "user-agent": UA, origin: "https://hanime.tv", referer: "https://hanime.tv/" }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`hanime 索引返回 ${res.status}`);
  const text = await res.text();
  const raw = (JSON.parse(text) as { data?: Raw[] }).data ?? [];
  if (raw.length < 500) throw new Error(`hanime 索引只有 ${raw.length} 条`);
  await mkdir(path.dirname(FILE), { recursive: true });
  await writeFile(`${FILE}.tmp`, JSON.stringify(raw));
  await rename(`${FILE}.tmp`, FILE);
  db = { at: Date.now(), ...index(raw) };
  void warmPosters(db.items);
}

// Fill the image cache with the box art of everything the home rows and first list pages show,
// so the phone never waits on hanime-cdn (1-2 s per image).
async function warmPosters(items: Entry[]) {
  const urls = new Set<string>();
  const year = new Date(Date.now() - 365 * 86400_000).toISOString().slice(0, 10);
  const lists = [...Object.values(SORTS).map((sort) => [...items].sort(sort)), items.filter((e) => String(e.released) >= year).sort(SORTS.rating)];
  for (const list of lists) for (const e of list.slice(0, 120)) if (e.rawPoster) urls.add(e.rawPoster);
  const queue = [...urls];
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let u = queue.shift(); u; u = queue.shift()) await extImage(u).catch(() => null);
  }));
}

async function load() {
  if (!db) {
    try {
      const raw = JSON.parse(await readFile(FILE, "utf8")) as Raw[];
      db = { at: 0, ...index(raw) }; // from disk: serve it, refresh in the background
      void warmPosters(db.items);
    } catch {
      // first start
    }
  }
  if (!db || Date.now() - db.at > REFRESH_MS) {
    loading ??= download().finally(() => (loading = null));
    if (!db) await loading;
    else loading.catch(() => {});
  }
  return db!;
}

function card(e: Entry): CatalogItem {
  return {
    id: e.id, title: e.name, subtitle: [e.brand, e.released?.slice(0, 4)].filter(Boolean).join(" · "), poster: e.poster, posterAspect: 268 / 394, landscape: e.cover,
    rating: e.rating, votes: e.likes + e.dislikes, views: e.views, date: e.released, added: e.created, blurb: e.overview.replace(/\s+/g, " ").slice(0, 140), tags: e.tags.filter((t) => t !== "hd").slice(0, 6).map(zh),
  };
}

const SORTS: Record<string, (a: Entry, b: Entry) => number> = {
  rating: (a, b) => b.score - a.score,
  views: (a, b) => b.views - a.views,
  released: (a, b) => String(b.released).localeCompare(String(a.released)),
  added: (a, b) => String(b.created).localeCompare(String(a.created)) || Number(b.id) - Number(a.id),
  likes: (a, b) => b.likes - a.likes,
};

export const hanime: CatalogProvider = {
  id: "hanime",
  name: "hanime 索引",
  kind: "hentai",
  note: "hanime.tv 公开索引，每 6 小时更新；评分 = 赞 / (赞 + 踩)",
  tagFilter: true,
  sorts: [{ id: "rating", label: "评分" }, { id: "released", label: "发售" }, { id: "added", label: "上架" }, { id: "views", label: "播放" }, { id: "likes", label: "点赞" }],

  async home(): Promise<HomeRow[]> {
    const { items } = await load();
    const year = new Date(Date.now() - 365 * 86400_000).toISOString().slice(0, 10);
    const top = (sort: string, filter: (e: Entry) => boolean = () => true) => items.filter(filter).sort(SORTS[sort]).slice(0, 20).map(card);
    return [
      { id: "added", title: "最近上架", query: { sort: "added" }, items: top("added") },
      { id: "recent-top", title: "近一年好评", query: { sort: "rating", since: year }, items: top("rating", (e) => String(e.released) >= year) },
      { id: "rating", title: "评分最高", query: { sort: "rating" }, items: top("rating") },
      { id: "views", title: "播放最多", query: { sort: "views" }, items: top("views") },
      { id: "released", title: "最新发售", query: { sort: "released" }, items: top("released") },
    ];
  },

  async list(q: ListQuery): Promise<Page<CatalogItem>> {
    const { items } = await load();
    const tag = q.tag ? fromZh(q.tag) : "";
    const needle = q.q?.trim().toLowerCase();
    const brand = q.person; // brands double as the "person" facet for 里番
    const hits = items.filter((e) => (!tag || e.tags.includes(tag)) && (!needle || e.titles.includes(needle) || e.jp.includes(needle)) && (!brand || e.brand === brand) && (!q.since || String(e.released) >= q.since));
    hits.sort(SORTS[q.sort] ?? SORTS.rating);
    const start = (q.page - 1) * q.size;
    return { items: hits.slice(start, start + q.size).map(card), total: hits.length, page: q.page, hasMore: start + q.size < hits.length };
  },

  async item(id: string): Promise<CatalogDetail | null> {
    const { items, bySeries } = await load();
    const e = items.find((x) => x.id === id);
    if (!e) return null;
    const total = e.likes + e.dislikes;
    return {
      ...card(e),
      tags: e.tags.filter((t) => t !== "hd").map(zh),
      overview: e.overview,
      originalTitle: e.jp || undefined,
      brand: e.brand,
      facts: [
        { label: "厂牌", value: e.brand },
        { label: "发售", value: e.released ?? "" },
        { label: "上架", value: e.created ?? "" },
        { label: "评价", value: total ? `${e.likes} 赞 · ${e.dislikes} 踩` : "" },
        { label: "播放", value: e.views ? e.views.toLocaleString("en-US") : "" },
      ].filter((f) => f.value),
      episodes: (bySeries.get(e.series) ?? [e]).map(card),
      keyword: e.jp || e.name,
      aliases: e.norm,
    };
  },

  async tags() {
    const { items } = await load();
    const count = new Map<string, number>();
    for (const e of items) for (const t of e.tags) if (t !== "hd") count.set(t, (count.get(t) ?? 0) + 1);
    return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name: zh(name), count: n }));
  },
};

// All titles of an entry (romaji, English, Japanese), normalised, for matching the 里番 library.
export function titlesOf(id: string) {
  return db?.items.find((e) => e.id === id)?.norm ?? "";
}

// The 里番 library names series in Chinese with the Japanese title as OriginalTitle; hanime's
// search_titles carries the Japanese title too, so NFKC + dropping punctuation and "THE ANIMATION"
// makes "らぶみー「楓と鈴」THE ANIMATION" a substring of the hanime entry's titles.
export function normTitle(s: string) {
  return s.normalize("NFKC").toLowerCase().replace(/the animation/g, "").replace(/[^0-9a-z\u3040-\u30ff\u3400-\u9fff]/g, "");
}
