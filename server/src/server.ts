import Fastify, { type FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { config } from "./config.ts";
import { embyImage, extImage, posterPath, tmdbImage, tmdbPath } from "./images.ts";
import { mp, mpRaw, plug, plugBytes, UpstreamError } from "./mp.ts";
import { listUpdates, manifestResponse, storeUpdate } from "./updates.ts";
import { registerCatalog } from "./catalog/index.ts";
import { embyEvents, startEmbyEvents } from "./embyEvents.ts";

const app = Fastify({
  // JSON lines to journald: `journalctl -u mediahub -o cat | grep <rid>`
  logger: { level: process.env.LOG_LEVEL ?? "info" },
  bodyLimit: 8 * 1024 * 1024,
  genReqId: (req) => {
    const h = req.headers["x-request-id"];
    return typeof h === "string" && /^[\w-]{6,64}$/.test(h) ? h : randomUUID().slice(0, 12);
  },
  requestIdLogLabel: "rid",
  disableRequestLogging: true,
});

await app.register(multipart, { limits: { fileSize: 60 * 1024 * 1024, files: 1 } });

// CORS for the web preview build; auth is a bearer token, never cookies.
app.addHook("onRequest", async (req, reply) => {
  reply.header("access-control-allow-origin", "*").header("access-control-expose-headers", "x-request-id");
  if (req.method === "OPTIONS") {
    return reply.code(204).header("access-control-allow-methods", "GET,POST,DELETE").header("access-control-allow-headers", "authorization,content-type,x-request-id,x-app-version").header("access-control-max-age", "86400").send();
  }
});

app.addHook("onRequest", async (req, reply) => {
  reply.header("x-request-id", req.id);
  if (!req.url.startsWith("/v1/img/")) req.log.info({ method: req.method, url: req.url, appVersion: req.headers["x-app-version"] }, "req");
});
app.addHook("onResponse", async (req, reply) => {
  if (!req.url.startsWith("/v1/img/") || reply.statusCode >= 400) req.log.info({ status: reply.statusCode, ms: Math.round(reply.elapsedTime) }, "res");
});

function tokenOk(req: FastifyRequest, expected: string): boolean {
  const auth = req.headers.authorization ?? "";
  const got = Buffer.from(auth.startsWith("Bearer ") ? auth.slice(7) : "");
  const want = Buffer.from(expected);
  return got.length === want.length && timingSafeEqual(got, want);
}

app.addHook("preHandler", async (req, reply) => {
  if (req.url.startsWith("/v1/") && !tokenOk(req, config.appToken)) return reply.code(401).send({ error: "unauthorized" });
  if (req.url.startsWith("/admin/") && !tokenOk(req, config.adminToken)) return reply.code(401).send({ error: "unauthorized" });
});

app.setErrorHandler((err, req, reply) => {
  const e = err as Error & { statusCode?: number; issues?: unknown };
  const status = err instanceof UpstreamError ? err.status : e.issues ? 400 : e.statusCode ?? 500;
  req.log.warn({ err: e.message, status }, "error");
  reply.code(status).send({ error: e.issues ? "参数不对" : e.message });
});

app.get("/health", async () => ({ ok: true }));

// ---------- helpers ----------

type Kind = "movie" | "tv";
const TYPE_NAME: Record<Kind, string> = { movie: "电影", tv: "电视剧" };
const kindOf = (t: unknown): Kind => (t === "电影" || t === "movie" ? "movie" : "tv");
const ADULT_LIBS = new Set(["AV", "里番"]);

// Short-lived memo for slow, rarely changing upstream answers.
const memo = new Map<string, { at: number; value: Promise<unknown> }>();
function remember<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as Promise<T>;
  const value = fn();
  memo.set(key, { at: Date.now(), value });
  value.catch(() => memo.delete(key));
  return value;
}

interface MpMedia {
  type?: string;
  title?: string;
  year?: string;
  tmdb_id?: number;
  media_source?: string;
  original_title?: string;
  poster_path?: string;
  backdrop_path?: string;
  overview?: string;
  vote_average?: number;
  genres?: { id: number; name: string }[];
  status?: string;
  number_of_seasons?: number;
  number_of_episodes?: number;
  release_date?: string;
  first_air_date?: string;
  last_air_date?: string;
  origin_country?: string[];
  names?: string[];
  en_title?: string | null;
  hk_title?: string | null;
  tw_title?: string | null;
  original_language?: string;
  imdb_id?: string | null;
  tagline?: string | null;
  actors?: MpPerson[];
  directors?: MpPerson[];
  created_by?: MpPerson[];
  networks?: { id: number; name: string }[];
  production_companies?: { id: number; name: string }[];
  runtime?: number | null;
  vote_count?: number;
}

interface MpPerson { id: number; name: string; original_name?: string; character?: string | null; job?: string | null; profile_path?: string | null }

// Search keywords for one work, best first: the language of the work's region (origin country, else
// original language) leads — CN → Chinese, JP → Japanese (+ romaji), KR → Korean, US/GB → English…;
// when there is no title in that language, Chinese leads. Chinese is always included (Mikan, dmhy).
type SearchName = { text: string; lang: "zh" | "ja" | "romaji" | "en" | "ko" | "original" };
const COUNTRY_LANG: Record<string, string> = {
  CN: "zh", TW: "zh", HK: "zh", MO: "zh", SG: "zh", JP: "ja", KR: "ko",
  US: "en", GB: "en", CA: "en", AU: "en", NZ: "en", IE: "en",
};
function searchNames(m: MpMedia): SearchName[] {
  const olang = (m.original_language ?? "").toLowerCase().replace("cn", "zh");
  const country = m.origin_country ?? [];
  const anime = (m.genres ?? []).some((g) => g.id === 16 || g.name === "动画");
  const region = country.map((c) => COUNTRY_LANG[c]).find(Boolean) ?? (olang || (anime ? "ja" : "zh"));
  const others = m.names ?? [];
  const kana = /[\u3040-\u30ff]/;
  const hangul = /[\uac00-\ud7af]/;
  const latin = /^[\x20-\x7e\u00c0-\u024f\u2018\u2019]+$/;
  const pick = (lang: SearchName["lang"], list: (string | null | undefined)[]) => list.map((t) => ({ text: t ?? "", lang }));
  const by: Record<string, SearchName[]> = {
    zh: pick("zh", [m.title, m.tw_title, m.hk_title]),
    ja: pick("ja", [olang === "ja" ? m.original_title : "", ...others.filter((n) => kana.test(n)).slice(0, olang === "ja" ? 0 : 1)]),
    ko: pick("ko", [olang === "ko" ? m.original_title : "", ...others.filter((n) => hangul.test(n)).slice(0, olang === "ko" ? 0 : 1)]),
    en: pick("en", [m.en_title, olang === "en" ? m.original_title : ""]),
  };
  // Romaji: the Latin aliases of a Japanese work that aren't the English title (Sousou no Frieren).
  by.romaji = region === "ja"
    ? pick("romaji", others.filter((n) => latin.test(n) && n !== m.en_title && /\b(no|wa|ga|wo)\b|[āōūēī]|ou\b/i.test(n))
      .sort((a, b) => Number(!/^[\x20-\x7e]+$/.test(a)) - Number(!/^[\x20-\x7e]+$/.test(b))).slice(0, 2))
    : [];
  // Any other region language (fr, de, es, th…): only the original title is reliably in that language.
  by.original = m.original_title && !["zh", "ja", "en", "ko"].includes(olang) ? pick("original", [m.original_title]) : [];
  const has = (k: string) => by[k]?.some((n) => n.text.trim());
  const lead = region in by && has(region) ? region : !["zh", "ja", "en", "ko"].includes(region) && has("original") ? "original" : "zh";
  const order = [lead, ...(lead === "ja" ? ["romaji"] : []), "zh", "en", "ja", "romaji", "ko", "original"];
  const seen = new Set<string>();
  return [...new Set(order)].flatMap((k) => by[k] ?? []).filter((n) => {
    const k = n.text.trim().toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 8);
}

function brief(m: MpMedia) {
  return {
    type: kindOf(m.type),
    tmdbid: m.tmdb_id ?? null,
    title: m.title ?? "",
    year: m.year ?? "",
    originalTitle: m.original_title ?? "",
    poster: tmdbPath(m.poster_path),
    backdrop: tmdbPath(m.backdrop_path, "w780"),
    overview: m.overview ?? "",
    vote: m.vote_average ?? 0,
  };
}

type LibHit = { id: string; name: string; lib: string };

async function libraryOf(items: { tmdbid: number | null; type: Kind }[]): Promise<Record<string, LibHit>> {
  const want = items.filter((i) => i.tmdbid).map((i) => ({ tmdbid: i.tmdbid, type: i.type }));
  if (!want.length) return {};
  try {
    return await plug<Record<string, LibHit>>("POST", "/hub/library", { body: { items: want }, timeoutMs: 20_000 });
  } catch {
    return {};
  }
}

// ---------- overview ----------

app.get("/v1/overview", async () => {
  const [pipe, qb, emby, subs] = await Promise.allSettled([
    plug<{ tasks: { status: string; failed: boolean; emby?: number | null }[]; adult: { done?: boolean; failed?: boolean }[] }>("GET", "/hub/pipeline", { query: { limit: 40 }, timeoutMs: 40_000 }),
    plug<{ torrents?: { state: string; progress: number }[]; transfer?: { dl_info_speed?: number; up_info_speed?: number } }>("GET", "/hub/qb", { query: { filter: "active" } }),
    plug<{ running?: { name: string; progress: number | null }[] }>("GET", "/hub/emby/activity"),
    mp<unknown[]>("GET", "/subscribe/"),
  ]);
  const p = pipe.status === "fulfilled" ? pipe.value : null;
  const tasks = p?.tasks ?? [];
  return {
    pipeline: p
      ? {
          downloading: tasks.filter((t) => t.status === "downloading" || t.status === "buffer").length,
          waiting: tasks.filter((t) => t.status === "uploaded" || (t.status === "done" && !t.emby)).length,
          failed: tasks.filter((t) => t.failed).length,
          av: (p.adult ?? []).filter((a) => !a.done).length,
        }
      : null,
    qb: qb.status === "fulfilled" ? { active: qb.value.torrents?.length ?? 0, dl: qb.value.transfer?.dl_info_speed ?? 0, up: qb.value.transfer?.up_info_speed ?? 0 } : null,
    emby: emby.status === "fulfilled" ? { running: emby.value.running ?? [] } : null,
    subscriptions: subs.status === "fulfilled" && Array.isArray(subs.value) ? subs.value.length : null,
    errors: [pipe, qb, emby, subs].filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason?.message ?? r)),
  };
});

