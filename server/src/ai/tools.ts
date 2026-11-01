// The assistant's tools. Each one is a call to this server's own /v1 routes (in-process, app.inject with
// the app token), so it reuses their validation, caching, library lookups and errors; outputs are slimmed
// before the model sees them. Tiers:
//   read   — search, details, 发现, people, Emby library and watch history, tasks, subscriptions, health,
//            resource search (Prowlarr + direct sources); AV / 里番 catalogs only when 隐藏内容 is on.
//   write  — ingest a resource the assistant found (by its short ref, never a raw magnet), auto-ingest,
//            subscribe, retry a task, refresh one Emby item. Each is a normal user action in the app.
//   never  — nothing that deletes, cancels, stops a service, changes configuration or reads credentials
//            (e.g. /v1/emby/account) is reachable: only the routes listed here are.
import type { FastifyInstance } from "fastify";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { config } from "../config.ts";
import { readKnowledge, TOPICS, type Topic } from "./knowledge.ts";
import { forget, KINDS, saveMemory, search as searchMemory } from "./memory.ts";

export interface ToolCtx {
  app: FastifyInstance;
  adult: boolean;
  /** resources found by find_resources in this chat, by ref ("r1"…) */
  refs: Record<string, Resource>;
  /** a memory was written (the app shows it) */
  saved: (text: string, replaces?: number) => void;
  /** ask the app to act on its network (cast: an Emby item to a TV; tv: control the TV by DLNA); resolves with what it reports */
  phone: (type: "cast" | "tv", req: Record<string, unknown>) => Promise<{ ok: boolean; error?: string; [k: string]: unknown }>;
  /** past conversations (chat.ts): search titles + questions, read one */
  chats: { list: (query: string, limit: number) => Promise<unknown>; read: (id: number, maxChars: number) => Promise<unknown> };
}

export interface Resource {
  title: string; magnet: string; size: number; seeders: number; source: string; kind: string;
  media: { tmdbid: number; type: "movie" | "tv"; title: string } | null; season: number | null; adultKind?: "av" | "hentai";
}

class ToolError extends Error {}

