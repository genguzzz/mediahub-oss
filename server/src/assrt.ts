// 射手网(伪) assrt.net: the subtitle search API (Chinese subtitles for films and series; ASSRT_TOKEN, a free
// account's token, limited to ~20 calls a minute — results are cached). Search → releases; a release's
// detail lists its files, each with a short-lived download link, so files are resolved again when read.
import { fetch as ufetch } from "undici";
import { logger } from "./log.ts";

const log = logger("assrt");
const API = "https://api.assrt.net/v1";

export const assrtEnabled = () => !!process.env.ASSRT_TOKEN;

async function get<T>(p: string, q: Record<string, string | number>): Promise<T> {
  const token = process.env.ASSRT_TOKEN;
  if (!token) throw Object.assign(new Error("没有配置 ASSRT_TOKEN（射手网字幕搜索）"), { statusCode: 503 });
  const u = new URL(`${API}${p}`);
  for (const [k, v] of Object.entries({ ...q, token })) u.searchParams.set(k, String(v));
  const r = await ufetch(u, { signal: AbortSignal.timeout(20_000) });
  const d = (await r.json().catch(() => ({}))) as { status?: number; errmsg?: string } & T;
  // never log the URL: it carries the token
  if (d.status !== 0) {
    log.warn({ path: p, status: d.status, err: d.errmsg }, "assrt call failed");
    throw new Error(`射手网：${d.errmsg || `错误 ${d.status ?? r.status}`}`);
  }
  return d;
}

export interface AssrtRelease { source: string; title: string; release: string; lang: string; format: string; site: string; uploaded: string; votes: number }

export async function assrtSearch(q: string, limit = 15): Promise<AssrtRelease[]> {
  const d = await get<{ sub?: { subs?: Record<string, any>[] } }>("/sub/search", { q, cnt: limit, pos: 0 });
  return (d.sub?.subs ?? []).filter((x) => x.id).map((x) => ({
    source: `assrt:${x.id}`,
    title: String(x.native_name ?? "").replace(/\s+/g, " ").trim(),
    release: String(x.videoname ?? ""),
    lang: String(x.lang?.desc ?? ""),
    format: String(x.subtype ?? ""),
    site: String(x.release_site ?? ""),
    uploaded: String(x.upload_time ?? "").slice(0, 10),
    votes: Number(x.vote_score) || 0,
  }));
}

/** A release's subtitle files (source "assrt:<id>/<n>"), with their current download links. */
export async function assrtFiles(id: string): Promise<{ source: string; name: string; size: string; url: string }[]> {
  const d = await get<{ sub?: { subs?: Record<string, any>[] } }>("/sub/detail", { id });
  const s = d.sub?.subs?.[0];
  if (!s) throw new Error("射手网没有这个字幕");
  const list = (s.filelist ?? []) as { f: string; s: string; url: string }[];
  // a release with one file has no file list, only the download itself
  if (!list.length && s.url) return [{ source: `assrt:${id}/0`, name: String(s.filename ?? "subtitle"), size: String(s.size ?? ""), url: String(s.url) }];
  return list.filter((f) => /\.(ass|ssa|srt|vtt)$/i.test(f.f)).map((f, i) => ({ source: `assrt:${id}/${i + 1}`, name: f.f, size: f.s, url: f.url }));
}

/** The download link of one file ("assrt:<id>/<n>"). */
export async function assrtFileUrl(source: string): Promise<{ url: string; name: string }> {
  const m = /^assrt:(\d+)\/(\d+)$/.exec(source);
  if (!m) throw Object.assign(new Error("source 要是 assrt:<id>/<n>（先列出文件）"), { statusCode: 400 });
  const files = await assrtFiles(m[1]);
  const f = files.find((x) => x.source === source);
  if (!f) throw Object.assign(new Error("这个字幕包里没有这个文件"), { statusCode: 404 });
  return { url: f.url, name: f.name };
}