// Emby push listener (see embyEvents.ts): status for troubleshooting.
startEmbyEvents(app.log);
app.get("/admin/emby/events", async () => embyEvents);

// ---------- health check (概览 需要处理) ----------
// The only scheduled job: a read-only scan every HEALTH_EVERY that surfaces problems (unconfirmed scrapes, stuck
// or failed tasks, 里番 not identified by their Bangumi id, MDC failures, missing posters). It fixes nothing by
// itself; the app lists the findings and the user acts on them (/v1/health/fix).
type Health = { ok: boolean; at: number; total: number; errors: string[]; checks: { key: string; title: string; severity: string; count: number; hint: string; items: unknown[] }[] };
const HEALTH_EVERY = 6 * 3600_000;
let health: Health | null = null;
let healthRunning: Promise<Health | null> | null = null;

async function runHealth(): Promise<Health | null> {
  if (healthRunning) return healthRunning;
  healthRunning = (async () => {
    try {
      const h = await plug<Health>("GET", "/hub/health", { timeoutMs: 120_000 });
      if (h?.ok) {
        health = h;
        await mkdir(statsDir(), { recursive: true });
        await writeFile(path.join(statsDir(), "health.json"), JSON.stringify(h));
      }
      return health;
    } catch (e) {
      app.log.warn({ err: e instanceof Error ? e.message : String(e) }, "health scan failed");
      return health;
    } finally {
      healthRunning = null;
    }
  })();
  return healthRunning;
}

void readFile(path.join(config.dataDir, "stats", "health.json"), "utf8").then((t) => { health = JSON.parse(t) as Health; }).catch(() => {});
setTimeout(() => void runHealth(), 60_000);
setInterval(() => void runHealth(), HEALTH_EVERY).unref();

// Opening the page refreshes stale findings (≥ 10 min old) in the background, so fixed problems disappear without
// waiting for the 6-hour scan; the answer comes from the cache at once.
app.get("/v1/health", async () => {
  const stale = !health || Date.now() - health.at * 1000 >= 10 * 60_000;
  if (stale) void runHealth();
  return health ? { ...health, refreshing: stale || !!healthRunning } : { ok: false, error: "正在检查，稍后刷新" };
});
app.post("/v1/health/run", async () => (await runHealth()) ?? { ok: false, error: "检查失败" });
app.post("/v1/health/fix", async (req) => {
  const b = z.object({ key: z.string().max(40), id: z.string().max(80) }).parse(req.body);
  const r = await plug<{ ok: boolean }>("POST", "/hub/health/fix", { body: b, timeoutMs: 60_000 });
  req.log.info({ ...b, ok: r.ok }, "health fix");
  if (r.ok) void runHealth();
  return r;
});

// ---------- system stats (系统页 存储 / 媒体库) ----------
// The plugin's /hub/stats walks Emby and asks 115/qB, which takes a few seconds. Refreshed only while someone uses
// the app: a request for /v1/stats answers from the cache at once and, if the cache is older than STATS_MIN_AGE,
// refreshes it in the background (no timer). Manual refresh obeys the same minimum interval. The last result is kept
// on disk, plus one snapshot per day (stats/days.jsonl) so growth (library size, 115 usage) can be shown later.

type Stats = { ok: boolean; at: number; errors: string[]; libraries: unknown[]; storage: Record<string, unknown>; ingest: Record<string, unknown> };
let statsCache: Stats | null = null;
let statsRunning: Promise<Stats | null> | null = null;
const STATS_MIN_AGE = 10 * 60_000;
const statsAge = () => (statsCache ? Date.now() - statsCache.at * 1000 : Infinity);
const statsDir = () => path.join(config.dataDir, "stats");

async function refreshStats(): Promise<Stats | null> {
  if (statsRunning) return statsRunning;
  statsRunning = (async () => {
    try {
      const s = await plug<Stats>("GET", "/hub/stats", { timeoutMs: 120_000 });
      if (!s?.ok) return statsCache;
      statsCache = s;
      await mkdir(statsDir(), { recursive: true });
      await writeFile(path.join(statsDir(), "latest.json"), JSON.stringify(s));
      const day = new Date().toISOString().slice(0, 10);
      const days = await readFile(path.join(statsDir(), "days.jsonl"), "utf8").catch(() => "");
      if (!days.includes(`"day":"${day}"`)) await appendFile(path.join(statsDir(), "days.jsonl"), JSON.stringify({ day, ...s }) + "\n");
      return s;
    } catch (e) {
      app.log.warn({ err: e instanceof Error ? e.message : String(e) }, "stats refresh failed");
      return statsCache;
    } finally {
      statsRunning = null;
    }
  })();
  return statsRunning;
}

void readFile(path.join(statsDir(), "latest.json"), "utf8").then((t) => { statsCache = JSON.parse(t) as Stats; }).catch(() => {});
app.get("/v1/stats", async (req) => {
  const q = z.object({ refresh: z.enum(["0", "1"]).default("0") }).parse(req.query);
  const due = statsAge() >= STATS_MIN_AGE;
  if (!statsCache || (q.refresh === "1" && due)) return (await refreshStats()) ?? { ok: false, error: "统计还没准备好" };
  if (due) void refreshStats();               // someone is looking: refresh in the background, answer from cache now
  return { ...statsCache, refreshing: due || !!statsRunning, nextRefresh: statsCache.at + STATS_MIN_AGE / 1000 };
});

// Daily snapshots, oldest first (library counts and 115 usage over time).
app.get("/v1/stats/days", async () => {
  const raw = await readFile(path.join(statsDir(), "days.jsonl"), "utf8").catch(() => "");
  return { days: raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Stats & { day: string }).slice(-90) };
});

// ---------- media (TMDb via MP) ----------

app.get("/v1/media/search", async (req) => {
  const q = z.object({ q: z.string().min(1), page: z.coerce.number().int().min(1).default(1) }).parse(req.query);
  // People on the first page only (an actor or director's name opens their works timeline).
  type MpPersonHit = { source?: string; id: number; name: string; original_name?: string; profile_path?: string | null; known_for_department?: string; popularity?: number };
  const [list, persons] = await Promise.all([
    mp<MpMedia[]>("GET", "/media/search", { query: { title: q.q, type: "media", page: q.page, count: 20 }, timeoutMs: 30_000 }),
    q.page === 1 ? mp<MpPersonHit[]>("GET", "/media/search", { query: { title: q.q, type: "person", page: 1, count: 10 }, timeoutMs: 30_000 }).catch(() => [] as MpPersonHit[]) : Promise.resolve([] as MpPersonHit[]),
  ]);
  const items = (list ?? []).filter((m) => m.tmdb_id && (m.type === "电影" || m.type === "电视剧")).map(brief);
  const lib = await libraryOf(items);
  const people = (persons ?? []).filter((p) => p.source === "themoviedb" && p.id && (p.popularity ?? 0) >= 0.5)
    .sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0)).slice(0, 10)
    .map((p) => ({ id: p.id, name: p.name, original: p.original_name && p.original_name !== p.name ? p.original_name : "", photo: tmdbPath(p.profile_path ?? null, "w185"), dept: p.known_for_department ?? "" }));
  return { items: items.map((i) => ({ ...i, library: lib[`${i.type}:${i.tmdbid}`] ?? null })), people };
});

