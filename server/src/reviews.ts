// What people say about a work, for the assistant's recommendations (beyond the score): Douban's star
// distribution, want / watched counts, its hot short comments (each with the writer's stars) and the most
// useful long reviews. The subject is found with movie.douban.com's search suggest (the mobile search refuses
// some titles), the rest comes from Douban's mobile site API (m.douban.com/rexxar); both need only a Referer.
// Seasons are separate Douban subjects, picked by 「第N季」 and year. Goes out per egress.ts (source `douban`).
import { fetch as ufetch } from "undici";
import { dispatcherFor } from "./egress.ts";
import { logger } from "./log.ts";

const log = logger("reviews");
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const BASE = "https://m.douban.com/rexxar/api/v2";

async function get<T>(url: string, referer: string): Promise<T> {
  const t0 = Date.now();
  const r = await ufetch(url, { dispatcher: dispatcherFor("douban"), headers: { "user-agent": UA, referer }, signal: AbortSignal.timeout(15_000) });
  if (Date.now() - t0 > 5000) log.info({ path: new URL(url).pathname, ms: Date.now() - t0 }, "slow douban call");
  if (!r.ok) throw new Error(`豆瓣返回 ${r.status}`);
  return (await r.json()) as T;
}
const rexxar = <T>(p: string) => get<T>(`${BASE}${p}`, "https://m.douban.com/");

const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
const CN_NUM = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];

export interface DoubanSubject { id: string; type: "movie" | "tv"; title: string; year: string; rating: number | null; card: string }

/** The Douban subject for a work (a show's season N when given: Douban lists seasons separately). */
export async function doubanFind(title: string, year: string, type: "movie" | "tv", season?: number): Promise<DoubanSubject | null> {
  // suggest: id, title, year, episode count ("" for films); seasons are separate entries
  const sug = await get<{ id?: string; title?: string; year?: string; episode?: string; sub_title?: string }[]>(
    `https://movie.douban.com/j/subject_suggest?q=${encodeURIComponent(title)}`, "https://movie.douban.com/").catch((e: unknown) => {
    log.warn({ title, err: e instanceof Error ? e.message : String(e) }, "douban suggest failed");
    return [];
  });
  let cands: DoubanSubject[] = sug.filter((x) => x.id && (type === "tv") === !!x.episode).map((x) => ({
    id: String(x.id), type, title: String(x.title ?? ""), year: String(x.year ?? ""), rating: null, card: String(x.sub_title ?? ""),
  }));
  if (!cands.length) {
    const d = await rexxar<{ subjects?: { items?: { target_type?: string; target?: Record<string, any> }[] } }>(`/search?q=${encodeURIComponent(title)}&type=movie&count=20`).catch(() => ({ subjects: undefined }));
    cands = (d.subjects?.items ?? []).filter((x) => x.target_type === type && x.target?.id).map((x) => ({
      id: String(x.target!.id), type, title: String(x.target!.title ?? ""), year: String(x.target!.year ?? ""),
      rating: Number(x.target!.rating?.value) || null, card: String(x.target!.card_subtitle ?? ""),
    }));
  }
  const y = Number(year) || 0;
  const near = (c: DoubanSubject) => !y || Math.abs(Number(c.year) - y) <= 1;
  const named = (c: DoubanSubject) => norm(c.title).startsWith(norm(title));
  // season 1 of a show is often listed as 「X 第一季」; a later season must name its number
  const seasonOk = (c: DoubanSubject) => !season || season <= 1 || c.title.includes(`第${CN_NUM[season] ?? season}季`);
  return cands.find((c) => named(c) && seasonOk(c) && near(c)) ?? cands.find((c) => named(c) && seasonOk(c)) ?? (y ? cands.find(near) : undefined) ?? null;
}

export interface DoubanReviews {
  subject: DoubanSubject & { url: string };
  stars: Record<string, number> | null;    // "5" … "1" → share of ratings (%)
  watched: number | null; watching: number | null; wish: number | null;
  comments: { stars: number | null; text: string; votes: number; date: string }[];
  reviews: { title: string; stars: number | null; useful: number; abstract: string; url: string }[];
}

export async function doubanReviews(s: DoubanSubject, n = 20): Promise<DoubanReviews> {
  const [rating, interests, reviews] = await Promise.all([
    rexxar<{ stats?: number[]; done_count?: number; doing_count?: number; wish_count?: number }>(`/${s.type}/${s.id}/rating`).catch(() => null),
    rexxar<{ interests?: Record<string, any>[] }>(`/${s.type}/${s.id}/interests?count=${n}&order_by=hot`),
    rexxar<{ reviews?: Record<string, any>[] }>(`/${s.type}/${s.id}/reviews?count=5`).catch(() => ({ reviews: [] })),
  ]);
  const st = rating?.stats;
  // Douban's score is the mean star × 2
  const score = st?.length === 5 ? Math.round(st.reduce((m, p, i) => m + p * (i + 1), 0) * 20) / 10 : null;
  return {
    subject: { ...s, rating: s.rating ?? score, url: `https://movie.douban.com/subject/${s.id}/` },
    // Douban sends 1★ … 5★
    stars: st?.length === 5 ? Object.fromEntries([5, 4, 3, 2, 1].map((k) => [String(k), Math.round(st[k - 1] * 1000) / 10])) : null,
    watched: rating?.done_count ?? null, watching: rating?.doing_count ?? null, wish: rating?.wish_count ?? null,
    comments: (interests.interests ?? []).filter((x) => x.comment).map((x) => ({
      stars: Number(x.rating?.value) || null, text: String(x.comment).slice(0, 200), votes: Number(x.vote_count) || 0, date: String(x.create_time ?? "").slice(0, 10),
    })),
    reviews: (reviews.reviews ?? []).map((x) => ({
      title: String(x.title ?? ""), stars: Number(x.rating?.value) || null, useful: Number(x.useful_count) || 0,
      abstract: String(x.abstract ?? "").replace(/\s+/g, " ").slice(0, 240), url: String(x.url ?? ""),
    })),
  };
}
