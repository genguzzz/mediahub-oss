// JavDB: 有碼 and 無碼 daily / weekly / monthly rankings with user ratings, latest releases, the
// actress index with avatars, per-actress lists sortable by date / rating / heat, search by 番号.
// Pages come through the home-broadband proxy (JavDB may refuse the server's country). The 無碼
// section (lists, rankings, detail pages) needs an account: see javdbSession.ts.
import { chunks, decode, img, LoginRequired, proxied, text } from "./http.ts";
import { javdbCookie, javdbExpired } from "./javdbSession.ts";
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
  u_weekly: () => "/rankings/movies?p=weekly&t=uncensored",
  u_monthly: () => "/rankings/movies?p=monthly&t=uncensored",
  u_latest: (p) => `/uncensored?page=${p}`,
};
// Tag name → its list page ("/tags?c4=15"), learnt from the detail pages that show the tag. Tag lists need
// an account (logged out they come back empty), like the 無碼 section.
const tagPages = new Map<string, string>();

const NEEDS_LOGIN = new Set(["u_weekly", "u_monthly", "u_latest"]);

// Every JavDB page: with the logged-in session when there is one; a redirect to /login with a session
// means it expired (marked, then reported).
async function get(path: string, needsLogin = false): Promise<string> {
  const cookie = await javdbCookie();
  if (needsLogin && !cookie) throw new LoginRequired("JavDB");
  try {
    return await proxied(BASE + path, cookie);
  } catch (e) {
    // 無碼 pages answer a missing/expired session with a redirect to /login (lists, detail) or a bare 403 (rankings).
    const denied = e instanceof LoginRequired || (needsLogin && e instanceof Error && /返回 403/.test(e.message));
    if (denied && cookie) await javdbExpired();
    throw denied ? new LoginRequired("JavDB") : e;
  }
}
const PERSON_SORT: Record<string, number> = { released: 0, rating: 1, hot: 2, want: 3, watched: 4 };

async function list(q: ListQuery): Promise<Page<CatalogItem>> {
  let path: string;
  if (q.person) path = `/actors/${encodeURIComponent(q.person)}?sort_type=${PERSON_SORT[q.sort] ?? 0}&page=${q.page}`;
  else if (q.q) path = `/search?q=${encodeURIComponent(q.q)}&f=all&page=${q.page}`;
  else if (q.tag) {
    const tagPage = tagPages.get(q.tag);
    if (!tagPage) throw Object.assign(new Error("先打开带这个标签的作品，再点标签"), { statusCode: 404 });
    return page(await get(`${tagPage}${tagPage.includes("?") ? "&" : "?"}page=${q.page}`, true), q.page);
  }
  else path = (LISTS[q.sort] ?? LISTS.weekly)(q.page);
  const ranking = !q.person && !q.q && path.startsWith("/rankings");
  if (ranking && q.page > 1) return { items: [], total: 0, page: q.page, hasMore: false };
  const html = await get(path, NEEDS_LOGIN.has(q.sort));
  const r = page(html, q.page);
  return ranking ? { ...r, hasMore: false, total: r.items.length } : r;
}

async function item(id: string): Promise<CatalogDetail | null> {
  const html = await get(`/v/${encodeURIComponent(id)}`);
  if (!html) return null;
  const blocks = new Map<string, string>();
  for (const m of html.matchAll(/<div class="panel-block[^"]*">\s*<strong>([^<:：]+)[:：]?<\/strong>([\s\S]*?)<\/div>/g)) blocks.set(m[1].trim(), m[2]);
  const val = (k: string) => (blocks.has(k) ? text(blocks.get(k)!) : "");
  const code = val("番號").replace(/\s+/g, "") || undefined;
  const score = /([\d.]+)分,\s*由(\d+)人評價/.exec(blocks.get("評分") ?? "");
  const people = [...(blocks.get("演員") ?? "").matchAll(/<a class="actor-female" href="\/actors\/(\w+)">([^<]+)<\/a>/g)]
    .map((m) => ({ id: m[1], name: decode(m[2]).trim() }));
  const tags = [...(blocks.get("類別") ?? "").matchAll(/<a\b([^>]*)>([^<]+)<\/a>/g)].map((m) => {
    const name = decode(m[2]).trim();
    const href = /href="([^"]*)"/.exec(m[1])?.[1];
    if (name && href?.startsWith("/tags")) tagPages.set(name, decode(href));
    return name;
  });
  const magnets = (html.match(/class="magnet-name"/g) ?? []).length;
  const title = decode(/<strong class="current-title">([^<]*)<\/strong>/.exec(html)?.[1] ?? "").trim();
  const cover = /<img class="video-cover"[^>]*src="([^"]+)"/.exec(html)?.[1];
  // Samples only: the same "tile-item" markup is used further down for related works (links to /v/…).
  const gallery = /<div class="tile-images preview-images">([\s\S]*?)<\/article>/.exec(html)?.[1] ?? "";
  const previews = [...gallery.matchAll(/<a class="tile-item" href="([^"]+)"[^>]*>\s*<img src="([^"]+)"/g)]
    .map((m) => ({ full: img(decode(m[1])), thumb: img(decode(m[2])) }))
    .filter((p): p is { full: string; thumb: string } => !!p.full && !!p.thumb);
  return {
    id, code, title: title || code || id, previews,
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
    sourceUrl: `${BASE}/v/${encodeURIComponent(id)}`,
  };
}

async function persons(sort: string, n: number): Promise<Page<Person>> {
  const html = await get(`/actors/${sort === "uncensored" ? "uncensored" : "censored"}?page=${n}`);
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
  note: "JavDB 有码、无码排行与评分（经家宽代理；无码需在设置里登录 JavDB）",
  sorts: [{ id: "weekly", label: "周榜" }, { id: "daily", label: "日榜" }, { id: "monthly", label: "月榜" }, { id: "latest", label: "最新" }, { id: "magnet", label: "新磁链" }, { id: "subtitle", label: "有字幕" },
    { id: "u_weekly", label: "无码周榜" }, { id: "u_monthly", label: "无码月榜" }, { id: "u_latest", label: "无码最新" }],
  personSorts: [{ id: "released", label: "发行" }, { id: "rating", label: "评分" }, { id: "hot", label: "热度" }, { id: "want", label: "想看" }, { id: "watched", label: "看过" }],
  personIndexSorts: [{ id: "hot", label: "有码" }, { id: "uncensored", label: "无码" }],
  tagFilter: true,          // tags from detail pages (their list pages are learnt there; need the account)

  async home(): Promise<HomeRow[]> {
    // 無碼 rows only with a live session (without one they would just be login errors).
    const loggedIn = !!(await javdbCookie());
    const rows = ([["weekly", "周榜"], ["daily", "日榜"], ["u_weekly", "无码周榜"], ["monthly", "月榜"], ["latest", "最新发行"], ["u_latest", "无码最新"]] as const)
      .filter(([sort]) => loggedIn || !NEEDS_LOGIN.has(sort));
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