interface MpSeason { season_number: number; name?: string; episode_count?: number; air_date?: string; poster_path?: string; overview?: string }
interface MpSub {
  id: number;
  name: string;
  year?: string;
  type?: string;
  season?: number | null;
  media_source?: string;
  media_id?: string;
  tmdbid?: number | null;
  poster?: string;
  state?: string;
  total_episode?: number;
  lack_episode?: number;
  start_episode?: number;
  last_update?: string;
  last_search?: string;
  username?: string;
}

function sub(s: MpSub) {
  const tmdb = s.tmdbid ?? (s.media_source === "themoviedb" && s.media_id ? Number(s.media_id) : null);
  return {
    id: s.id,
    title: s.name,
    year: s.year ?? "",
    type: kindOf(s.type),
    season: s.season ?? null,
    tmdbid: tmdb,
    source: s.media_source ?? "",
    poster: posterPath(s.poster),
    state: s.state ?? "",
    total: s.total_episode ?? null,
    lack: s.lack_episode ?? null,
    start: s.start_episode ?? null,
    lastSearch: s.last_search ?? null,
    lastUpdate: s.last_update ?? null,
    by: s.username ?? "",
  };
}

// Cast in billing order, then creators and directors (one entry per person; TV directors are per episode, keep a few).
function people(d: MpMedia) {
  const seen = new Set<number>();
  const out: { id: number; name: string; role: string; kind: "cast" | "crew"; photo: string | null }[] = [];
  const add = (p: MpPerson, role: string, kind: "cast" | "crew") => {
    if (!p?.id || seen.has(p.id)) return;
    seen.add(p.id);
    out.push({ id: p.id, name: p.name || p.original_name || "", role, kind, photo: tmdbPath(p.profile_path ?? null, "w185") });
  };
  (d.actors ?? []).slice(0, 30).forEach((p) => add(p, p.character ?? "", "cast"));
  (d.created_by ?? []).forEach((p) => add(p, "主创", "crew"));
  (d.directors ?? []).slice(0, 4).forEach((p) => add(p, "导演", "crew"));
  return out;
}

app.get<{ Params: { type: string; id: string } }>("/v1/media/:type/:id", async (req) => {
  const type = kindOf(req.params.type);
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const [detail, seasons, library, subs] = await Promise.all([
    remember(`detail:${type}:${id}`, 30 * 60_000, () =>
      mp<MpMedia>("GET", `/media/${id}`, { query: { media_source: "themoviedb", type_name: TYPE_NAME[type] }, timeoutMs: 30_000 })),
    type === "tv"
      ? remember(`seasons:${id}`, 30 * 60_000, () => mp<MpSeason[]>("GET", "/media/seasons", { query: { media_source: "themoviedb", media_id: id } }))
      : Promise.resolve([] as MpSeason[]),
    plug<Record<string, unknown>>("GET", "/hub/library/item", { query: { tmdbid: id, type } }).catch(() => null),
    mp<MpSub[]>("GET", "/subscribe/").catch(() => [] as MpSub[]),
  ]);
  const ids = await subIdentities();
  return {
    media: {
      ...brief(detail),
      genres: (detail.genres ?? []).map((g) => g.name),
      genreList: detail.genres ?? [],
      networks: (detail.networks ?? []).map((n) => ({ id: n.id, name: n.name })),
      companies: (detail.production_companies ?? []).slice(0, 6).map((c) => ({ id: c.id, name: c.name })),
      people: people(detail),
      imdb: detail.imdb_id ?? "",
      tagline: detail.tagline ?? "",
      runtime: detail.runtime ?? null,
      votes: detail.vote_count ?? 0,
      status: detail.status ?? "",
      seasons: detail.number_of_seasons ?? null,
      episodes: detail.number_of_episodes ?? null,
      date: detail.release_date ?? detail.first_air_date ?? "",
      lastAir: detail.last_air_date ?? "",
      country: detail.origin_country ?? [],
      names: searchNames(detail),
    },
    seasons: (seasons ?? []).map((s) => ({
      season: s.season_number,
      name: s.name ?? `第 ${s.season_number} 季`,
      episodes: s.episode_count ?? 0,
      airDate: s.air_date ?? "",
      poster: tmdbPath(s.poster_path),
    })),
    library,
    subscriptions: withIdentity((subs ?? []).map(sub), ids).filter((s) => s.tmdbid === id && s.type === type),
  };
});

// ---------- discover (MP recommend lists) ----------

// Two indexes, shown as two tabs in 发现: TMDb (trending, popular, top rated by genre; Bangumi's season calendar
// sits here because it opens TMDb works) and Douban (rankings and what is hot in China). `ranked` lists keep
// their order and show the position; `max` caps paging (Top250 = 9 pages of 30).
interface Section { path: string; title: string; group: "tmdb" | "douban"; query?: Record<string, string | number>; ranked?: boolean; max?: number }
const DISCOVER: Record<string, Section> = {
  trending: { path: "/recommend/tmdb_trending", title: "本周趋势", group: "tmdb" },
  bangumi: { path: "/recommend/bangumi_calendar", title: "本季新番", group: "tmdb", max: 1 },
  tvs: { path: "/recommend/tmdb_tvs", title: "热门剧集", group: "tmdb" },
  movies: { path: "/recommend/tmdb_movies", title: "热门电影", group: "tmdb" },
  top_movies: { path: "/recommend/tmdb_movies", title: "高分电影", group: "tmdb", query: { sort_by: "vote_average.desc", vote_count: 3000 }, ranked: true },
  top_tvs: { path: "/recommend/tmdb_tvs", title: "高分剧集", group: "tmdb", query: { sort_by: "vote_average.desc", vote_count: 1500 }, ranked: true },
  top_anime: { path: "/recommend/tmdb_tvs", title: "高分动画", group: "tmdb", query: { with_genres: 16, sort_by: "vote_average.desc", vote_count: 500 }, ranked: true },
  douban_top250: { path: "/recommend/douban_movie_top250", title: "豆瓣电影 Top250", group: "douban", ranked: true, max: 9 },
  douban_weekly_cn: { path: "/recommend/douban_tv_weekly_chinese", title: "华语口碑剧集榜", group: "douban", ranked: true, max: 1 },
  douban_weekly_global: { path: "/recommend/douban_tv_weekly_global", title: "全球口碑剧集榜", group: "douban", ranked: true, max: 1 },
  douban_top_movies: { path: "/recommend/douban_movies", title: "豆瓣高分电影", group: "douban", query: { sort: "S" }, ranked: true },
  douban_tv: { path: "/recommend/douban_tv_hot", title: "热门剧集", group: "douban" },
  douban_movie: { path: "/recommend/douban_movie_hot", title: "热门电影", group: "douban" },
  douban_anime: { path: "/recommend/douban_tv_animation", title: "热门动画", group: "douban" },
  douban_showing: { path: "/recommend/douban_showing", title: "正在上映", group: "douban" },
};

interface MpRec extends MpMedia { media_source?: string; media_id?: string; bangumi_id?: number | null; douban_id?: string | null }

function recBrief(m: MpRec) {
  return { ...brief(m), poster: posterPath(m.poster_path), source: m.media_source ?? "", sourceId: m.media_id ?? "" };
}

app.get("/v1/discover", async () => ({ sections: Object.entries(DISCOVER).map(([id, d]) => ({ id, title: d.title, group: d.group, ranked: !!d.ranked })) }));

app.get<{ Params: { id: string } }>("/v1/discover/:id", async (req) => {
  const d = DISCOVER[req.params.id];
  if (!d) throw Object.assign(new Error("没有这个榜单"), { statusCode: 404 });
  const { page } = z.object({ page: z.coerce.number().int().min(1).max(20).default(1) }).parse(req.query);
  if (d.max && page > d.max) return { title: d.title, ranked: !!d.ranked, items: [] };
  const list = await remember(`disc:${req.params.id}:${page}`, 30 * 60_000, () => mp<MpRec[]>("GET", d.path, { query: { ...d.query, page, count: 30 }, timeoutMs: 40_000 }));
  const items = (list ?? []).filter((m) => m.type === "电影" || m.type === "电视剧").map(recBrief);
  const lib = await libraryOf(items);
  return { title: d.title, ranked: !!d.ranked, items: items.map((i) => ({ ...i, library: i.tmdbid ? lib[`${i.type}:${i.tmdbid}`] ?? null : null })) };
});

// ---------- TMDb metadata browsing (发现: person → works timeline; genre / network / company / keyword lists) ----------

interface TmdbBrief { tmdbid: number; type: Kind; title: string; originalTitle: string; year: string; date: string; poster: string | null; vote: number; votes: number; overview: string }
const tmdbItem = (b: TmdbBrief) => ({ ...b, poster: tmdbPath(b.poster), source: "themoviedb", sourceId: String(b.tmdbid) });
async function withLib<T extends { tmdbid: number | null; type: Kind }>(items: T[]) {
  const lib = await libraryOf(items);
  return items.map((i) => ({ ...i, library: i.tmdbid ? lib[`${i.type}:${i.tmdbid}`] ?? null : null }));
}

