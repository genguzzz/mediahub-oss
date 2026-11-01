// Cards in the assistant's answers. Tools stamp a `card` ref ("tv:1396", "person:287", "emby:11304",
// "bili:BV1…", "task:<hash>", …) on every result that has a page or a link, and register what the card
// shows (image, title, subtitle, where it goes) from the raw route data. The model only lists refs in a
// ```cards block; the server sends each referenced card's data as a `card` event while the block streams
// and stores it on the answer. So a new kind of card is a builder here (+ a `card` field in its tool):
// the system prompt's one rule doesn't grow, the model never copies image paths, and a card can't point at
// an id no tool returned (refs it never saw are looked up once, or dropped).
import type { FastifyInstance } from "fastify";
import { config } from "../config.ts";

/** What the app draws. shape: poster (2:3), avatar (round), wide (16:9), row (list line). */
export interface Card {
  shape: "poster" | "avatar" | "wide" | "row";
  title: string;
  sub?: string;
  /** absolute URL, or a backend path the app loads with its token (/v1/img/…) */
  image?: string;
  /** in-app path (/media/tv/1396) or a web URL; `app` = the site's app URL scheme, tried first */
  link?: string;
  app?: string;
  badge?: { text: string; tone: "success" | "primary" | "live" | "warn" | "bilibili" | "youtube" };
  /** a work not in the library: 入库 on the card, 全部入库 on the block */
  ingest?: { type: "movie" | "tv"; tmdbid: number };
  /** an Emby item: the long-press sheet (played / favourite / cast) */
  embyId?: string;
}

