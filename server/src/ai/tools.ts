// The assistant's tools. Each one is a call to this server's own /v1 routes (in-process, app.inject with
// the app token), so it reuses their validation, caching, library lookups and errors; outputs are slimmed
// before the model sees them. Tiers:
//   read   — search, details, 发现, people, Emby library and watch history, tasks, subscriptions, health,
//            resource search (Prowlarr + direct sources); AV / 里番 catalogs only when 成人内容 is on.
//   write  — ingest a resource the assistant found (by its short ref, never a raw magnet), auto-ingest,
//            subscribe, retry a task, refresh one Emby item. Each is a normal user action in the app.
//   never  — nothing that deletes, cancels, stops a service, changes configuration or reads credentials
//            (e.g. /v1/emby/account) is reachable: only the routes listed here are.
import type { FastifyInstance } from "fastify";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { config } from "../config.ts";

export interface ToolCtx {
  app: FastifyInstance;
  adult: boolean;
  /** resources found by find_resources in this chat, by ref ("r1"…) */
  refs: Record<string, Resource>;
  remember: (text: string, replaces?: number) => void;
}

export interface Resource {
  title: string; magnet: string; size: number; seeders: number; source: string; kind: string;
  media: { tmdbid: number; type: "movie" | "tv"; title: string } | null; season: number | null; adultKind?: "av" | "hentai";
}

class ToolError extends Error {}

async function call(ctx: ToolCtx, method: "GET" | "POST", url: string, body?: unknown): Promise<any> {
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
    ...(m.library ? { inLibrary: m.library.lib ?? true } : {}),
    ...(m.roles?.length ? { roles: m.roles.slice(0, 3) } : {}),
  };
}