app.get<{ Params: { id: string } }>("/v1/tmdb/person/:id", async (req) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const p = await remember(`person:${id}`, 6 * 3600_000, () =>
    plug<{ ok: boolean; error?: string; photo: string | null; works: (TmdbBrief & { roles: string[]; dept: string[]; episodes: number; minor: boolean })[] }>("GET", "/hub/tmdb/person", { query: { id }, timeoutMs: 40_000 }));
  if (!p.ok) throw Object.assign(new Error(p.error || "TMDb 人物读取失败"), { statusCode: 502 });
  return { ...p, photo: tmdbPath(p.photo, "w500"), works: await withLib(p.works.map((w) => ({ ...tmdbItem(w), roles: w.roles, dept: w.dept, episodes: w.episodes, minor: w.minor }))) };
});

const DiscoverQuery = z.object({
  type: z.enum(["movie", "tv"]).default("tv"),
  page: z.coerce.number().int().min(1).max(20).default(1),
  with_genres: z.string().max(40).optional(),
  with_networks: z.string().max(40).optional(),
  with_companies: z.string().max(40).optional(),
  with_keywords: z.string().max(40).optional(),
  sort_by: z.enum(["popularity.desc", "vote_average.desc", "primary_release_date.desc", "first_air_date.desc"]).default("popularity.desc"),
});

app.get("/v1/tmdb/discover", async (req) => {
  const q = DiscoverQuery.parse(req.query);
  // Top rated needs a floor on votes, or one-vote titles lead the list.
  // Newest first stops at today (unreleased placeholders otherwise lead).
  const today = new Date().toISOString().slice(0, 10);
  const query = {
    ...q,
    ...(q.sort_by === "vote_average.desc" ? { "vote_count.gte": q.type === "movie" ? 500 : 200 } : {}),
    ...(q.sort_by === "primary_release_date.desc" ? { "primary_release_date.lte": today, "vote_count.gte": 5 } : {}),
    ...(q.sort_by === "first_air_date.desc" ? { "first_air_date.lte": today, "vote_count.gte": 5 } : {}),
  };
  const r = await remember(`tdisc:${JSON.stringify(query)}`, 30 * 60_000, () =>
    plug<{ ok: boolean; error?: string; items: TmdbBrief[] }>("GET", "/hub/tmdb/discover", { query, timeoutMs: 40_000 }));
  if (!r.ok) throw Object.assign(new Error(r.error || "TMDb 发现失败"), { statusCode: 502 });
  return { items: await withLib(r.items.map(tmdbItem)) };
});

// Related to one work, loaded after the detail: recommendations, its collection (movies) and keywords.
app.get<{ Params: { type: string; id: string } }>("/v1/media/:type/:id/related", async (req) => {
  const type = kindOf(req.params.type);
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const [rec, extra] = await Promise.all([
    remember(`rec:${type}:${id}`, 6 * 3600_000, () => mp<MpRec[]>("GET", `/tmdb/recommend/${id}/${encodeURIComponent(TYPE_NAME[type])}`, { timeoutMs: 30_000 })).catch(() => [] as MpRec[]),
    remember(`extra:${type}:${id}`, 6 * 3600_000, () =>
      plug<{ ok: boolean; keywords: { id: number; name: string }[]; collection: { id: number; name: string; poster: string | null; parts: TmdbBrief[] } | null }>("GET", "/hub/tmdb/extra", { query: { type, tmdbid: id }, timeoutMs: 30_000 }))
      .catch(() => ({ ok: false, keywords: [], collection: null })),
  ]);
  const recs = await withLib((rec ?? []).filter((m) => m.tmdb_id).map(recBrief));
  const col = extra.collection;
  return {
    recommendations: recs,
    keywords: extra.keywords ?? [],
    collection: col ? { id: col.id, name: col.name, poster: tmdbPath(col.poster), parts: await withLib(col.parts.map(tmdbItem)) } : null,
  };
});

// Bangumi / Douban entries carry no TMDb id: find the TMDb item by title, type and year.
app.get("/v1/media/resolve", async (req) => {
  const q = z.object({ title: z.string().min(1).max(200), year: z.string().max(8).default(""), type: z.enum(["movie", "tv"]).default("tv") }).parse(req.query);
  const list = await mp<MpMedia[]>("GET", "/media/search", { query: { title: q.title, type: "media", page: 1, count: 20 }, timeoutMs: 30_000 });
  const cands = (list ?? []).filter((m) => m.tmdb_id && kindOf(m.type) === q.type);
  const y = Number(q.year) || 0;
  const pick = cands.find((m) => !y || Math.abs(Number(m.year) - y) <= 1) ?? cands[0];
  if (!pick) throw Object.assign(new Error("TMDb 里没找到对应条目"), { statusCode: 404 });
  return { tmdbid: pick.tmdb_id, type: kindOf(pick.type), title: pick.title };
});

// Emby login for the app's direct connection (the app logs in itself and keeps only its token).
app.get("/v1/emby/account", async () => ({ server: config.emby.url, username: config.emby.user, password: config.emby.pass }));

// ---------- resource search & ingest (plugin) ----------

app.get("/v1/sources", async () => remember("sources", 10 * 60_000, () => plug("GET", "/hub/sources")));

// Prowlarr indexer management (Settings → 索引源): browse definitions, add public ones, enable/disable, delete.
app.get("/v1/prowlarr/catalog", async () => remember("prowlarr:catalog", 30 * 60_000, () => plug("GET", "/hub/prowlarr/catalog", { timeoutMs: 90_000 })));

const IndexerAction = z.object({ action: z.enum(["add", "update", "delete"]), definition: z.string().max(80).optional(), id: z.number().int().positive().optional(), enable: z.boolean().optional() });
app.post("/v1/prowlarr", async (req) => {
  const b = IndexerAction.parse(req.body);
  const body = b.action === "add" ? { definition: b.definition } : { id: b.id, enable: b.enable };
  const res = await plug<{ ok: boolean }>("POST", `/hub/prowlarr/${b.action}`, { body, timeoutMs: 90_000 });
  memo.delete("sources");
  memo.delete("prowlarr:catalog");
  req.log.info({ ...b, ok: res.ok }, "prowlarr indexer");
  return res;
});

const SearchBody = z.object({
  tmdbid: z.number().int().positive().optional(),
  type: z.enum(["movie", "tv"]).default("tv"),
  season: z.number().int().min(0).optional(),
  keyword: z.string().max(200).optional(),
  keywords: z.array(z.string().max(200)).max(4).optional(),
  sources: z.array(z.string().max(40)).max(40).optional(),
});

app.post("/v1/search", async (req) => {
  const body = SearchBody.parse(req.body);
  if (!body.tmdbid && !body.keyword && !body.keywords?.length) throw Object.assign(new Error("需要作品或关键词"), { statusCode: 400 });
  const t0 = Date.now();
  const res = await plug<{ results?: unknown[] }>("POST", "/hub/search", { body, timeoutMs: 150_000 });
  req.log.info({ tmdbid: body.tmdbid, season: body.season, sources: body.sources?.length ?? 0, results: res.results?.length ?? 0, ms: Date.now() - t0 }, "search");
  return res;
});

const IngestBody = z.object({
  kind: z.enum(["media", "av", "hentai"]).default("media"),
  magnet: z.string().startsWith("magnet:").max(4000),
  title: z.string().max(500).default(""),
  tmdbid: z.number().int().positive().optional(),
  type: z.enum(["movie", "tv"]).default("tv"),
  season: z.number().int().min(0).optional(),
  dryRun: z.boolean().default(false),
});

app.post("/v1/ingest", async (req) => {
  const b = IngestBody.parse(req.body);
  let out: unknown;
  if (b.kind === "av") {
    out = await plug("POST", "/av/add", { body: { items: [b.magnet], dry_run: b.dryRun }, timeoutMs: 90_000 });
  } else if (b.kind === "hentai") {
    out = await plug("POST", "/hentai/submit", { body: { magnet: b.magnet, title: b.title }, timeoutMs: 90_000 });
  } else {
    if (!b.tmdbid) throw Object.assign(new Error("影视入库需要先选定作品"), { statusCode: 400 });
    out = await plug("POST", "/submit", {
      body: { magnet: b.magnet, tmdbid: b.tmdbid, type: b.type, season: b.season, title: b.title, dry_run: b.dryRun },
      timeoutMs: 90_000,
    });
  }
  req.log.info({ kind: b.kind, tmdbid: b.tmdbid, season: b.season, dry: b.dryRun, ok: (out as { ok?: boolean })?.ok }, "ingest");
  return out;
});

// 自动入库: the plugin's batch in auto mode — aired seasons / movies are searched, picked by the 选片 policy and
// downloaded; airing seasons become a subscription. Returns a job id to poll.
app.post("/v1/ingest/auto", async (req) => {
  const b = z.object({ tmdbid: z.number().int().positive(), type: z.enum(["movie", "tv"]), seasons: z.array(z.number().int().min(0)).max(50).optional() }).parse(req.body);
  const res = await plug<{ ok: boolean; job?: string; error?: string }>("POST", "/batch", { body: { items: [{ tmdbid: b.tmdbid, type: b.type, ...(b.seasons ? { seasons: b.seasons } : {}) }], mode: "auto" } });
  req.log.info({ ...b, job: res.job, ok: res.ok }, "ingest auto");
  return res;
});

