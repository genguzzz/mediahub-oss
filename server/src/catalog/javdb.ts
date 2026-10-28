// JavDB (censored): daily / weekly / monthly rankings with user ratings, latest releases, the
// actress index with avatars, per-actress lists sortable by date / rating / heat, search by 番号.
// Pages come through the home-broadband proxy (JavDB may refuse the server's country).
import { chunks, decode, img, proxied, text } from "./http.ts";
import { avIntro } from "./intro.ts";
import { REJECT } from "./jable.ts";
import type { CatalogDetail, CatalogItem, CatalogProvider, HomeRow, ListQuery, Page, Person } from "./types.ts";

const BASE = "https://javdb.com";

function card(h: string): CatalogItem | null {
  const id = /href="\/v\/(\w+)"/.exec(h)?.[1];
  if (!id) return null;
  const code = /<strong>([^<]+)<\/strong>/.exec(h)?.[1]?.trim();
  const titleHtml = /<div class="video-title">([\s\S]*?)<\/div>/.exec(h)?.[1] ?? "";
  const title = text(titleHtml.replace(/<strong>[^<]*<\/strong>/, ""));
  const score = /([\d.]+)分,\s*由(\d+)人評價/.exec(h);
  if (REJECT.test(title)) return null;
  const tags = [...h.matchAll(/<span class="tag[^"]*">([^<]+)<\/span>/g)].map((m) => m[1].trim()).filter(Boolean);
  return {
    id, code, title: title || code || id,
    poster: img(/<img[^>]*src="([^"]+)"/.exec(h)?.[1]), posterCrop: "right",
    rating: score ? Math.round(Number(score[1]) * 20) / 10 : null, votes: score ? Number(score[2]) : undefined,
    date: /<div class="meta">\s*(\d{4}-\d{2}-\d{2})/.exec(h)?.[1] ?? null,
    // "可播放" is JavDB's own player; online sources here come from the stream providers.
    tags: tags.filter((t) => t !== "可播放").map((t) => t.replace(/鏈/g, "链")),
  };
}

function page(html: string, n: number): Page<CatalogItem> {
  const items = chunks(html, /<div class="item">/).map(card).filter((x): x is CatalogItem => !!x);
  return { items, total: 0, page: n, hasMore: /class="pagination-next"/.test(html) };
}

const LISTS: Record<string, (p: number) => string> = {
  daily: () => "/rankings/movies?p=daily&t=censored",
  weekly: () => "/rankings/movies?p=weekly&t=censored",
  monthly: () => "/rankings/movies?p=monthly&t=censored",
  latest: (p) => `/censored?page=${p}`,
  magnet: (p) => `/censored?vft=1&vst=2&page=${p}`,
  subtitle: (p) => `/censored?vft=2&page=${p}`,
};
const PERSON_SORT: Record<string, number> = { released: 0, rating: 1, hot: 2, want: 3, watched: 4 };

async function list(q: ListQuery): Promise<Page<CatalogItem>> {
  let path: string;
  if (q.person) path = `/actors/${encodeURIComponent(q.person)}?sort_type=${PERSON_SORT[q.sort] ?? 0}&page=${q.page}`;
  else if (q.q) path = `/search?q=${encodeURIComponent(q.q)}&f=all&page=${q.page}`;
  else path = (LISTS[q.sort] ?? LISTS.weekly)(q.page);
  const ranking = !q.person && !q.q && path.startsWith("/rankings");
  if (ranking && q.page > 1) return { items: [], total: 0, page: q.page, hasMore: false };
  const html = await proxied(BASE + path, ranking || q.sort === "latest" ? 20 * 60_000 : 60 * 60_000);
  const r = page(html, q.page);
  return ranking ? { ...r, hasMore: false, total: r.items.length } : r;
}