function embyItem(i: any) {
  return {
    embyId: i.id, name: i.name, type: i.type, year: i.year ?? undefined,
    ...(i.series ? { series: i.series, season: i.season, episode: i.episode } : {}),
    ...(i.tmdbid ? { tmdbid: Number(i.tmdbid) || i.tmdbid } : {}),
    ...(i.added ? { added: String(i.added).slice(0, 10) } : {}),
    ...(i.played ? { played: String(i.played).slice(0, 10) } : {}),
    ...(i.progress != null ? { progress: i.progress } : {}),
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
    description: "按片名/人名搜索影视（TMDb，经 MoviePilot）。返回作品（type、tmdbid、年份、评分、简介、是否已入库）和人物（personId）。中文名、原名、英文名都可以；模糊描述先用 web_search 找到片名再来这里。",
    input: z.object({ query: z.string().min(1).describe("片名或人名"), page: z.number().int().min(1).max(5).optional() }),
    label: (a) => `搜索「${a.query}」`,
    run: async (ctx, a) => {
      const r = await call(ctx, "GET", `/v1/media/search${qs({ q: a.query, page: a.page })}`);
      return { works: (r.items ?? []).slice(0, 15).map((m: any) => work(m)), people: (r.persons ?? []).slice(0, 5).map((p: any) => ({ personId: p.id, name: p.name, dept: p.dept ?? p.known_for_department })) };
    },
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
    description: "在 Emby 媒体库里按名字找（返回 embyId、类型、年份、tmdbid）。判断『我有没有某部片』。",
    input: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(40).optional() }),
    label: (a) => `在媒体库找「${a.query}」`,
    run: async (ctx, a) => (await call(ctx, "GET", `/v1/emby/items${qs({ q: a.query, limit: a.limit ?? 20, noAdult: ctx.adult ? undefined : 1 })}`)).items?.map(embyItem) ?? [],
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
    description: "主人在 Emby 的观看记录：最近看完的（played）和看到一半的（resume，带进度 %）。推荐时用来了解口味、找『接着看』。",
    input: z.object({ kind: z.enum(["played", "resume"]).optional(), limit: z.number().int().min(1).max(60).optional() }),
    label: (a) => (a.kind === "resume" ? "看在看的" : "读观看记录"),
    run: async (ctx, a) => (await call(ctx, "GET", `/v1/emby/played${qs({ kind: a.kind ?? "played", limit: a.limit ?? 30, adult: ctx.adult ? 1 : undefined })}`)).items?.map(embyItem) ?? [],
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
    description: "搜索可下载的资源（Prowlarr 各索引器 + 直连源），给出资源列表（ref、标题、大小、做种、分辨率、编码、字幕组、季集、评分、被排除的原因）。影视最好带 tmdbid+type(+season)，否则用 keyword。入库时把 ref 交给 ingest_resource。耗时可能 30-90 秒。",
    input: z.object({ tmdbid: z.number().int().positive().optional(), type: Type.optional(), season: z.number().int().min(0).optional(), keyword: z.string().max(200).optional() }),
    label: (a) => `搜资源${a.keyword ? `「${a.keyword}」` : ""}`,
    run: async (ctx, a) => {
      if (!a.tmdbid && !a.keyword) throw new ToolError("需要 tmdbid 或 keyword");
      const r = await call(ctx, "POST", "/v1/search", { tmdbid: a.tmdbid, type: a.type ?? "tv", season: a.season, keyword: a.keyword });
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
  catalog_list: {
    tier: "read", adult: true,
    description: "成人目录（只在成人内容开启时可用）：provider = javdb | jable | hanime | emby-av；可按 sort、tag、q（关键词）、page 列出作品。",
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
      if (kind !== "media" && !ctx.adult) throw new ToolError("成人内容未开启");
      const r = await call(ctx, "POST", "/v1/ingest", {
        kind, magnet: x.magnet, title: x.title, ...(x.media ? { tmdbid: x.media.tmdbid, type: x.media.type } : {}), ...(x.season != null ? { season: x.season } : {}),
      });
      return { ok: r.ok !== false, note: r.note ?? r.message ?? r.error, title: x.title };
    },
  },
  auto_ingest: {
    tier: "write",
    description: "让系统自动挑选资源入库一部作品（可指定季）。主人说『帮我下/入库某部』但没指定资源时用。",
    input: z.object({ type: Type, tmdbid: z.number().int().positive(), seasons: z.array(z.number().int().min(0)).max(30).optional() }),
    label: () => "自动入库",
    run: async (ctx, a) => call(ctx, "POST", "/v1/ingest/auto", { tmdbid: a.tmdbid, type: a.type, seasons: a.seasons }),
  },
  subscribe: {
    tier: "write",
    description: "订阅一部剧（追更）或电影（上线后自动下载）。主人明确要求订阅/追更时用。",
    input: z.object({ type: Type, tmdbid: z.number().int().positive(), title: z.string().min(1), year: z.string().optional(), season: z.number().int().min(0).optional() }),
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
  remember: {
    tier: "memory",
    description: "记住主人的一条长期偏好或事实（口味、不喜欢的类型、画质/字幕要求、在追的剧等），以后每次对话都会带上。replaces = 要替换的旧偏好编号。只记主人明确表达的、长期有用的内容。",
    input: z.object({ text: z.string().min(2).max(300), replaces: z.number().int().positive().optional() }),
    label: () => "记住偏好",
    run: async (ctx, a) => {
      ctx.remember(a.text, a.replaces);
      return { ok: true };
    },
  },
};

export function toolList(adult: boolean, webSearch: boolean): Anthropic.Beta.BetaToolUnion[] {
  const list: Anthropic.Beta.BetaToolUnion[] = Object.entries(TOOLS)
    .filter(([, d]) => adult || !d.adult)
    .map(([name, d]) => ({ name, description: d.description, input_schema: z.toJSONSchema(d.input) as Anthropic.Beta.BetaTool.InputSchema }));
  if (webSearch) list.push({ type: "web_search_20260209", name: "web_search", max_uses: 6 } as Anthropic.Beta.BetaToolUnion);
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