app.get<{ Params: { job: string } }>("/v1/ingest/auto/:job", async (req) => {
  const job = z.string().regex(/^[0-9a-f]{8}$/).parse(req.params.job);
  return plug("GET", "/batch", { query: { job } });
});

// ---------- pipeline ----------

app.get("/v1/pipeline", async (req) => {
  const q = z.object({ limit: z.coerce.number().int().min(1).max(300).default(60) }).parse(req.query);
  return plug("GET", "/hub/pipeline", { query: { limit: q.limit }, timeoutMs: 40_000 });
});

app.post<{ Params: { hash: string } }>("/v1/pipeline/:hash/retry", async (req) => {
  const hash = z.string().regex(/^[0-9a-f]{40}$/).parse(req.params.hash);
  const { mode } = z.object({ mode: z.enum(["strm", "buffer", "offline"]).default("strm") }).parse(req.body ?? {});
  return plug("POST", "/retry", { query: { hash, mode } });
});

app.post<{ Params: { hash: string } }>("/v1/pipeline/:hash/cancel", async (req) => {
  const hash = z.string().regex(/^[0-9a-f]{40}$/).parse(req.params.hash);
  return plug("POST", "/cancel", { body: { hashes: [hash] }, timeoutMs: 60_000 });
});

app.post("/v1/pipeline/run", async () => plug("POST", "/run"));

// Drop ended task records from the 入库 list (active ones must be cancelled first).
app.post("/v1/pipeline/remove", async (req) => {
  const { hashes } = z.object({ hashes: z.array(z.string().regex(/^[0-9a-f]{40}$/)).min(1).max(200) }).parse(req.body);
  return plug("POST", "/hub/task/remove", { body: { hashes } });
});

// AV row actions: cancel a 115 offline / scraping entry (optionally with its 115 files) or drop a done record.
app.post("/v1/av/cancel", async (req) => {
  const b = z.object({ key: z.string().min(1).max(400), files: z.boolean().default(false) }).parse(req.body);
  return plug("POST", "/hub/av/cancel", { body: b, timeoutMs: 60_000 });
});

app.get<{ Params: { hash: string } }>("/v1/pipeline/:hash/events", async (req) => {
  const hash = z.string().regex(/^[0-9a-f]{40}$/).parse(req.params.hash);
  return plug("GET", "/hub/task/events", { query: { hash } });
});

// Download detail for one task: per-file progress while buffering on the NAS, 115 offline state otherwise.
app.get<{ Params: { hash: string } }>("/v1/pipeline/:hash/files", async (req) => {
  const hash = z.string().regex(/^[0-9a-f]{40}$/).parse(req.params.hash);
  return plug("GET", "/hub/task/files", { query: { hash }, timeoutMs: 40_000 });
});

// Other releases for the same work / season / episodes, scored, with the current and blacklisted ones marked.
app.get<{ Params: { hash: string } }>("/v1/pipeline/:hash/candidates", async (req) => {
  const hash = z.string().regex(/^[0-9a-f]{40}$/).parse(req.params.hash);
  return plug("GET", "/hub/task/candidates", { query: { hash }, timeoutMs: 90_000 });
});

// Swap a stuck or unwanted release: cancel + blacklist the old one, submit the new one into the same folder.
app.post<{ Params: { hash: string } }>("/v1/pipeline/:hash/reselect", async (req) => {
  const hash = z.string().regex(/^[0-9a-f]{40}$/).parse(req.params.hash);
  const b = z.object({ magnet: z.string().startsWith("magnet:").max(4000), title: z.string().max(400).default(""), buffer: z.boolean().default(false) }).parse(req.body);
  const res = await plug<{ ok: boolean; hash?: string }>("POST", "/hub/task/reselect", { body: { hash, ...b }, timeoutMs: 120_000 });
  req.log.info({ hash, next: res.hash, buffer: b.buffer, ok: res.ok }, "reselect");
  return res;
});

app.get("/v1/blacklist", async () => plug("GET", "/hub/blacklist"));

app.post("/v1/blacklist/remove", async (req) => {
  const b = z.object({ hashes: z.array(z.string().regex(/^[0-9a-f]{40}$/)).min(1).max(200) }).parse(req.body);
  return plug("POST", "/hub/blacklist/remove", { body: b });
});

// A task landed under the wrong work (e.g. the 2024 concert under the 2026 entry): move its files and rebuild strm.
app.post<{ Params: { hash: string } }>("/v1/pipeline/:hash/retarget", async (req) => {
  const hash = z.string().regex(/^[0-9a-f]{40}$/).parse(req.params.hash);
  const b = z.object({ tmdbid: z.number().int().positive(), type: z.enum(["movie", "tv"]), season: z.number().int().min(0).optional(), dryRun: z.boolean().default(false) }).parse(req.body);
  const res = await plug<{ ok: boolean }>("POST", "/retarget", { body: { hash, tmdbid: b.tmdbid, type: b.type, season: b.season, dry_run: b.dryRun }, timeoutMs: 120_000 });
  req.log.info({ hash, ...b, ok: res.ok }, "retarget");
  return res;
});

app.post("/v1/av/retry", async (req) => {
  const { name } = z.object({ name: z.string().max(200).optional() }).parse(req.body ?? {});
  return plug("POST", "/av/retry", { body: name ? { name } : {} });
});

// ---------- downloaders ----------

app.get("/v1/qb", async (req) => {
  const q = z.object({ filter: z.enum(["all", "downloading", "seeding", "completed", "paused", "active", "inactive", "stalled", "errored"]).default("all") }).parse(req.query);
  return plug("GET", "/hub/qb", { query: { filter: q.filter } });
});

app.post("/v1/qb/action", async (req) => {
  const b = z.object({
    hashes: z.array(z.string().regex(/^[0-9a-f]{40}$/)).min(1).max(100),
    action: z.enum(["pause", "resume", "delete", "recheck", "reannounce"]),
    deleteFiles: z.boolean().default(false),
  }).parse(req.body);
  return plug("POST", "/hub/qb/action", { body: { hashes: b.hashes, action: b.action, delete_files: b.deleteFiles } });
});

app.get("/v1/offline", async () => plug("GET", "/hub/offline", { query: { pages: 3 }, timeoutMs: 40_000 }));

app.post("/v1/offline/delete", async (req) => {
  const b = z.object({ hashes: z.array(z.string().regex(/^[0-9a-f]{40}$/)).min(1).max(100) }).parse(req.body);
  return plug("POST", "/hub/offline/delete", { body: b });
});

app.get("/v1/openlist", async () => plug("GET", "/hub/openlist", { timeoutMs: 40_000 }));

// ---------- Emby ----------

interface EmbyItem {
  Id: string;
  Name?: string;
  Type?: string;
  ProductionYear?: number;
  SeriesName?: string;
  SeriesId?: string;
  ParentIndexNumber?: number;
  IndexNumber?: number;
  ImageTags?: Record<string, string>;
  SeriesPrimaryImageTag?: string;
  BackdropImageTags?: string[];
  ProviderIds?: Record<string, string>;
  DateCreated?: string;
  ChildCount?: number;
  RecursiveItemCount?: number;
  Overview?: string;
  Path?: string;
  Genres?: string[];
  CommunityRating?: number;
  RunTimeTicks?: number;
  PremiereDate?: string;
  Status?: string;
  UserData?: { Played?: boolean; PlaybackPositionTicks?: number };
}

const embyGet = <T>(p: string, query: Record<string, string | number | undefined> = {}) =>
  plug<T>("GET", "/hub/emby/get", {
    query: { path: p, query: new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)])).toString() },
    timeoutMs: 30_000,
  });

const FIELDS = "ProductionYear,ProviderIds,DateCreated,ChildCount,RecursiveItemCount,Path,PremiereDate";

function embyBrief(i: EmbyItem) {
  const isEp = i.Type === "Episode";
  return {
    id: i.Id,
    name: i.Name ?? "",
    type: i.Type ?? "",
    year: i.ProductionYear ?? null,
    series: i.SeriesName ?? null,
    seriesId: i.SeriesId ?? null,
    season: i.ParentIndexNumber ?? null,
    episode: i.IndexNumber ?? null,
    // Episodes without their own still fall back to the series poster.
    image: i.ImageTags?.Primary ? { id: i.Id, tag: i.ImageTags.Primary } : isEp && i.SeriesId && i.SeriesPrimaryImageTag ? { id: i.SeriesId, tag: i.SeriesPrimaryImageTag } : null,
    tmdbid: i.ProviderIds?.Tmdb ?? null,
    added: i.DateCreated ?? null,
    count: i.RecursiveItemCount ?? i.ChildCount ?? null,
    scraped: Boolean(i.ImageTags?.Primary) && Boolean(i.ProviderIds && Object.keys(i.ProviderIds).length),
  };
}