type Raw = Record<string, any>;
const tmdbImg = (p: unknown, size: string) => (typeof p === "string" && p ? (/^https?:\/\//.test(p) ? p : `https://image.tmdb.org/t/p/${size}/${p.replace(/^.*\//, "")}`) : undefined);
const scheme = (u: unknown) => (typeof u === "string" && u ? (/^https?:\/\//.test(u) ? u : `https://${u.replace(/^\/+/, "")}`) : undefined);
const count = (n?: number | null) => (n == null ? "" : n >= 1e8 ? `${(n / 1e8).toFixed(1)}亿` : n >= 1e4 ? `${(n / 1e4).toFixed(1)}万` : String(n));
const join = (...a: unknown[]) => a.filter((x) => x !== undefined && x !== null && x !== "").join(" · ") || undefined;

// ---------- builders: raw route data → [ref, card] ----------

export const build = {
  work(m: Raw): [string, Card] | null {
    const type = m.type === "movie" ? "movie" : m.type === "tv" ? "tv" : null;
    const id = Number(m.tmdbid ?? m.tmdb_id);
    if (!type || !id) return null;
    const lib = "inLibrary" in m ? !!m.inLibrary : "library" in m ? !!m.library : undefined;
    return [`${type}:${id}`, {
      shape: "poster", title: m.title ?? m.name ?? "", sub: join(m.year, type === "movie" ? "电影" : "剧集"),
      image: tmdbImg(m.poster, "w342"), link: `/media/${type}/${id}`,
      ...(lib ? { badge: { text: "已入库", tone: "success" as const } } : lib === false ? { ingest: { type, tmdbid: id } } : {}),
    }];
  },
  person(p: Raw): [string, Card] | null {
    const id = Number(p.id ?? p.personId);
    if (!id || !p.name) return null;
    return [`person:${id}`, { shape: "avatar", title: p.name, sub: p.role || p.character || deptName(p.dept) || undefined, image: tmdbImg(p.photo, "w185"), link: `/person/${id}` }];
  },
  emby(i: Raw): [string, Card] | null {
    if (!i.id) return null;
    const ep = i.type === "Episode";
    const img = i.image?.id ? `/v1/img/emby/${i.image.id}?type=Primary&w=400${i.image.tag ? `&tag=${i.image.tag}` : ""}` : `/v1/img/emby/${ep && i.seriesId ? i.seriesId : i.id}?type=Primary&w=400`;
    return [`emby:${i.id}`, {
      shape: "poster", title: ep ? (i.series ?? i.name) : i.name, sub: ep ? `S${i.season ?? "?"}E${i.episode ?? "?"}${i.name ? ` ${i.name}` : ""}` : join(i.year, typeName(i.type)),
      image: img, link: `/emby/${i.id}`, embyId: i.id, badge: { text: "库内", tone: "success" },
    }];
  },
  video(v: Raw): [string, Card] | null {
    if (v.site !== "bilibili" && v.site !== "youtube") return null;
    const live = !!v.live;
    const id = String(v.roomId ?? v.id ?? "");
    if (!id) return null;
    const bili = v.site === "bilibili";
    const ref = `${bili ? "bili" : "yt"}${live ? "live" : ""}:${id}`;
    const web = bili ? (live ? `https://live.bilibili.com/${id}` : `https://www.bilibili.com/video/${id}`) : `https://www.youtube.com/watch?v=${id}`;
    return [ref, {
      shape: "wide", title: v.title ?? "", image: bili ? scheme(v.cover) : `https://i.ytimg.com/vi/${id}/mqdefault.jpg`, link: web,
      app: bili ? (live ? `bilibili://live/${id}` : `bilibili://video/${id}`) : `youtube://www.youtube.com/watch?v=${id}`,
      sub: live ? join(v.uname ?? v.author, v.online != null ? `人气 ${count(v.online)}` : "", v.area) : join(v.author, v.duration, v.views != null ? `${count(v.views)}播放` : "", v.published),
      badge: live ? { text: "直播中", tone: "live" } : bili ? { text: "B站", tone: "bilibili" } : { text: "YouTube", tone: "youtube" },
    }];
  },
  creator(c: Raw, site: string): [string, Card] | null {
    if (!c.id || !c.name) return null;
    const bili = site === "bilibili";
    return [`${bili ? "up" : "ytc"}:${c.id}`, {
      shape: "avatar", title: c.name, sub: join(c.followers != null ? `${count(c.followers)}粉丝` : "", bili ? "B站" : "YouTube"), image: scheme(c.avatar),
      link: c.url || (bili ? `https://space.bilibili.com/${c.id}` : `https://www.youtube.com/channel/${c.id}`), app: bili ? `bilibili://space/${c.id}` : undefined,
    }];
  },
  task(t: Raw): [string, Card] | null {
    if (!/^[0-9a-f]{40}$/.test(t.hash ?? "")) return null;
    return [`task:${t.hash}`, {
      shape: "row", title: t.title || t.name || t.hash.slice(0, 8), sub: join(statusName(t.status), t.percent != null && t.status !== "done" ? `${Math.round(t.percent)}%` : "", t.stage),
      link: `/task/${t.hash}`, ...(t.failed || t.status === "failed" ? { badge: { text: "失败", tone: "warn" as const } } : {}),
    }];
  },
  sub(s: Raw): [string, Card] | null {
    if (!s.id) return null;
    return [`sub:${s.id}`, {
      shape: "row", title: `${s.title}${s.season ? ` 第${s.season}季` : ""}`, image: scheme(s.poster),
      sub: join(s.state === "R" ? "追更中" : s.state === "P" ? "待定" : s.state === "S" ? "暂停" : s.state, s.lack != null && s.total ? `缺 ${s.lack}/${s.total} 集` : ""),
      link: `/subscription/${s.id}`,
    }];
  },
  catalog(provider: string, i: Raw): [string, Card] | null {
    if (!i.id) return null;
    return [`cat:${provider}:${i.id}`, { shape: "poster", title: i.title ?? String(i.id), sub: join(i.date, provider), image: i.poster || undefined, link: `/catalog/${provider}/${encodeURIComponent(i.id)}` }];
  },
};

const deptName = (d: unknown) => ({ Acting: "演员", Directing: "导演", Writing: "编剧", Production: "制片" } as Record<string, string>)[String(d)] ?? (typeof d === "string" ? d : "");
const typeName = (t: unknown) => ({ Movie: "电影", Series: "剧集", Episode: "单集", Video: "视频" } as Record<string, string>)[String(t)] ?? "";
const statusName = (s: unknown) => ({ done: "已完成", failed: "失败", downloading: "下载中", running: "进行中", waiting: "等待中" } as Record<string, string>)[String(s)] ?? (typeof s === "string" ? s : "");

// ---------- the per-chat store ----------

export type CardStore = Record<string, Card>;
const MAX = 400;

/** Register a card and return its ref (for the tool output's `card` field); null when it can't be a card. */
export function remember(store: CardStore, built: [string, Card] | null): string | undefined {
  if (!built) return undefined;
  const [ref, card] = built;
  delete store[ref];   // re-insert: newest last, oldest dropped first
  store[ref] = card;
  const keys = Object.keys(store);
  for (let i = 0; i < keys.length - MAX; i++) delete store[keys[i]];
  return ref;
}

/** A ref no tool registered in this chat (an older answer's, or one the model formed itself): look it up once. */
export async function lookup(app: FastifyInstance, ref: string, adult: boolean): Promise<Card | null> {
  const get = async (url: string) => {
    const r = await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${config.appToken}`, "x-request-id": "ai-card" } });
    return r.statusCode < 400 ? JSON.parse(r.body) : null;
  };
  const m = /^([a-z]+):(.+)$/.exec(ref);
  if (!m) return null;
  const [, kind, id] = m;
  try {
    if ((kind === "movie" || kind === "tv") && /^\d+$/.test(id)) {
      const r = await get(`/v1/media/${kind}/${id}`);
      return r?.media ? build.work({ ...r.media, type: kind, tmdbid: Number(id), inLibrary: !!r.library })?.[1] ?? null : null;
    }
    if (kind === "person" && /^\d+$/.test(id)) {
      const r = await get(`/v1/tmdb/person/${id}`);
      return r?.name ? build.person({ id, name: r.name, photo: r.photo, dept: r.dept })?.[1] ?? null : null;
    }
    if (kind === "emby" && /^\w+$/.test(id)) {
      const r = await get(`/v1/emby/item/${id}`);
      if (!r?.item || (!adult && /\/(AV|里番)\//.test(String(r.item.path ?? "")))) return null;
      return build.emby(r.item)?.[1] ?? null;
    }
    if (kind === "sub" && /^\d+$/.test(id)) {
      const r = await get("/v1/subscriptions");
      const s = (r?.items ?? []).find((x: Raw) => String(x.id) === id);
      return s ? build.sub(s)?.[1] ?? null : null;
    }
    if (kind === "task" && /^[0-9a-f]{40}$/.test(id)) return { shape: "row", title: "入库任务", sub: id.slice(0, 8), link: `/task/${id}` };
  } catch {
    // unknown or unreachable: no card
  }
  return null;
}

/** Refs in the ```cards blocks of a (possibly still streaming) answer: one per line, "ref | note". */
export function refsIn(text: string): string[] {
  const out: string[] = [];
  for (const b of text.matchAll(/```cards[ \t]*\n([\s\S]*?)(?:```|$)/g)) {
    const lines = b[1].split("\n");
    // the last line of an open block may still be streaming
    const done = b[0].endsWith("```") ? lines : lines.slice(0, -1);
    for (const l of done) {
      const r = /^\s*[-*]?\s*([a-z]+:[^\s|｜]+)/.exec(l)?.[1];
      if (r && !out.includes(r)) out.push(r);
    }
  }
  return out;
}