async function item(id: string): Promise<CatalogDetail | null> {
  const html = await proxied(`${BASE}/v/${encodeURIComponent(id)}`, 6 * 3600_000);
  if (!html) return null;
  const blocks = new Map<string, string>();
  for (const m of html.matchAll(/<div class="panel-block[^"]*">\s*<strong>([^<:：]+)[:：]?<\/strong>([\s\S]*?)<\/div>/g)) blocks.set(m[1].trim(), m[2]);
  const val = (k: string) => (blocks.has(k) ? text(blocks.get(k)!) : "");
  const code = val("番號").replace(/\s+/g, "") || undefined;
  const score = /([\d.]+)分,\s*由(\d+)人評價/.exec(blocks.get("評分") ?? "");
  const people = [...(blocks.get("演員") ?? "").matchAll(/<a class="actor-female" href="\/actors\/(\w+)">([^<]+)<\/a>/g)]
    .map((m) => ({ id: m[1], name: decode(m[2]).trim() }));
  const tags = [...(blocks.get("類別") ?? "").matchAll(/<a[^>]*>([^<]+)<\/a>/g)].map((m) => decode(m[1]).trim());
  const magnets = (html.match(/class="magnet-name"/g) ?? []).length;
  const title = decode(/<strong class="current-title">([^<]*)<\/strong>/.exec(html)?.[1] ?? "").trim();
  const cover = /<img class="video-cover"[^>]*src="([^"]+)"/.exec(html)?.[1];
  return {
    id, code, title: title || code || id,
    poster: img(cover), posterCrop: "right", landscape: img(cover),
    rating: score ? Math.round(Number(score[1]) * 20) / 10 : null, votes: score ? Number(score[2]) : undefined,
    date: val("日期") || null, tags, people,
    overview: avIntro(title, { people: people.map((x) => x.name), studio: val("片商"), minutes: Number(/\d+/.exec(val("時長"))?.[0]) || undefined, tags: tags.filter((t) => !/單體作品|有碼|無碼/.test(t)) }),
    brand: val("片商") || undefined,
    facts: [
      { label: "番号", value: code ?? "" },
      { label: "发行", value: val("日期") },
      { label: "时长", value: val("時長").replace("分鍾", "分钟") },
      { label: "片商", value: val("片商") },
      { label: "系列", value: val("系列") },
      { label: "导演", value: val("導演") },
      { label: "评分", value: score ? `${score[1]} / 5 · ${score[2]} 人评价` : "" },
      { label: "磁链", value: magnets ? `${magnets} 个` : "" },
    ].filter((f) => f.value),
    episodes: [],
    keyword: code ?? title,
  };
}

async function persons(_sort: string, n: number): Promise<Page<Person>> {
  const html = await proxied(`${BASE}/actors/censored?page=${n}`, 6 * 3600_000);
  const items = chunks(html, /<div class="box actor-box">/).map((h): Person | null => {
    const id = /href="\/actors\/(\w+)"/.exec(h)?.[1];
    if (!id) return null;
    return {
      id, name: text(/<strong>([\s\S]*?)<\/strong>/.exec(h)?.[1] ?? ""), count: null, latest: null,
      poster: img(/<img class="avatar" src="([^"]+)"/.exec(h)?.[1]), aliases: decode(/title="([^"]*)"/.exec(h)?.[1] ?? ""),
    };
  }).filter((x): x is Person => !!x);
  return { items, total: 0, page: n, hasMore: /class="pagination-next"/.test(html) };
}

export const javdb: CatalogProvider = {
  id: "javdb",
  name: "JavDB",
  kind: "av",
  note: "JavDB 有码排行与评分（经家宽代理）",
  sorts: [{ id: "weekly", label: "周榜" }, { id: "daily", label: "日榜" }, { id: "monthly", label: "月榜" }, { id: "latest", label: "最新" }, { id: "magnet", label: "新磁链" }, { id: "subtitle", label: "有字幕" }],
  personSorts: [{ id: "released", label: "发行" }, { id: "rating", label: "评分" }, { id: "hot", label: "热度" }, { id: "want", label: "想看" }, { id: "watched", label: "看过" }],
  personIndexSorts: [{ id: "hot", label: "热门" }],
  tagFilter: false,

  async home(): Promise<HomeRow[]> {
    const rows = [["weekly", "周榜"], ["daily", "日榜"], ["monthly", "月榜"], ["latest", "最新发行"]] as const;
    const got = await Promise.all(rows.map(([sort]) => list({ sort, page: 1, size: 40 }).catch(() => null)));
    return rows.map(([sort, title], i) => ({ id: sort, title, query: { sort }, items: got[i]?.items.slice(0, 20) ?? [] }));
  },
  list,
  item,
  async tags() {
    return [];
  },
  persons,
};