app.get("/v1/emby/views", async () => {
  const folders = await remember("emby:views", 5 * 60_000, () =>
    embyGet<{ Name: string; ItemId: string; CollectionType?: string; Locations?: string[] }[]>("/Library/VirtualFolders"));
  return {
    views: (folders ?? []).map((f) => ({ id: f.ItemId, name: f.Name, type: f.CollectionType ?? "", adult: ADULT_LIBS.has(f.Name) })),
  };
});

app.get("/v1/emby/latest", async (req) => {
  const q = z.object({ parent: z.string().regex(/^\w+$/).optional(), limit: z.coerce.number().int().min(1).max(100).default(30), adult: z.string().optional().transform((v) => v === "1" || v === "true") }).parse(req.query);
  const views = q.parent || q.adult ? [] : (await embyGet<{ Name: string; ItemId: string }[]>("/Library/VirtualFolders").catch(() => [])) ?? [];
  const parents = q.parent ? [q.parent] : views.filter((v) => !ADULT_LIBS.has(v.Name)).map((v) => v.ItemId);
  const lists = await Promise.all((parents.length ? parents : [undefined]).map((p) =>
    embyGet<{ Items: EmbyItem[] }>("/Items", {
      Recursive: "true", ParentId: p, IncludeItemTypes: "Movie,Episode", SortBy: "DateCreated", SortOrder: "Descending",
      Limit: q.limit, Fields: FIELDS, EnableImageTypes: "Primary",
    }).then((r) => r?.Items ?? []).catch(() => [] as EmbyItem[])));
  const items = lists.flat().sort((a, b) => String(b.DateCreated).localeCompare(String(a.DateCreated))).slice(0, q.limit);
  return { items: items.map(embyBrief) };
});

app.get("/v1/emby/items", async (req) => {
  const q = z.object({
    parent: z.string().regex(/^\w+$/).optional(),
    q: z.string().max(100).optional(),
    start: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(100).default(40),
    sort: z.enum(["added", "name", "year"]).default("added"),
  }).parse(req.query);
  const sortBy = { added: "DateCreated", name: "SortName", year: "ProductionYear,SortName" }[q.sort];
  const r = await embyGet<{ Items: EmbyItem[]; TotalRecordCount: number }>("/Items", {
    Recursive: "true", ParentId: q.parent, SearchTerm: q.q, IncludeItemTypes: "Movie,Series", StartIndex: q.start, Limit: q.limit,
    SortBy: sortBy, SortOrder: q.sort === "name" ? "Ascending" : "Descending", Fields: FIELDS,
  });
  return { total: r?.TotalRecordCount ?? 0, items: (r?.Items ?? []).map(embyBrief) };
});

app.get<{ Params: { id: string } }>("/v1/emby/item/:id", async (req) => {
  const id = z.string().regex(/^\w+$/).parse(req.params.id);
  const r = await embyGet<{ Items: EmbyItem[] }>("/Items", { Ids: id, Fields: `${FIELDS},Overview,Genres,CommunityRating,Status` });
  const it = r?.Items?.[0];
  if (!it) throw Object.assign(new Error("Emby 里没有这个条目"), { statusCode: 404 });
  let seasons: { season: number; episodes: ReturnType<typeof embyBrief>[] }[] = [];
  if (it.Type === "Series") {
    const eps = (await embyGet<{ Items: EmbyItem[] }>(`/Shows/${id}/Episodes`, { Fields: "ProviderIds,DateCreated,Path,PremiereDate", EnableImageTypes: "Primary" }))?.Items ?? [];
    const by = new Map<number, ReturnType<typeof embyBrief>[]>();
    for (const e of eps) {
      const s = e.ParentIndexNumber ?? 0;
      by.set(s, [...(by.get(s) ?? []), { ...embyBrief(e), scraped: Boolean(e.Name && !/^(第\s*\d+\s*集|Episode \d+|.* S\d+E\d+)$/.test(e.Name)) }]);
    }
    seasons = [...by.entries()].sort((a, b) => a[0] - b[0]).map(([season, episodes]) => ({ season, episodes }));
  }
  return {
    item: {
      ...embyBrief(it),
      overview: it.Overview ?? "",
      genres: it.Genres ?? [],
      rating: it.CommunityRating ?? null,
      status: it.Status ?? "",
      path: it.Path ?? "",
      providers: it.ProviderIds ?? {},
      backdrop: it.BackdropImageTags?.[0] ? { id: it.Id, tag: it.BackdropImageTags[0] } : null,
    },
    seasons,
  };
});

app.post<{ Params: { id: string } }>("/v1/emby/item/:id/refresh", async (req) => {
  const id = z.string().regex(/^\w+$/).parse(req.params.id);
  const { replace } = z.object({ replace: z.boolean().default(false) }).parse(req.body ?? {});
  return plug("POST", "/hub/emby/refresh", { body: { id, replace } });
});

// Delete an Emby item (movie / series / season / episode): its strm and folder in the library, the Emby
// record and, with files=true, the 115 files the strm point at. dryRun (default) returns the plan only.
app.post<{ Params: { id: string } }>("/v1/emby/item/:id/delete", async (req) => {
  const id = z.string().regex(/^\w+$/).parse(req.params.id);
  const b = z.object({ files: z.boolean().default(false), dryRun: z.boolean().default(true) }).parse(req.body ?? {});
  req.log.warn({ id, files: b.files, dry: b.dryRun }, "emby delete");
  return plug("POST", "/hub/emby/delete", { body: { id, files: b.files, dry_run: b.dryRun }, timeoutMs: 180_000 });
});

app.post("/v1/emby/scan", async () => plug("POST", "/hub/emby/scan"));
app.get("/v1/emby/activity", async () => plug("GET", "/hub/emby/activity"));

// ---------- catalog (AV / 里番 index) and online stream sources ----------

registerCatalog(app, embyGet);

// ---------- subtitle files next to the video (115, via the plugin) ----------

app.get("/v1/subs/list", async (req) => {
  const { url } = z.object({ url: z.string().min(1).max(2000) }).parse(req.query);
  return plug("GET", "/hub/subs/list", { query: { url }, timeoutMs: 30_000 });
});

app.get("/v1/subs/file", async (req, reply) => {
  const { path: p } = z.object({ path: z.string().min(1).max(2000) }).parse(req.query);
  const f = await plugBytes("/hub/subs/file", { path: p });
  if (!f) return reply.code(404).send();
  return reply.type(f.type).header("cache-control", "private, max-age=3600").send(f.body);
});

// ---------- images ----------

app.get<{ Params: { id: string } }>("/v1/img/emby/:id", async (req, reply) => {
  const id = z.string().regex(/^\w+$/).parse(req.params.id);
  const q = z.object({ type: z.enum(["Primary", "Backdrop", "Thumb", "Logo"]).default("Primary"), w: z.coerce.number().int().min(40).max(1600).default(400), tag: z.string().regex(/^\w*$/).default("") }).parse(req.query);
  const img = await embyImage(id, q.type, Math.ceil(q.w / 100) * 100, q.tag);
  if (!img) return reply.code(404).send();
  return reply.type(img.type).header("cache-control", "private, max-age=604800").send(img.body);
});

app.get("/v1/img/ext", async (req, reply) => {
  const { u } = z.object({ u: z.string().url().max(500) }).parse(req.query);
  const img = await extImage(u);
  if (!img) return reply.code(404).send();
  return reply.type(img.type).header("cache-control", "private, max-age=2592000").send(img.body);
});

app.get<{ Params: { size: string; file: string } }>("/v1/img/tmdb/:size/:file", async (req, reply) => {
  const size = z.enum(["w185", "w342", "w500", "w780", "original"]).parse(req.params.size);
  const file = z.string().regex(/^[A-Za-z0-9_-]+\.(jpg|jpeg|png|webp)$/).parse(req.params.file);
  const img = await tmdbImage(size, file);
  if (!img) return reply.code(404).send();
  return reply.type(img.type).header("cache-control", "private, max-age=2592000").send(img.body);
});

// ---------- subscriptions & MP history ----------

app.get("/v1/subscriptions", async () => ({ items: ((await mp<MpSub[]>("GET", "/subscribe/")) ?? []).map(sub) }));

// Subscriptions from the auto-subscribe helper are Bangumi-sourced (no TMDb id); the plugin maps every subscription
// to its TMDb id + season, so "already subscribed" and duplicate checks work across sources.
type SubIdentity = { id: number; tmdbid: number | null; season: number | null; offset: number };
const subIdentities = () =>
  remember("sub:identity", 5 * 60_000, () => plug<{ items: SubIdentity[] }>("GET", "/sub_identity", { timeoutMs: 90_000 })
    .then((r) => new Map((r.items ?? []).map((i) => [i.id, i]))).catch(() => new Map<number, SubIdentity>()));