async function call(ctx: ToolCtx, method: "GET" | "POST" | "PUT" | "DELETE", url: string, body?: unknown): Promise<any> {
  const r = await ctx.app.inject({
    method, url,
    headers: { authorization: `Bearer ${config.appToken}`, "content-type": "application/json", "x-request-id": "ai-tool" },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
  const out = r.body ? JSON.parse(r.body) : {};
  if (r.statusCode >= 400) throw new ToolError(out?.error || `HTTP ${r.statusCode}`);
  return out;
}

const qs = (o: Record<string, unknown>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

const cut = (s: unknown, n: number) => {
  const t = typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "";
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** A TMDb-ish work as the model sees it (poster path kept so answers can show cards). */
function work(m: any, overview = 90) {
  if (!m) return null;
  return {
    type: m.type, tmdbid: m.tmdbid ?? m.tmdb_id ?? null, title: m.title ?? m.name ?? "", year: m.year ?? "",
    ...(m.originalTitle && m.originalTitle !== m.title ? { original: m.originalTitle } : {}),
    ...(m.vote ? { rating: Math.round(m.vote * 10) / 10 } : {}),
    ...(overview && m.overview ? { overview: cut(m.overview, overview) } : {}),
    ...(m.poster ? { poster: String(m.poster).split("/").pop() } : {}),   // the app rebuilds the TMDb URL
    ...("library" in m ? { inLibrary: !!m.library } : {}),   // known only where the route looked it up
    ...(m.roles?.length ? { roles: m.roles.slice(0, 3) } : {}),
  };
}

/** A Bilibili live room as the model sees it (cover kept for the card, without the scheme). */
function liveSlim(l: any) {
  return {
    live: !!l.live, roomId: l.roomId, title: cut(l.title, 60) || undefined, uname: l.uname || undefined, area: l.area || undefined,
    online: l.online ?? undefined, ...(l.since ? { since: l.since } : {}), ...(l.cover ? { cover: String(l.cover).replace(/^https?:\/\//, "") } : {}),
  };
}

/** Same clock as the system prompt's "Now", so 昨天 / 今晚 line up. */
const localTime = (iso: string) => new Date(iso).toLocaleString("zh-CN", { timeZone: process.env.TZ || "Asia/Shanghai", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

function embyItem(i: any) {
  return {
    embyId: i.id, name: i.name, type: i.type, year: i.year ?? undefined,
    ...(i.series ? { series: i.series, season: i.season, episode: i.episode } : {}),
    ...(i.tmdbid ? { tmdbid: Number(i.tmdbid) || i.tmdbid } : {}),
    ...(i.added ? { added: String(i.added).slice(0, 10) } : {}),
    ...(i.played ? { played: localTime(i.played) } : {}),
    ...(i.plays ? { plays: i.plays } : {}),
    ...(i.progress != null ? { progress: i.progress } : {}),
    ...(i.finished === false ? { finished: false } : {}),
  };
}

type Def = {
  description: string;
  input: z.ZodObject<any>;
  label: (a: any) => string;
  tier: "read" | "write" | "memory";
  adult?: boolean;
  run: (ctx: ToolCtx, a: any) => Promise<unknown>;
};

const Type = z.enum(["movie", "tv"]);

export const TOOLS: Record<string, Def> = {
  search_media: {
    tier: "read",
    description: "按一个片名/人名搜索影视（TMDb，经 MoviePilot），返回候选作品（type、tmdbid、年份、评分、简介、是否已入库 inLibrary）和人物（personId）。用于不确定是哪部、要看候选时；已知一串片名用 lookup_titles 一次查完。模糊描述先 web_search 找到片名。",
    input: z.object({ query: z.string().min(1).describe("片名或人名"), page: z.number().int().min(1).max(5).optional() }),
    label: (a) => `搜索「${a.query}」`,
    run: async (ctx, a) => {
      const r = await call(ctx, "GET", `/v1/media/search${qs({ q: a.query, page: a.page })}`);
      return { works: (r.items ?? []).slice(0, 15).map((m: any) => work(m)), people: (r.persons ?? []).slice(0, 5).map((p: any) => ({ personId: p.id, name: p.name, dept: p.dept ?? p.known_for_department })) };
    },
  },
  lookup_titles: {
    tier: "read",
    description: "批量把一组片名（可带年份、类型）对上 TMDb 作品，一次返回每部的 tmdbid、海报、评分和是否已入库（inLibrary）。列推荐清单、核对一批片子『库里有没有』时用它，一次最多 20 部；不要逐部调用 search_media 或 library_search。",
    input: z.object({ items: z.array(z.object({ title: z.string().min(1), year: z.string().optional(), type: Type.optional() })).min(1).max(20) }),
    label: (a) => `批量查 ${a.items?.length ?? ""} 部`,
    run: async (ctx, a) => {
      const r = await call(ctx, "POST", "/v1/media/lookup", { items: a.items.map((i: any) => ({ title: i.title, year: i.year ?? "", type: i.type })) });
      return (r.items ?? []).map((m: any) => (m.tmdbid ? { query: m.query, ...work(m, 0) } : { query: m.query, notFound: true }));
    },
  },
  douban_related: {
    tier: "read",
    description: "豆瓣『喜欢这部的人也喜欢』：给豆瓣条目 id（从 web_search 搜『片名 豆瓣』的 movie.douban.com/subject/<id> 链接里拿），返回相似作品，已对上 TMDb（tmdbid、海报、豆瓣评分、是否已入库）。主人提到豆瓣、或想要华语口碑向推荐时优先用。",
    input: z.object({ doubanId: z.string().regex(/^\d{4,10}$/), type: Type }),
    label: () => "读豆瓣相似推荐",
    run: async (ctx, a) => ((await call(ctx, "GET", `/v1/douban/related${qs({ id: a.doubanId, type: a.type })}`)).items ?? []).map((m: any) => ({ ...work(m, 40), ...(m.doubanRating ? { douban: m.doubanRating } : {}) })),
  },
  media_detail: {
    tier: "read",
    description: "一部作品的详情：简介、类型、演职员、季集、库里已有哪些集、是否已订阅、关键词/公司/电视网 id（可用于 tmdb_discover）。",
    input: z.object({ type: Type, tmdbid: z.number().int().positive() }),
    label: (a) => `查看作品 ${a.tmdbid}`,
    run: async (ctx, a) => {
      const r = await call(ctx, "GET", `/v1/media/${a.type}/${a.tmdbid}`);
      const m = r.media ?? {};
      return {
        ...work(m, 400), genres: m.genres, genreIds: (m.genreList ?? []).map((g: any) => `${g.id}:${g.name}`),
        networks: m.networks, companies: m.companies, date: m.date, status: m.status, runtime: m.runtime,
        seasonsCount: m.seasons, episodesCount: m.episodes, country: m.country, tagline: m.tagline,
        people: (m.people ?? []).slice(0, 10).map((p: any) => ({ personId: p.id, name: p.name, role: p.role ?? p.job ?? p.character })),
        seasons: (r.seasons ?? []).map((s: any) => ({ season: s.season, name: s.name, episodes: s.episodes ?? s.episode_count, have: s.have ?? s.library?.length, air: s.air ?? s.air_date })),
        library: r.library ? { inLibrary: true, ...("have" in r.library ? { have: r.library.have } : {}) } : { inLibrary: false },
        subscription: r.subscription ?? r.subscriptions ?? null,
      };
    },
  },
  related_media: {
    tier: "read",
    description: "与某部作品相关：TMDb 推荐、所属系列（合集）、关键词。适合『类似的片』推荐。",
    input: z.object({ type: Type, tmdbid: z.number().int().positive() }),
    label: () => "找相关作品",
    run: async (ctx, a) => {
      const r = await call(ctx, "GET", `/v1/media/${a.type}/${a.tmdbid}/related`);
      return {
        recommendations: (r.recommendations ?? []).slice(0, 15).map((m: any) => work(m, 60)),
        collection: r.collection ? { name: r.collection.name, parts: (r.collection.parts ?? []).map((m: any) => work(m, 0)) } : null,
        keywords: (r.keywords ?? []).slice(0, 15),
      };
    },
  },
  discover: {
    tier: "read",
    description: "发现页榜单。不带 section 返回所有榜单（id、标题，例如 TMDb 热门、豆瓣 Top250、豆瓣热门剧集、正在热映、Bangumi 新番）；带 section 返回该榜单的作品。",
    input: z.object({ section: z.string().optional(), page: z.number().int().min(1).max(10).optional() }),
    label: (a) => (a.section ? `读榜单 ${a.section}` : "列出发现榜单"),
    run: async (ctx, a) => {
      if (!a.section) return (await call(ctx, "GET", "/v1/discover")).sections;
      const r = await call(ctx, "GET", `/v1/discover/${encodeURIComponent(a.section)}${qs({ page: a.page })}`);
      return { title: r.title, items: (r.items ?? []).slice(0, 30).map((m: any) => work(m, 50)) };
    },
  },
  tmdb_discover: {
    tier: "read",
    description: "按条件发现 TMDb 作品：类型 id（genres，逗号分隔）、电视网 id、公司 id、关键词 id（这些 id 从 media_detail / related_media 拿），排序。用于『某公司/某电视网/某类型/某关键词的片』。",
    input: z.object({
      type: Type, genres: z.string().optional(), networks: z.string().optional(), companies: z.string().optional(), keywords: z.string().optional(),
      sort: z.enum(["popularity.desc", "vote_average.desc", "primary_release_date.desc", "first_air_date.desc"]).optional(), page: z.number().int().min(1).max(10).optional(),
    }),
    label: () => "按条件发现作品",
    run: async (ctx, a) => {
      const r = await call(ctx, "GET", `/v1/tmdb/discover${qs({ type: a.type, with_genres: a.genres, with_networks: a.networks, with_companies: a.companies, with_keywords: a.keywords, sort_by: a.sort, page: a.page })}`);
      return (r.items ?? []).slice(0, 25).map((m: any) => work(m, 50));
    },
  },
  person_works: {
    tier: "read",
    description: "某个演员/导演的作品年表（personId 来自 search_media 或 media_detail）。",
    input: z.object({ personId: z.number().int().positive() }),
    label: () => "读人物作品",
    run: async (ctx, a) => {
      const r = await call(ctx, "GET", `/v1/tmdb/person/${a.personId}`);
      return (r.works ?? []).filter((w: any) => !w.minor).slice(0, 40).map((m: any) => work(m, 0));
    },
  },
  library_search: {
    tier: "read",
    description: "在 Emby 媒体库里按名字找条目（返回 embyId、类型、年份、tmdbid），用于要 embyId（刷新条目）或库里有、TMDb 对不上的片。判断有没有入库不需要它：search_media / lookup_titles / douban_related 的 inLibrary 已经给出。",
    input: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(40).optional() }),
    label: (a) => `在媒体库找「${a.query}」`,
    run: async (ctx, a) => (await call(ctx, "GET", `/v1/emby/items${qs({ q: a.query, limit: a.limit ?? 20, noAdult: ctx.adult ? undefined : 1 })}`)).items?.map(embyItem) ?? [],
  },
  cast_to_tv: {
    tier: "write",
    description: "把媒体库（Emby）里的一部电影或某一集投到电视（DLNA，由手机 App 在本地网络里投）。给 embyId（电影或某一集），或给 title（剧名/片名）+ 剧集的 season、episode。默认投到上次用过的电视，tv 可指定电视名字（模糊匹配）；resume=true（默认）从上次看到的位置接着放，false 从头。先确认库里有（没入库的不能投）；『下一集 / 接着看』先用 watch_history kind=resume 找到那一集。返回投到了哪台电视，失败时有原因和找到的电视列表。",
    input: z.object({
      embyId: z.string().regex(/^\w+$/).optional(), title: z.string().max(200).optional(),
      season: z.number().int().min(0).max(100).optional(), episode: z.number().int().min(0).max(5000).optional(),
      tv: z.string().max(100).optional(), resume: z.boolean().optional(),
    }),
    label: (a) => `投屏${a.title ? `「${a.title}」` : ""}${a.season != null && a.episode != null ? ` S${a.season}E${a.episode}` : ""}`,
    run: async (ctx, a) => {
      const norm = (x: string) => x.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
      let target: any = null;
      let series: any = null;
      if (a.embyId) {
        const r = await call(ctx, "GET", `/v1/emby/item/${a.embyId}`);
        if (r.item.type === "Series") series = r;
        else target = r.item;
      } else if (a.title) {
        const found = ((await call(ctx, "GET", `/v1/emby/items${qs({ q: a.title, limit: 20, noAdult: ctx.adult ? undefined : 1 })}`)).items ?? []) as any[];
        const want = a.episode != null ? "Series" : null;
        const pool = found.filter((i) => !want || i.type === want);
        const pick = pool.find((i) => norm(i.name) === norm(a.title!)) ?? pool[0];
        if (!pick) throw new ToolError(`媒体库里没有「${a.title}」${want ? "这部剧" : ""}`);
        if (pick.type === "Series") series = await call(ctx, "GET", `/v1/emby/item/${pick.id}`);
        else target = pick;
      } else throw new ToolError("需要 embyId，或 title（剧集再加 season、episode）");
      if (series) {
        if (a.episode == null) throw new ToolError(`「${series.item.name}」是剧集：要给 season 和 episode（接着看先查 watch_history kind=resume）`);
        const seasons = series.seasons as { season: number; episodes: any[] }[];
        const s = seasons.find((x) => x.season === (a.season ?? 1)) ?? (a.season == null && seasons.length === 1 ? seasons[0] : undefined);
        const ep = s?.episodes.find((e) => e.episode === a.episode);
        if (!ep) {
          const have = seasons.map((x) => `第${x.season}季 ${x.episodes.length} 集`).join("；");
          throw new ToolError(`库里没有第 ${a.season ?? 1} 季第 ${a.episode} 集。库里有：${have || "没有分集"}`);
        }
        target = { ...ep, series: series.item.name };
      }
      const where = String(series?.item.path ?? target.path ?? "");
      if (!ctx.adult && /\/(AV|里番)\//.test(where)) throw new ToolError("隐藏内容未开启");
      const title = target.series ? `${target.series} 第${target.season}季第${target.episode}集${target.name ? ` ${target.name}` : ""}` : target.name;
      const r = await ctx.phone("cast", { embyId: target.id, title, resume: a.resume ?? true, tv: a.tv });
      return { ...r, item: { embyId: target.id, title } };
    },
  },
  tv_control: {
    tier: "write",
    description: "控制正在 DLNA 投屏的电视（由手机 App 在本地网络里操作，默认上次投屏用的电视，tv 可指定名字）：status 看现在放什么、播到哪、音量；play / pause / stop；seek 跳到 seconds 秒（绝对位置）；forward / back 快进 / 快退 seconds 秒（默认 30）；volume 设音量 level（0–100），volume_up / volume_down 调 step（默认 5）。每次都返回操作后的状态（state、position、duration、title、volume）。『快进 5 分钟』= forward 300；『跳到 1 小时 20 分』= seek 4800。换片 / 换集用 cast_to_tv。",
    input: z.object({
      action: z.enum(["status", "play", "pause", "stop", "seek", "forward", "back", "volume", "volume_up", "volume_down"]),
      seconds: z.number().min(0).max(86400).optional(), level: z.number().int().min(0).max(100).optional(),
      step: z.number().int().min(1).max(50).optional(), tv: z.string().max(100).optional(),
    }),
    label: (a) => ({ status: "看电视在放什么", play: "电视继续播放", pause: "电视暂停", stop: "电视停止播放", seek: "电视跳转进度", forward: "电视快进", back: "电视快退", volume: "调电视音量", volume_up: "电视音量调大", volume_down: "电视音量调小" } as Record<string, string>)[a.action] ?? "控制电视",
    run: async (ctx, a) => {
      if (a.action === "seek" && a.seconds == null) throw new ToolError("seek 要给 seconds（跳到第几秒）");
      if (a.action === "volume" && a.level == null) throw new ToolError("volume 要给 level（0–100）");
      const r = await ctx.phone("tv", { action: a.action, seconds: a.seconds, level: a.level, step: a.step, tv: a.tv });
      const clock = (n: number) => `${Math.floor(n / 3600)}:${String(Math.floor((n % 3600) / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
      return typeof r.position === "number" ? { ...r, at: `${clock(r.position)} / ${typeof r.duration === "number" && r.duration ? clock(r.duration) : "?"}` } : r;
    },
  },
  subtitles: {
    tier: "write",
    description: "字幕：查、读、装。按台词/剧情找片段的位置（『跳到直升机撒钱那段』）：search 找这部的字幕（结果已按合适程度排好：对得上集数 match=episode、时长 match=duration 的在前）→ 直接拿文件的 source（射手网的字幕包 pack=true 要先 files 列出里面的文件，挑对应 SxxExx 的）→ read 带 q（台词里可能出现的词，空格分隔多个，任一命中；多试几组同义词）拿到时间 → tv_control seek 跳过去。action：list（embyId）条目已有的字幕：内封轨（只能列，读不了）和外挂文件（path）；search（embyId 或 q=片名，可加 season/episode）同时搜多个在线字幕源：迅雷（直接是字幕文件，带语言和时长）、射手网（字幕包）、sub_share（开源动画字幕库）；files（source=assrt:<id>）字幕包里的文件，每个 source=assrt:<id>/<n>；read（path = list 的文件路径或在线文件的 source）读台词和时间：给 q 返回命中行和前后各一句，不给 q 从 from 秒读 limit 行；install（embyId + source）装上：target=library 写在 strm 旁边 Emby 直接认（默认），115 写在网盘视频旁边；ASS 默认按音轨校准时间轴（要几分钟）。读在线字幕不用先装。",
    input: z.object({
      action: z.enum(["list", "search", "files", "read", "install"]), embyId: z.string().regex(/^\w+$/).optional(), q: z.string().max(200).optional(),
      source: z.string().max(2000).optional(), path: z.string().max(2000).optional(), from: z.number().min(0).optional(), limit: z.number().int().min(1).max(200).optional(),
      target: z.enum(["library", "115"]).optional(), lang: z.string().regex(/^[a-z]{2,6}$/).optional(), align: z.boolean().optional(),
    }),
    label: (a) => ({ list: "看有哪些字幕", search: "在线找字幕", files: "看字幕包里的文件", read: a.q ? `在字幕里找「${a.q}」` : "读字幕台词", install: "安装字幕" } as Record<string, string>)[a.action],
    run: async (ctx, a) => {
      const need = (k: string, v: unknown) => { if (v == null || v === "") throw new ToolError(`${a.action} 要给 ${k}`); };
      switch (a.action) {
        case "read":
          need("path", a.path ?? a.source);
          return call(ctx, "GET", `/v1/subs/read${qs({ path: a.path ?? a.source, q: a.q, from: a.from, limit: a.limit })}`);
        case "search":
          if (!a.embyId) need("embyId 或 q", a.q);
          return call(ctx, "GET", `/v1/subs/search${qs({ embyId: a.embyId, q: a.q })}`).then((r) => ({ ...r, results: (r.results ?? []).slice(0, 15) }));
        case "files":
          need("source", a.source);
          return call(ctx, "GET", `/v1/subs/files${qs({ source: a.source })}`);
        case "list":
          need("embyId", a.embyId);
          return call(ctx, "GET", `/v1/emby/item/${a.embyId}/subtitles`);
        default:
          need("embyId", a.embyId);
          need("source", a.source);
          return call(ctx, "POST", `/v1/emby/item/${a.embyId}/subtitles/install`, { source: a.source, target: a.target, lang: a.lang, align: a.align });
      }
    },
  },
  app_api: {
    tier: "write",
    description: "调用影库服务端自己的 API（App 能做的事都在这里：Emby 条目全部元数据和文件（strm 指向、码率、音轨字幕轨）、入库任务的查看重试换源取消、115 离线和网盘、qBittorrent、统计、健康检查和修复、订阅、黑名单、索引器……）。先 read_knowledge topic=api 看有哪些接口和参数，再调。GET 随便读；POST/PUT/DELETE 只在主人要求时做。删除、取消、移除类操作（会删文件或丢任务）必须先跟主人说清楚影响、得到明确同意后，带 confirmed=true 再调；Emby 删除先 dryRun 看计划。method + path（以 /v1/ 开头，可带 ?查询参数）+ body。",
    input: z.object({ method: z.enum(["GET", "POST", "PUT", "DELETE"]), path: z.string().regex(/^\/v1\/[^\s#]*$/).max(600), body: z.record(z.string(), z.unknown()).optional(), confirmed: z.boolean().optional() }),
    label: (a) => (a.method === "GET" ? `读取 ${a.path.split("?")[0]}` : `执行 ${a.method} ${a.path.split("?")[0]}`),
    run: async (ctx, a) => {
      const p = a.path.split("?")[0];
      // not for the assistant: server settings and secrets, its own chats, logs, binary streams
      if (/^\/v1\/(ai|emby\/account|javdb\/session|logs|events|img|stream|subs\/file|config)(\/|$)/.test(p) || p.includes(".."))
        throw new ToolError("这个接口助手不能用（设置、凭据、日志或二进制内容）");
      if (!ctx.adult && /^\/v1\/(catalog|av)(\/|$)/.test(p)) throw new ToolError("隐藏内容未开启");
      const destructive = a.method === "DELETE" || /\/(delete|cancel|remove)$/.test(p) || (p === "/v1/qb/action" && a.body?.action === "delete");
      if (destructive && !a.confirmed) throw new ToolError("这是删除/取消类操作：先向主人说明会发生什么，得到明确同意后带 confirmed=true 再调");
      const body = /^\/v1\/emby\/item\/\w+\/delete$/.test(p) && !a.confirmed ? { ...a.body, dryRun: true } : a.body;
      const out = await call(ctx, a.method, a.path, a.method === "GET" ? undefined : body ?? {});
      const text = JSON.stringify(out);
      return text.length > 12_000 ? { truncated: true, note: "结果太长，只给了前 12000 字：用查询参数缩小范围（limit、filter、具体 id）", head: text.slice(0, 12_000) } : out;
    },
  },
  library_latest: {
    tier: "read",
    description: "Emby 最近入库的电影和剧集。",
    input: z.object({ limit: z.number().int().min(1).max(50).optional() }),
    label: () => "看最近入库",
    run: async (ctx, a) => (await call(ctx, "GET", `/v1/emby/latest${qs({ limit: a.limit ?? 20 })}`)).items?.map(embyItem) ?? [],
  },
  watch_history: {
    tier: "read",
    description: "主人在 Emby 的观看记录，按最后播放时间倒序：recent（默认，看完的和看了一部分的都有，带 played 日期、finished、进度 %）、played（只看完的）、resume（只看到一半的，『接着看』）。只记录在这台 Emby 上的播放；在别的播放器看的不会有。",
    input: z.object({ kind: z.enum(["recent", "played", "resume"]).optional(), limit: z.number().int().min(1).max(60).optional() }),
    label: (a) => (a.kind === "resume" ? "看在看的" : "读观看记录"),
    run: async (ctx, a) => (await call(ctx, "GET", `/v1/emby/played${qs({ kind: a.kind ?? "recent", limit: a.limit ?? 30, adult: ctx.adult ? 1 : undefined })}`)).items?.map(embyItem) ?? [],
  },
  tasks: {
    tier: "read",
    description: "入库任务（下载/115 离线/生成 strm/刮削）及状态、进度、卡在哪一步。",
    input: z.object({ limit: z.number().int().min(1).max(60).optional() }),
    label: () => "查看入库任务",
    run: async (ctx, a) => {
      const r = await call(ctx, "GET", `/v1/pipeline${qs({ limit: a.limit ?? 20 })}`);
      return (r.tasks ?? r.items ?? []).map((t: any) => ({
        hash: t.hash, title: t.title ?? t.name, name: cut(t.name, 80), status: t.status, stage: t.stage, percent: t.percent,
        category: t.category, added: t.added ? new Date(t.added * 1000).toISOString().slice(0, 16) : undefined,
        last: cut(t.steps?.find((s: any) => s.state === "active")?.last ?? "", 100) || undefined, failed: t.failed || undefined,
      }));
    },
  },
  subscriptions: {
    tier: "read",
    description: "MoviePilot 订阅列表（追更中的剧/想看的电影）。",
    input: z.object({}),
    label: () => "查看订阅",
    run: async (ctx) => ((await call(ctx, "GET", "/v1/subscriptions")).items ?? []).map((s: any) => ({ id: s.id, title: s.title, year: s.year, type: s.type, tmdbid: s.tmdbid, season: s.season, state: s.state, total: s.total, lack: s.lack })),
  },
  health: {
    tier: "read",
    description: "系统健康检查结果（需要处理的问题）和服务连通状态。只读。",
    input: z.object({}),
    label: () => "看健康检查",
    run: async (ctx) => {
      const r = await call(ctx, "GET", "/v1/health");
      return { at: r.at, total: r.total, checks: (r.checks ?? []).slice(0, 30).map((f: any) => ({ key: f.key, title: f.title, severity: f.severity, count: f.count, hint: cut(f.hint, 80) })), errors: r.errors };
    },
  },
  find_resources: {
    tier: "read",
    description: "搜索可下载的资源，给出资源列表（ref、标题、大小、做种、分辨率、编码、字幕组、季集、评分、被排除的原因、来自哪个索引）。不给 sources = 智能搜索（MoviePilot 按作品搜所有启用的索引，要 tmdbid+type(+season)）；给 sources（list_sources 里的 id，如 nyaa、mikan、prowlarr:3）= 只搜这些源，配合 keywords 给 1-4 个关键词（中文名、英文名、罗马音、别名）。入库时把 ref 交给 ingest_resource。耗时 10-90 秒。",
    input: z.object({
      tmdbid: z.number().int().positive().optional(), type: Type.optional(), season: z.number().int().min(0).optional(),
      keyword: z.string().max(200).optional(), keywords: z.array(z.string().min(1).max(200)).max(4).optional(),
      sources: z.array(z.string().max(40)).max(20).optional(),
    }),
    label: (a) => `搜资源${a.keyword || a.keywords?.[0] ? `「${a.keyword || a.keywords[0]}」` : ""}${a.sources?.length ? `（${a.sources.length} 个源）` : ""}`,
    run: async (ctx, a) => {
      if (!a.tmdbid && !a.keyword && !a.keywords?.length) throw new ToolError("需要 tmdbid 或 keyword / keywords");
      const r = await call(ctx, "POST", "/v1/search", { tmdbid: a.tmdbid, type: a.type ?? "tv", season: a.season, keyword: a.keyword, keywords: a.keywords, sources: a.sources });
      if (r.ok === false) throw new ToolError(r.error || "搜索失败");
      const start = Object.keys(ctx.refs).length;
      const list = (r.results ?? []).slice(0, 25).map((x: any, i: number) => {
        const ref = `r${start + i + 1}`;
        ctx.refs[ref] = { title: x.title, magnet: x.magnet, size: x.size, seeders: x.seeders, source: x.source, kind: x.kind, media: r.media ?? null, season: x.season ?? r.season ?? null };
        return {
          ref, title: cut(x.title, 120), sizeGB: Math.round((x.size / 1e9) * 10) / 10, seeders: x.seeders, res: x.res || undefined, codec: x.codec || undefined,
          group: x.group || undefined, se: x.se || undefined, score: x.score ?? undefined, excluded: x.excluded || undefined, source: x.indexer || x.source,
        };
      });
      return { media: r.media, season: r.season, library: r.library, results: list };
    },
  },
  community_reviews: {
    tier: "read",
    description: "大家怎么评价一部作品（不只看分数）。豆瓣：星级分布、看过/在看/想看人数、热门短评（每条带评论者给的星级和有用数）、最有用的长评摘要——按 title + year + type 找（剧集可给 season，豆瓣每季单独一个条目），或直接给 doubanId。TMDb：用户影评（多为英文，带 10 分制评分），需要 tmdbid。能给的都给，两边并行；比较几部时并行调用。推荐前用它确认口碑、适合什么人、有什么争议；引用评论是观众原话，别改写成事实，英文影评用中文概括。",
    input: z.object({ title: z.string().max(200).optional(), year: z.string().max(8).optional(), type: z.enum(["movie", "tv"]).optional(), season: z.number().int().min(1).max(50).optional(), tmdbid: z.number().int().positive().optional(), doubanId: z.string().regex(/^\d{4,10}$/).optional(), limit: z.number().int().min(3).max(20).optional() }),
    label: (a) => `看「${a.title ?? a.doubanId ?? a.tmdbid}」的口碑`,
    run: async (ctx, a) => {
      const r = await call(ctx, "GET", `/v1/reviews${qs({ title: a.title, year: a.year, type: a.type, season: a.season, tmdbid: a.tmdbid, doubanId: a.doubanId })}`);
      if (r.douban) r.douban.comments = (r.douban.comments ?? []).slice(0, a.limit ?? 12);
      return r;
    },
  },
  video_search: {
    tier: "read",
    description: "搜 B 站 / YouTube 视频（解说、影评、剪辑、预告、访谈、教程等 UGC）。site = bilibili | youtube | both（默认 both，两边并行）；sort = relevance | latest | views。返回 site、id、标题、UP 主/频道、封面、时长、播放量、发布时间。展示用 video 卡片块。",
    input: z.object({ query: z.string().min(1).max(100), site: z.enum(["bilibili", "youtube", "both"]).optional(), sort: z.enum(["relevance", "latest", "views"]).optional(), limit: z.number().int().min(1).max(20).optional() }),
    label: (a) => `搜视频「${a.query}」`,
    run: async (ctx, a) => {
      const sites = a.site && a.site !== "both" ? [a.site] : ["bilibili", "youtube"];
      const n = a.limit ?? (sites.length > 1 ? 6 : 10);
      const got = await Promise.all(sites.map(async (site: string) => {
        try {
          const r = await call(ctx, "GET", `/v1/ugc/search${qs({ site, q: a.query, sort: a.sort })}`);
          return (r.items ?? []).slice(0, n).map((v: any) => ({
            site: v.site, id: v.id, title: cut(v.title, 70), author: v.author, duration: v.duration || undefined,
            views: v.views ?? undefined, published: v.published || undefined,
            // YouTube covers follow from the id; Bilibili's are kept (host + path, no scheme)
            ...(v.site === "bilibili" && v.cover ? { cover: String(v.cover).replace(/^https?:\/\//, "") } : {}),
          }));
        } catch (e) {
          return [{ site, error: e instanceof Error ? e.message : String(e) }];
        }
      }));
      return got.flat();
    },
  },
  list_sources: {
    tier: "read",
    description: "所有资源搜索源：直连源（Nyaa、AnimeTosho、Mikan…）和 Prowlarr 索引器（id 形如 prowlarr:3），每个的语言、标签（动漫/影视/中文/外文…）、简介、是否启用。按来源搜索、或判断该开哪个索引前先看它。",
    input: z.object({}),
    label: () => "看资源搜索源",
    run: async (ctx) => ((await call(ctx, "GET", "/v1/sources")).sources ?? []).filter((x: any) => ctx.adult || x.kind !== "adult" && !(x.tags ?? []).includes("成人")).map((x: any) => ({
      id: x.id, name: x.name, kind: x.kind, lang: x.lang, tags: x.tags, enabled: x.enabled, privacy: x.privacy, note: cut(x.note, 40) || undefined, desc: cut(x.desc, 70) || undefined,
    })),
  },
  browse_indexers: {
    tier: "read",
    description: "Prowlarr 可添加的公开索引器目录（几百个）：按 query（名字/简介关键词）、lang（zh/en/ja/ru…）、tag（动漫/影视/中文…）筛选，返回 definition（添加用）、语言、标签、简介、是否已添加（addedId）。主人想加新索引、或现有源搜不到某类资源时用。",
    input: z.object({ query: z.string().max(60).optional(), lang: z.string().max(8).optional(), tag: z.string().max(20).optional(), addableOnly: z.boolean().optional().describe("只看公开、可直接添加的（默认 true；私有 PT 站需要账号，不能在这里加）"), limit: z.number().int().min(1).max(40).optional() }),
    label: (a) => `查可添加的索引${a.query ? `「${a.query}」` : ""}`,
    run: async (ctx, a) => {
      const q = (a.query ?? "").toLowerCase();
      const items = ((await call(ctx, "GET", "/v1/prowlarr/catalog")).items ?? []).filter((x: any) =>
        (ctx.adult || !(x.tags ?? []).includes("成人")) && (a.addableOnly === false || x.addable) && (!a.lang || x.lang === a.lang) && (!a.tag || (x.tags ?? []).includes(a.tag)) &&
        (!q || `${x.name} ${x.desc} ${x.definition}`.toLowerCase().includes(q)));
      return { total: items.length, note: a.addableOnly === false ? undefined : "只列公开可添加的；addableOnly=false 看全部（含私有 PT）", items: items.slice(0, a.limit ?? 20).map((x: any) => ({ name: x.name, definition: x.definition, lang: x.lang, tags: x.tags, privacy: x.privacy, addable: x.addable, addedId: x.addedId ?? undefined, desc: cut(x.desc, 80) })) };
    },
  },
  manage_indexer: {
    tier: "write",
    description: "管理 Prowlarr 索引器：add（按 browse_indexers 的 definition 添加一个公开索引器）、enable / disable（按 list_sources 里的 prowlarr:<id> 启用或停用）。只在主人要求时做；不能删除索引器（删除在 App 设置 → 索引源）。改完后可以用 find_resources 指定这个源试搜。",
    input: z.object({ action: z.enum(["add", "enable", "disable"]), definition: z.string().max(80).optional(), id: z.string().regex(/^prowlarr:\d+$/).optional() }),
    label: (a) => (a.action === "add" ? `添加索引 ${a.definition ?? ""}` : `${a.action === "enable" ? "启用" : "停用"}索引 ${a.id ?? ""}`),
    run: async (ctx, a) => {
      if (a.action === "add") {
        if (!a.definition) throw new ToolError("add 需要 definition（来自 browse_indexers）");
        return call(ctx, "POST", "/v1/prowlarr", { action: "add", definition: a.definition });
      }
      if (!a.id) throw new ToolError("enable / disable 需要 id（prowlarr:<数字>，来自 list_sources）");
      return call(ctx, "POST", "/v1/prowlarr", { action: "update", id: Number(a.id.split(":")[1]), enable: a.action === "enable" });
    },
  },
  find_creators: {
    tier: "read",
    description: "按名字找 UP 主 / YouTube 频道（可能有多个同名、子账号、粉丝号）：返回 id、名字、粉丝数、投稿数、签名；B 站还带直播间和是否正在直播。主人问『有没有某某的号』『某某在不在直播』或 creator_videos 选错账号时用。",
    input: z.object({ name: z.string().min(1).max(60), site: z.enum(["bilibili", "youtube", "both"]).optional() }),
    label: (a) => `找 UP 主「${a.name}」`,
    run: async (ctx, a) => {
      const sites = a.site && a.site !== "both" ? [a.site] : ["bilibili", "youtube"];
      return Promise.all(sites.map(async (site: string) => {
        try {
          const who = ((await call(ctx, "GET", `/v1/ugc/creators${qs({ site, q: a.name })}`)).items ?? []) as any[];
          const live = site === "bilibili" && who.length ? (await call(ctx, "GET", `/v1/ugc/live${qs({ uids: who.slice(0, 8).map((w) => w.id).join(",") })}`).catch(() => ({ status: {} }))).status ?? {} : {};
          return { site, accounts: who.map((w) => ({ id: w.id, name: w.name, followers: w.followers ?? undefined, videos: w.videos ?? undefined, sign: w.sign || undefined, ...(live[w.id] ? { live: liveSlim(live[w.id]) } : {}) })) };
        } catch (e) {
          return { site, error: e instanceof Error ? e.message : String(e) };
        }
      }));
    },
  },
  live_search: {
    tier: "read",
    description: "搜 B 站直播间（主播名、游戏、赛事、话题，如『英雄联盟』『德云色』『LPL』）：返回正在直播的房间（roomId、标题、主播、分区、在线人数、封面），在播的、人多的在前。展示用 video 卡片块（live:true）。",
    input: z.object({ query: z.string().min(1).max(60), limit: z.number().int().min(1).max(20).optional() }),
    label: (a) => `搜直播「${a.query}」`,
    run: async (ctx, a) => ((await call(ctx, "GET", `/v1/ugc/live${qs({ q: a.query })}`)).items ?? []).slice(0, a.limit ?? 10).map(liveSlim),
  },
  creator_videos: {
    tier: "read",
    description: "某个 UP 主 / YouTube 频道 / 创作者（如『影视飓风』『老番茄』『MKBHD』）的账号和最新投稿：先按名字找账号（取名字最匹配、粉丝最多的），再拉它的最新视频，按时间倒序。site = bilibili | youtube | both（默认 both）。问『某某最近更新了什么』『看看某某的新视频』时用它，不要用 video_search 按关键词搜。B 站结果来自搜索、只有近期投稿；YouTube 是完整的最新列表。",
    input: z.object({ name: z.string().min(1).max(60), site: z.enum(["bilibili", "youtube", "both"]).optional(), limit: z.number().int().min(1).max(20).optional() }),
    label: (a) => `看「${a.name}」的最新视频`,
    run: async (ctx, a) => {
      const sites = a.site && a.site !== "both" ? [a.site] : ["bilibili", "youtube"];
      const norm = (x: string) => x.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
      return Promise.all(sites.map(async (site: string) => {
        try {
          const who = ((await call(ctx, "GET", `/v1/ugc/creators${qs({ site, q: a.name })}`)).items ?? []) as any[];
          if (!who.length) return { site, error: "没找到这个账号" };
          // the account whose name contains the query, most followers first; else the top search hit
          const pick = [...who].sort((x, y) => Number(norm(y.name).includes(norm(a.name))) - Number(norm(x.name).includes(norm(a.name))) || (y.followers ?? 0) - (x.followers ?? 0))[0];
          const [vids, liveNow] = await Promise.all([
            call(ctx, "GET", `/v1/ugc/uploads${qs({ site, id: pick.id, name: pick.name })}`).then((r) => (r.items ?? []) as any[]),
            site === "bilibili" ? call(ctx, "GET", `/v1/ugc/live${qs({ uids: pick.id })}`).then((r) => r.status?.[pick.id] ?? null).catch(() => null) : Promise.resolve(null),
          ]);
          return {
            site, account: { id: pick.id, name: pick.name, followers: pick.followers ?? undefined, videos: pick.videos ?? undefined, url: pick.url },
            ...(liveNow ? { live: liveSlim(liveNow) } : {}),
            others: who.filter((w) => w.id !== pick.id).slice(0, 3).map((w) => `${w.name}（${w.followers ?? "?"} 粉）`),
            latest: vids.slice(0, a.limit ?? 10).map((v) => ({
              site: v.site, id: v.id, title: cut(v.title, 70), author: v.author || pick.name, duration: v.duration || undefined, views: v.views ?? undefined, published: v.published || undefined,
              ...(v.site === "bilibili" && v.cover ? { cover: String(v.cover).replace(/^https?:\/\//, "") } : {}),
            })),
          };
        } catch (e) {
          return { site, error: e instanceof Error ? e.message : String(e) };
        }
      }));
    },
  },
  catalog_list: {
    tier: "read", adult: true,
    description: "成人目录（只在隐藏内容开启时可用）：provider = javdb | jable | hanime | emby-av；可按 sort、tag、q（关键词）、page 列出作品。",
    input: z.object({ provider: z.enum(["javdb", "jable", "hanime", "emby-av"]), sort: z.string().optional(), tag: z.string().optional(), q: z.string().optional(), page: z.number().int().min(1).max(10).optional() }),
    label: (a) => `看 ${a.provider} 目录`,
    run: async (ctx, a) => {
      const r = await call(ctx, "GET", `/v1/catalog/${a.provider}/list${qs({ sort: a.sort, tag: a.tag, q: a.q, page: a.page })}`);
      return (r.items ?? []).slice(0, 30).map((i: any) => ({ id: i.id, title: cut(i.title, 80), date: i.date, rating: i.rating, tags: (i.tags ?? []).slice(0, 5) }));
    },
  },
  catalog_item: {
    tier: "read", adult: true,
    description: "成人目录里一部作品的详情（番号、演员、标签、简介、在线播放源）。",
    input: z.object({ provider: z.enum(["javdb", "jable", "hanime", "emby-av"]), id: z.string().min(1) }),
    label: () => "看成人作品详情",
    run: async (ctx, a) => {
      const r = await call(ctx, "GET", `/v1/catalog/${a.provider}/item/${encodeURIComponent(a.id)}`);
      return { id: r.id, title: r.title, original: r.originalTitle, date: r.date, rating: r.rating, tags: r.tags, overview: cut(r.overview, 300), facts: r.facts, keyword: r.keyword };
    },
  },
  ingest_resource: {
    tier: "write",
    description: "把 find_resources 找到的某个资源（ref）提交入库（115 离线 → strm → 刮削，进度在入库任务里）。只在主人明确要求入库/下载时调用。",
    input: z.object({ ref: z.string().regex(/^r\d+$/) }),
    label: (a) => `提交入库 ${a.ref}`,
    run: async (ctx, a) => {
      const x = ctx.refs[a.ref];
      if (!x) throw new ToolError(`没有资源 ${a.ref}：先用 find_resources 搜索`);
      if (!x.magnet?.startsWith("magnet:")) throw new ToolError("这个资源没有磁力链接，不能直接入库");
      const kind = x.kind === "adult" ? (x.adultKind ?? "av") : "media";
      if (kind !== "media" && !ctx.adult) throw new ToolError("隐藏内容未开启");
      const r = await call(ctx, "POST", "/v1/ingest", {
        kind, magnet: x.magnet, title: x.title, ...(x.media ? { tmdbid: x.media.tmdbid, type: x.media.type } : {}), ...(x.season != null ? { season: x.season } : {}),
      });
      return { ok: r.ok !== false, note: r.note ?? r.message ?? r.error, title: x.title };
    },
  },
  auto_ingest: {
    tier: "write",
    description: "让系统按选片策略自动挑资源，把一部或多部作品入库（一次最多 20 部，可给每部指定季）。主人说『帮我下/入库这几部』而没指定具体资源时用，多部一次提交，不要逐部调用。已在库里的不要提交。",
    input: z.object({ items: z.array(z.object({ type: Type, tmdbid: z.number().int().positive(), seasons: z.array(z.number().int().min(0)).max(30).optional() })).min(1).max(20) }),
    label: (a) => `自动入库 ${a.items?.length ?? ""} 部`,
    run: async (ctx, a) => call(ctx, "POST", "/v1/ingest/auto", { items: a.items }),
  },
  subscribe: {
    tier: "write",
    description: "订阅一部剧的某一季（追更新集）或一部电影（上线后自动下载）。剧集必须给 season：先用 media_detail 看 seasons，选主人说的那季（『第二季』= season 2；没说就是正在播或即将播出的最新一季）。已经全部在库里的季订阅了会立刻结束，没有意义。主人明确要求订阅/追更/出新集提醒时用；季不确定先问。",
    input: z.object({ type: Type, tmdbid: z.number().int().positive(), title: z.string().min(1), year: z.string().optional(), season: z.number().int().min(0).optional() }).refine((a) => a.type === "movie" || a.season != null, { message: "剧集订阅要给 season", path: ["season"] }),
    label: (a) => `订阅「${a.title}」`,
    run: async (ctx, a) => call(ctx, "POST", "/v1/subscriptions", { tmdbid: a.tmdbid, type: a.type, title: a.title, year: a.year ?? "", season: a.season }),
  },
  retry_task: {
    tier: "write",
    description: "重试一个入库任务（hash 来自 tasks）。mode：strm=重新生成 strm（默认），offline=重新提交 115 离线，buffer=改用 NAS 缓冲。",
    input: z.object({ hash: z.string().regex(/^[0-9a-f]{40}$/), mode: z.enum(["strm", "offline", "buffer"]).optional() }),
    label: () => "重试任务",
    run: async (ctx, a) => call(ctx, "POST", `/v1/pipeline/${a.hash}/retry`, { mode: a.mode ?? "strm" }),
  },
  refresh_library_item: {
    tier: "write",
    description: "让 Emby 重新刮削一个条目（embyId 来自 library_search）。用于海报/信息不对。",
    input: z.object({ embyId: z.string().regex(/^\w+$/) }),
    label: () => "刷新媒体库条目",
    run: async (ctx, a) => call(ctx, "POST", `/v1/emby/item/${a.embyId}/refresh`, {}),
  },
  read_knowledge: {
    tier: "read",
    description: "读一篇平台知识（主题见系统提示里的 knowledge 索引）。问到系统怎么运作、某个状态什么意思、去哪操作、为什么没入库时先读对应主题，再结合工具看真实状态。",
    input: z.object({ topic: z.enum(Object.keys(TOPICS) as [Topic, ...Topic[]]) }),
    label: (a) => `查平台知识 ${a.topic}`,
    run: async (ctx, a) => {
      if (a.topic === "adult" && !ctx.adult) throw new ToolError("隐藏内容未开启");
      return readKnowledge(a.topic);
    },
  },
  platform_status: {
    tier: "read",
    description: "这套部署当前的实况：有哪些媒体库及数量（电影/剧集/集数、近 7 天新增）、115 和 NAS 空间、入库任务数（下载中/失败）、订阅数、qBittorrent、需要处理的健康问题数。回答『我库里有多少』『现在在下什么』『系统正常吗』时用。",
    input: z.object({}),
    label: () => "看系统实况",
    run: async (ctx) => {
      const [ov, st, he] = await Promise.all([
        call(ctx, "GET", "/v1/overview").catch((e) => ({ error: String(e.message ?? e) })),
        call(ctx, "GET", "/v1/stats").catch((e) => ({ error: String(e.message ?? e) })),
        call(ctx, "GET", "/v1/health").catch(() => null),
      ]);
      const gb = (n: unknown) => (typeof n === "number" ? Math.round(n / 1e9) : undefined);
      return {
        libraries: (st.libraries ?? []).filter((l: any) => ctx.adult || !l.adult).map((l: any) => ({ name: l.name, movies: l.movies || undefined, series: l.series || undefined, episodes: l.episodes || undefined, videos: l.videos || undefined, new7d: l.new7d || undefined })),
        storage: st.storage ? { c115UsedGB: gb(st.storage.c115?.used), c115FreeGB: gb(st.storage.c115?.remain), nasFreeGB: gb(st.storage.nas?.free) } : undefined,
        pipeline: ov.pipeline, subscriptions: ov.subscriptions, qbittorrent: ov.qb,
        health: he ? { problems: (he.checks ?? []).filter((c: any) => c.count && c.severity !== "info").map((c: any) => `${c.title}（${c.count}）`) } : undefined,
        errors: [...(ov.errors ?? []), ...(st.errors ?? [])].slice(0, 5),
      };
    },
  },
  list_chats: {
    tier: "read",
    description: "主人和你以前的对话：按关键词（片名、话题）搜标题和问答内容，返回对话 id、标题、时间、命中的片段。主人说『上次』『之前问过』『你推荐过的那几部』时先用它，再用 read_chat 看全文。",
    input: z.object({ query: z.string().optional(), limit: z.number().int().min(1).max(30).optional() }),
    label: (a) => (a.query ? `翻以前的对话「${a.query}」` : "翻以前的对话"),
    run: async (ctx, a) => ctx.chats.list(a.query ?? "", a.limit ?? 10),
  },
  read_chat: {
    tier: "read",
    description: "读一次以前对话的问答原文（id 来自 list_chats；当前对话不用读，已在上下文里）。",
    input: z.object({ id: z.number().int().positive(), maxChars: z.number().int().min(500).max(12000).optional() }),
    label: () => "读以前的对话",
    run: async (ctx, a) => ctx.chats.read(a.id, a.maxChars ?? 6000),
  },
  memory_save: {
    tier: "memory",
    description: "写一条记忆（一句话，自包含，写清主语和具体对象）。kind：profile = 核心画像，每次对话都带（稳定的口味和规则：喜欢/讨厌的类型、画质字幕要求，最多 12 条，宁可合并）；fact = 关于主人的事实；watching = 在追/在看/想看的；event = 发生过的事（入库了什么、某次推荐和反馈）；plan = 待办和约定（『下周提醒我…』『等第二季出了再下』）。tags 给 1-4 个检索词（片名、人名、类型）。同类相近的记忆会自动更新而不是重复；要改某条就给 replaces=id。",
    input: z.object({ text: z.string().min(4).max(300), kind: z.enum(KINDS), tags: z.array(z.string().max(30)).max(4).optional(), replaces: z.number().int().positive().optional() }),
    label: (a) => (a.kind === "profile" ? "更新口味画像" : "记一笔"),
    run: async (ctx, a) => {
      const r = await saveMemory({ text: a.text, kind: a.kind, tags: a.tags, replaces: a.replaces, by: "ai" });
      ctx.saved(r.memory.text, r.action === "updated" ? r.memory.id : undefined);
      return { id: r.memory.id, action: r.action };
    },
  },
  memory_search: {
    tier: "read",
    description: "搜记忆（按关键词，可限定 kind）。系统提示里只带了核心画像和与本问题最相关的几条；问到『我以前说过…』『我在追什么』『上次那个约定』或要更多背景时搜它。写入前也可先搜，避免重复。",
    input: z.object({ query: z.string().max(100), kind: z.enum(KINDS).optional(), limit: z.number().int().min(1).max(30).optional() }),
    label: (a) => `翻记忆「${a.query}」`,
    run: async (_ctx, a) => (await searchMemory(a.query, a.kind, a.limit ?? 10)).map((m) => ({ id: m.id, kind: m.kind, text: m.text, tags: m.tags.length ? m.tags : undefined, updated: new Date(m.updated).toISOString().slice(0, 10), score: m.score })),
  },
  memory_forget: {
    tier: "memory",
    description: "删除一条记忆（id 来自 memory_search 或系统提示）。只在主人要求忘掉、或记忆已明显过时/错误时用。",
    input: z.object({ id: z.number().int().positive() }),
    label: () => "删掉一条记忆",
    run: async (_ctx, a) => ({ ok: await forget(a.id) }),
  },
};

export function toolList(adult: boolean, webSearch: boolean): Anthropic.Beta.BetaToolUnion[] {
  const list: Anthropic.Beta.BetaToolUnion[] = Object.entries(TOOLS)
    .filter(([, d]) => adult || !d.adult)
    .map(([name, d]) => ({ name, description: d.description, input_schema: z.toJSONSchema(d.input) as Anthropic.Beta.BetaTool.InputSchema }));
  if (webSearch) {
    list.push({ type: "web_search_20260209", name: "web_search", max_uses: 6 } as Anthropic.Beta.BetaToolUnion);
    // read a page found by search (or a link the owner gave): plot write-ups, Douban / Wikipedia pages
    list.push({ type: "web_fetch_20260209", name: "web_fetch", max_uses: 5, max_content_tokens: 8000 } as Anthropic.Beta.BetaToolUnion);
  }
  return list;
}

export function labelOf(name: string, input: unknown): string {
  const d = TOOLS[name];
  if (!d) return name;
  try {
    return d.label((input ?? {}) as never);
  } catch {
    return name;
  }
}

export async function runTool(ctx: ToolCtx, name: string, input: unknown): Promise<{ ok: boolean; content: string }> {
  const d = TOOLS[name];
  if (!d || (d.adult && !ctx.adult)) return { ok: false, content: `没有这个工具：${name}` };
  const parsed = d.input.safeParse(input ?? {});
  if (!parsed.success) return { ok: false, content: `参数不对：${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}` };
  try {
    const out = await d.run(ctx, parsed.data);
    let s = JSON.stringify(out);
    if (s.length > 12_000) s = `${s.slice(0, 12_000)}…（已截断）`;
    return { ok: true, content: s };
  } catch (e) {
    return { ok: false, content: e instanceof Error ? e.message : String(e) };
  }
}