function withIdentity<T extends { id: number; tmdbid: number | null; season: number | null }>(list: T[], ids: Map<number, SubIdentity>): T[] {
  return list.map((s) => {
    const i = ids.get(s.id);
    return i?.tmdbid ? { ...s, tmdbid: s.tmdbid ?? i.tmdbid, season: i.season ?? s.season } : s;
  });
}

app.post("/v1/subscriptions", async (req) => {
  const b = z.object({
    tmdbid: z.number().int().positive(),
    type: z.enum(["movie", "tv"]),
    title: z.string().min(1).max(200),
    year: z.string().max(8).default(""),
    season: z.number().int().min(0).optional(),
    startEpisode: z.number().int().min(1).optional(),
  }).parse(req.body);
  // Same work (and season) already subscribed from any source → answer with that one instead of adding a duplicate.
  const ids = await subIdentities();
  const offset = Math.max(0, (b.startEpisode ?? 1) - 1);
  const existing = withIdentity(((await mp<MpSub[]>("GET", "/subscribe/")) ?? []).map(sub), ids)
    .find((s) => s.tmdbid === b.tmdbid && s.type === b.type && (b.type === "movie" || (s.season === (b.season ?? 1) && (ids.get(s.id)?.offset ?? 0) === offset)));
  if (existing) return { ok: true, existing: true, message: "已经订阅过了", id: existing.id };
  const res = await mpRaw<{ success: boolean; message?: string; data?: { id?: number } }>("POST", "/subscribe/", {
    body: {
      name: b.title, year: b.year, type: TYPE_NAME[b.type], media_source: "themoviedb", media_id: String(b.tmdbid), tmdbid: b.tmdbid,
      ...(b.type === "tv" ? { season: b.season ?? 1 } : {}), ...(b.startEpisode ? { start_episode: b.startEpisode } : {}),
    },
    timeoutMs: 60_000,
  });
  return { ok: res.success, message: res.message ?? "", id: res.data?.id ?? null };
});

app.delete<{ Params: { id: string } }>("/v1/subscriptions/:id", async (req) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const res = await mpRaw<{ success: boolean; message?: string }>("DELETE", `/subscribe/${id}`);
  return { ok: res.success, message: res.message ?? "" };
});

// Per-episode state of one subscription (not aired / missing / submitted / downloading / stuck / failed / in library).
app.get<{ Params: { id: string } }>("/v1/subscriptions/:id", async (req) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  return plug("GET", "/hub/subscription", { query: { id }, timeoutMs: 60_000 });
});

app.post<{ Params: { id: string } }>("/v1/subscriptions/:id/search", async (req) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const res = await mpRaw<{ success: boolean; message?: string }>("GET", `/subscribe/search/${id}`, { timeoutMs: 20_000 });
  return { ok: res.success, message: res.message ?? "" };
});

interface MpDownload { id: number; title?: string; year?: string; type?: string; seasons?: string; episodes?: string; poster?: string; torrent_name?: string; torrent_site?: string; date?: string; username?: string; download_hash?: string; path?: string; media_source?: string; media_id?: string }

app.get("/v1/history", async (req) => {
  const q = z.object({ page: z.coerce.number().int().min(1).default(1) }).parse(req.query);
  const [list, tasks] = await Promise.all([
    mp<MpDownload[]>("GET", "/history/download", { query: { page: q.page, count: 30 } }).then((l) => l ?? []),
    // The plugin's task records know the TMDb id per torrent hash (MP history often only has Bangumi ids).
    remember("plugin:tasks", 60_000, () => plug<{ hash: string; meta?: { tmdbid?: number; type?: string } }[]>("GET", "/tasks", { query: { limit: 400 } })).catch(() => []),
  ]);
  const byHash = new Map(tasks.map((t) => [t.hash, t.meta]));
  return {
    items: list.map((d) => ({
      id: d.id, title: d.title ?? "", year: d.year ?? "", type: kindOf(d.type), se: `${d.seasons ?? ""}${d.episodes ?? ""}`,
      poster: posterPath(d.poster), torrent: d.torrent_name ?? "", site: d.torrent_site ?? "",
      date: d.date ?? "", by: d.username ?? "", hash: d.download_hash ?? "", path: d.path ?? "",
      source: d.media_source ?? "", sourceId: d.media_id ?? "",
      tmdbid: d.media_source === "themoviedb" && d.media_id ? Number(d.media_id) : byHash.get(d.download_hash ?? "")?.tmdbid ?? null,
    })),
  };
});

// ---------- usage events (埋点) ----------

const EventProp = z.union([z.string().max(200), z.number(), z.boolean(), z.null()]);

app.post("/v1/events", async (req) => {
  const body = z
    .object({ events: z.array(z.object({ e: z.string().max(80), t: z.string().max(40), s: z.string().max(20), p: z.record(z.string().max(40), EventProp).optional() })).max(500) })
    .parse(req.body);
  if (!body.events.length) return { ok: true };
  const dir = path.join(config.dataDir, "events");
  await mkdir(dir, { recursive: true });
  const v = String(req.headers["x-app-version"] ?? "").slice(0, 60);
  await appendFile(path.join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`), body.events.map((ev) => JSON.stringify({ ...ev, v })).join("\n") + "\n");
  return { ok: true };
});

// A day's events: counts per name, failures, and the latest few (optionally of one name).
app.get("/admin/events", async (req) => {
  const q = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), name: z.string().optional() }).parse(req.query);
  const day = q.day ?? new Date().toISOString().slice(0, 10);
  const raw = await readFile(path.join(config.dataDir, "events", `${day}.jsonl`), "utf8").catch(() => "");
  const events = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as { e: string; p?: Record<string, unknown> });
  const counts: Record<string, { n: number; failed: number }> = {};
  for (const ev of events) {
    const c = (counts[ev.e] ??= { n: 0, failed: 0 });
    c.n += 1;
    if (ev.p?.ok === false) c.failed += 1;
  }
  return { day, total: events.length, counts, latest: (q.name ? events.filter((e) => e.e === q.name) : events).slice(-40) };
});

// Playback speed over the last `days` days, from play_timeline events (app lib/playStats.ts):
// p50/p90 of every startup hop (ms since the player opened), overall and split by container,
// resume, prewarm and network; plus seek latency, stalls and the slowest plays.
app.get("/admin/playstats", async (req) => {
  const q = z.object({ days: z.coerce.number().int().min(1).max(60).default(7), version: z.string().max(60).optional() }).parse(req.query);
  type Ev = { e: string; t: string; v?: string; p?: Record<string, unknown> };
  const evs: Ev[] = [];
  for (let i = 0; i < q.days; i++) {
    const day = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10);
    const raw = await readFile(path.join(config.dataDir, "events", `${day}.jsonl`), "utf8").catch(() => "");
    for (const l of raw.split("\n")) if (l) evs.push(JSON.parse(l) as Ev);
  }
  const mine = evs.filter((e) => !q.version || (e.v ?? "").includes(q.version));
  const plays = mine.filter((e) => e.e === "play_timeline" && e.p && !e.p.failed);
  const HOPS = ["item", "info", "subs", "plan", "n_sourceOpened", "n_containerOpened", "n_streamsProbed", "n_routed", "n_ready", "n_presenting", "frame",
    "sourceOpen", "firstData", "connect", "openInput", "findStreamInfo", "demuxTotal"];
  const pct = (xs: number[], p: number) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  };
  const summarize = (list: Ev[]) => {
    const out: Record<string, { p50: number | null; p90: number | null; n: number }> = {};
    for (const h of HOPS) {
      const xs = list.map((e) => e.p?.[h]).filter((x): x is number => typeof x === "number");
      if (xs.length) out[h] = { p50: pct(xs, 50), p90: pct(xs, 90), n: xs.length };
    }
    return { plays: list.length, hops: out };
  };
  const split = (key: (e: Ev) => string) => {
    const g = new Map<string, Ev[]>();
    for (const e of plays) g.set(key(e), [...(g.get(key(e)) ?? []), e]);
    return Object.fromEntries([...g].map(([k, list]) => [k, { plays: list.length, frame: summarize(list).hops.frame ?? null, findStreamInfo: summarize(list).hops.findStreamInfo ?? null }]));
  };
  const seeks = mine.filter((e) => e.e === "play_seek").map((e) => Number(e.p?.ms)).filter(Number.isFinite);
  return {
    days: q.days,
    overall: summarize(plays),
    byContainer: split((e) => String(e.p?.container ?? "?")),
    byResume: split((e) => (e.p?.resume ? "resume" : "start")),
    byPrewarm: split((e) => (Number(e.p?.prewarm) > 0 ? "prewarmed" : "cold")),
    byNet: split((e) => String(e.p?.net ?? "?")),
    byKind: split((e) => String(e.p?.kind ?? "?")),
    seek: { n: seeks.length, p50: pct(seeks, 50), p90: pct(seeks, 90) },
    stalls: mine.filter((e) => e.e === "play_stall").length,
    failed: mine.filter((e) => e.e === "play_timeline" && e.p?.failed).map((e) => ({ t: e.t, err: e.p?.err })).slice(-10),
    slowest: [...plays].sort((a, b) => Number(b.p?.frame ?? 0) - Number(a.p?.frame ?? 0)).slice(0, 8).map((e) => ({ t: e.t, v: e.v, ...e.p })),
    // Before runtime 4 only play_start existed: plan → first frame (ms) and, later, open → frame (fromOpen).
    legacy: { n: mine.filter((e) => e.e === "play_start").length, ms: pct(mine.filter((e) => e.e === "play_start").map((e) => Number(e.p?.ms)).filter(Number.isFinite), 50) },
  };
});

// Uploaded logs, newest first (read one on the server: $DATA_DIR/logs/<id>.log).
app.get("/admin/logs", async () => {
  const dir = path.join(config.dataDir, "logs");
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith(".json"));
  const out: { id: string; at?: string }[] = await Promise.all(names.map(async (n) => ({ id: n.slice(0, -5), ...(JSON.parse(await readFile(path.join(dir, n), "utf8")) as { at?: string }) })));
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 30);
});

// ---------- app logs (Settings → 上传日志) ----------

app.post("/v1/logs", async (req) => {
  const b = z.object({ log: z.string().max(4_000_000), meta: z.record(z.string(), z.unknown()).default({}) }).parse(req.body);
  const id = randomUUID().slice(0, 8);
  const dir = path.join(config.dataDir, "logs");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${id}.log`), b.log);
  await writeFile(path.join(dir, `${id}.json`), JSON.stringify({ ...b.meta, at: new Date().toISOString() }));
  req.log.info({ logId: id, bytes: b.log.length }, "log uploaded");
  return { id };
});

// ---------- feedback (long-press → 反馈问题) ----------
// One JSON file per report in $DATA_DIR/feedback: what the user said, which item, and a snapshot of the Emby
// record (path, provider ids, images, media streams) taken at submit time, so library problems can be sorted
// out later without the phone. Optional log upload id links the app log.

const FEEDBACK_KINDS = ["刮削信息错误", "认错作品", "海报图片未加载", "分季集号错", "资源画质问题", "字幕问题", "音轨问题", "播放失败", "重复条目", "缺集", "其他"] as const;
const feedbackDir = () => path.join(config.dataDir, "feedback");

interface EmbySnap { Id: string; Name?: string; Type?: string; Path?: string; ProductionYear?: number; ProviderIds?: Record<string, string>; ImageTags?: Record<string, string>; SeriesName?: string; SeriesId?: string; ParentIndexNumber?: number; IndexNumber?: number; MediaSources?: { Path?: string; Container?: string; Size?: number; MediaStreams?: { Type?: string; Codec?: string; Language?: string; DisplayTitle?: string; IsExternal?: boolean }[] }[] }

async function embySnapshot(id: string) {
  try {
    const r = await plug<{ Items?: EmbySnap[] }>("GET", "/hub/emby/get", { query: { path: "/Items", query: `Ids=${encodeURIComponent(id)}&Recursive=true&Fields=Path,ProviderIds,MediaSources,ProductionYear,Overview` }, timeoutMs: 20_000 });
    const it = r.Items?.[0];
    if (!it) return null;
    const src = it.MediaSources?.[0];
    return {
      id: it.Id, name: it.Name, type: it.Type, year: it.ProductionYear, path: it.Path, providers: it.ProviderIds ?? {},
      images: Object.keys(it.ImageTags ?? {}), series: it.SeriesName, seriesId: it.SeriesId, season: it.ParentIndexNumber, episode: it.IndexNumber,
      media: src ? { container: src.Container, size: src.Size, path: src.Path,
        streams: (src.MediaStreams ?? []).map((m) => [m.Type, m.Codec, m.Language, m.IsExternal ? "external" : "", m.DisplayTitle].filter(Boolean).join(" ")) } : null,
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

app.post("/v1/feedback", async (req) => {
  const b = z.object({
    kinds: z.array(z.enum(FEEDBACK_KINDS)).min(1).max(FEEDBACK_KINDS.length),
    reason: z.string().max(2000).default(""),
    item: z.object({ embyId: z.string().max(64).optional(), title: z.string().max(300), subtitle: z.string().max(300).optional(), key: z.string().max(200).optional(), tmdbid: z.number().int().optional(), type: z.string().max(20).optional() }),
    logId: z.string().max(16).optional(),
    version: z.string().max(40).optional(),
  }).parse(req.body);
  const id = randomUUID().slice(0, 8);
  const rec = { id, at: new Date().toISOString(), status: "open", ...b, emby: b.item.embyId ? await embySnapshot(b.item.embyId) : null };
  await mkdir(feedbackDir(), { recursive: true });
  await writeFile(path.join(feedbackDir(), `${id}.json`), JSON.stringify(rec, null, 1));
  req.log.info({ feedback: id, kinds: b.kinds, item: b.item.embyId ?? b.item.title, logId: b.logId }, "feedback");
  return { ok: true, id };
});

async function listFeedback() {
  const names = (await readdir(feedbackDir()).catch(() => [] as string[])).filter((n) => n.endsWith(".json"));
  const all = await Promise.all(names.map(async (n) => JSON.parse(await readFile(path.join(feedbackDir(), n), "utf8")) as { id: string; at: string; status: string; kinds: string[] }));
  return all.sort((a, b) => b.at.localeCompare(a.at));
}

// The app's own list (Settings → 问题反馈): newest first, with status and the resolution note.
app.get("/v1/feedback", async (req) => {
  const q = z.object({ status: z.enum(["open", "done", "all"]).default("all") }).parse(req.query);
  const all = await listFeedback();
  return { items: all.filter((f) => q.status === "all" || f.status === q.status).slice(0, 200) };
});

app.post<{ Params: { id: string } }>("/v1/feedback/:id", async (req) => {
  const id = z.string().regex(/^[0-9a-f-]{8}$/).parse(req.params.id);
  const b = z.object({ status: z.enum(["open", "done", "wontfix"]).optional(), note: z.string().max(2000).optional() }).parse(req.body);
  const file = path.join(feedbackDir(), `${id}.json`);
  const rec = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  Object.assign(rec, b, { updated: new Date().toISOString() });
  await writeFile(file, JSON.stringify(rec, null, 1));
  return { ok: true };
});

// Summary for working through the reports: counts per kind / library / status.
app.get("/admin/feedback", async () => {
  const all = await listFeedback();
  const count = (f: (x: Record<string, unknown>) => string[]) => all.reduce<Record<string, number>>((m, x) => { for (const k of f(x)) m[k] = (m[k] ?? 0) + 1; return m; }, {});
  return {
    total: all.length,
    byStatus: count((x) => [String(x.status)]),
    byKind: count((x) => (x.kinds as string[]) ?? []),
    byLibrary: count((x) => [String(((x.emby as { path?: string } | null)?.path ?? "").split("/")[3] ?? "?")]),
    items: all,
  };
});

// ---------- Expo Updates (OTA) ----------

app.get("/updates/manifest", async (req, reply) => {
  const h = req.headers;
  const platform = String(h["expo-platform"] ?? "");
  const runtimeVersion = String(h["expo-runtime-version"] ?? "");
  const current = typeof h["expo-current-update-id"] === "string" ? h["expo-current-update-id"] : undefined;
  reply.header("expo-protocol-version", "1").header("expo-sfv-version", "0").header("cache-control", "private, max-age=0");
  if (platform !== "ios" && platform !== "android") return reply.code(400).send({ error: "bad expo-platform" });
  if (String(h["expo-protocol-version"] ?? "0") !== "1") return reply.code(406).send({ error: "protocol v1 only" });
  const res = await manifestResponse({ platform, runtimeVersion, currentUpdateId: current, accept: String(h.accept ?? "") });
  req.log.info({ platform, runtimeVersion, current, served: res?.updateId ?? null }, "updates manifest");
  if (!res) return reply.code(204).send();
  return reply.type(res.contentType).send(res.body);
});

app.post("/admin/updates", async (req) => {
  const fields: Record<string, string> = {};
  let tarball: Buffer | null = null;
  for await (const part of req.parts()) {
    if (part.type === "file") tarball = await part.toBuffer();
    else fields[part.fieldname] = String(part.value);
  }
  const meta = z.object({ runtimeVersion: z.string(), message: z.string().default(""), commit: z.string().default("") }).parse(fields);
  if (!tarball) throw Object.assign(new Error("missing bundle"), { statusCode: 400 });
  const rec = await storeUpdate({ ...meta, tarball });
  req.log.info({ id: rec.id, runtimeVersion: rec.runtimeVersion, bytes: tarball.length, message: rec.message }, "update published");
  return { id: rec.id, createdAt: rec.createdAt, platforms: Object.keys(rec.manifests) };
});

app.get("/admin/updates", async (req) => {
  const { runtimeVersion } = z.object({ runtimeVersion: z.string() }).parse(req.query);
  return (await listUpdates(runtimeVersion)).map((u) => ({ id: u.id, createdAt: u.createdAt, message: u.message, commit: u.commit }));
});

app.get("/", async () => "mediahub");

await app.listen({ port: config.port, host: config.host });
