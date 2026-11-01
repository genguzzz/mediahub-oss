// Online subtitles from several sources behind one search, for the app's player (在线字幕) and the assistant:
//   xunlei    — 迅雷's subtitle index (no key; name search; direct srt/ass files with language and duration)
//   assrt     — 射手网(伪) (ASSRT_TOKEN; results are packs, listed with assrtFiles)
//   sub_share — the open Chinese anime archive on GitHub (through the plugin, by work + episode)
// A result's `source` names one file ("xunlei:<cid>.<ext>", "assrt:<id>/<n>", "sub_share:<path>") or, for an
// assrt pack, the pack ("assrt:<id>", pack=true). subtitleBytes(source) fetches a file from any of them.
import { fetch as ufetch } from "undici";
import { assrtEnabled, assrtFileUrl, assrtSearch } from "./assrt.ts";
import { logger } from "./log.ts";

const log = logger("subsearch");

export interface SubResult {
  source: string; provider: "xunlei" | "assrt" | "sub_share"; name: string; lang: string; format: string;
  pack?: boolean; release?: string; durationSec?: number; match?: "episode" | "duration";
}
export interface SubQuery { names: string[]; season?: number; episode?: number; runtimeSec?: number; year?: number; anime?: boolean }

const XUNLEI_FILE = (cid: string, ext: string) => `https://subtitle.v.geilijiasu.com/${cid.slice(0, 2)}/${cid.slice(2, 4)}/${cid}.${ext}`;
const sxe = (s?: number, e?: number) => (s != null && e != null ? `S${String(s).padStart(2, "0")}E${String(e).padStart(2, "0")}` : "");

async function xunlei(q: SubQuery): Promise<SubResult[]> {
  const ep = sxe(q.season, q.episode);
  const out: SubResult[] = [];
  // the Chinese name first, then the next one (often English / original) when the first finds little
  for (const name of q.names.slice(0, 2)) {
    const r = await ufetch(`https://api-shoulei-ssl.xunlei.com/oracle/subtitle?name=${encodeURIComponent(ep ? `${name} ${ep}` : name)}`, { signal: AbortSignal.timeout(15_000) });
    const d = (await r.json().catch(() => ({}))) as { code?: number; data?: Record<string, any>[] };
    for (const x of d.data ?? []) {
      const cid = String(x.cid ?? "");
      const ext = String(x.ext ?? "").toLowerCase();
      if (!/^[0-9A-F]{40}$/i.test(cid) || !["srt", "ass", "ssa", "vtt"].includes(ext)) continue;
      out.push({ source: `xunlei:${cid}.${ext}`, provider: "xunlei", name: String(x.name ?? x.simple_name ?? cid), lang: (x.languages ?? []).join("/"), format: ext, durationSec: x.duration ? Math.round(Number(x.duration) / 1000) : undefined });
    }
    if (out.length >= 5) break;
  }
  return out;
}

async function assrt(q: SubQuery): Promise<SubResult[]> {
  const ep = sxe(q.season, q.episode);
  const list = await assrtSearch(q.names[0]);
  return list.map((x) => ({ source: x.source, provider: "assrt" as const, name: x.title, release: x.release, lang: x.lang, format: x.format, pack: true }))
    // for an episode, packs of other seasons are noise
    .filter((x) => !ep || !/S\d{2}/i.test(x.release ?? "") || new RegExp(`S${ep.slice(1, 3)}`, "i").test(x.release ?? ""));
}

type Plug = (path: string, query: Record<string, string | number>) => Promise<{ ok: boolean; work?: string | null; files?: Record<string, string> } | null>;

async function subShare(q: SubQuery, plugGet: Plug): Promise<SubResult[]> {
  if (!q.year || !q.anime) return [];
  const r = await plugGet("/hub/subs/online", { names: q.names.join(","), year: q.year, season: q.season ?? 1, episodes: q.episode ?? "" });
  if (!r?.ok || !r.files) return [];
  return Object.entries(r.files).map(([ep, source]) => ({ source, provider: "sub_share" as const, name: `${r.work ?? ""} 第 ${ep} 集`, lang: "简", format: source.split(".").pop() ?? "ass" }));
}

const LANG_RANK = (l: string) => (/双语|英.*简|简.*英/.test(l) ? 3 : /简|chs|sc/i.test(l) ? 2 : /繁|cht|tc/i.test(l) ? 1 : 0);

/** All sources in parallel; one failing doesn't stop the others. Best first: the episode, a matching duration, 简 / 双语. */
export async function searchSubtitles(q: SubQuery, plugGet: Plug): Promise<{ results: SubResult[]; errors: Record<string, string> }> {
  const errors: Record<string, string> = {};
  const run = (name: string, f: () => Promise<SubResult[]>) => f().catch((e: unknown) => {
    errors[name] = e instanceof Error ? e.message : String(e);
    log.warn({ provider: name, err: errors[name] }, "subtitle source failed");
    return [] as SubResult[];
  });
  const lists = await Promise.all([
    run("xunlei", () => xunlei(q)),
    assrtEnabled() ? run("assrt", () => assrt(q)) : Promise.resolve([] as SubResult[]),
    run("sub_share", () => subShare(q, plugGet)),
  ]);
  const ep = sxe(q.season, q.episode);
  // the episode as release names write it: S02E03, 2x03, ＃3, 第3集, [03], " 03 ", E03 (a bare number needs two digits)
  const n = q.episode;
  const two = n == null ? "" : String(n).padStart(2, "0");
  const epRe = n == null ? null : new RegExp(`${ep ? `${ep}|\\b${q.season}x${two}\\b|` : ""}[#＃第]\\s*0?${n}(?!\\d)|\\[${two}(v\\d)?\\]|(^|[\\s._-])(e|ep)?${two}(v\\d)?([\\s._\\-\\[(]|$)`, "i");
  const results = lists.flat().map((r) => {
    if (epRe && !r.pack && (r.provider === "sub_share" || epRe.test(`${r.name} ${r.release ?? ""}`))) r.match = "episode";
    else if (q.runtimeSec && r.durationSec && Math.abs(r.durationSec - q.runtimeSec) < q.runtimeSec * 0.02) r.match = "duration";
    return r;
  });
  const score = (r: SubResult) => (r.match === "episode" ? 20 : r.match === "duration" ? 10 : 0) + LANG_RANK(r.lang) * 2 + (r.pack ? -1 : 0) + (r.provider === "sub_share" ? 3 : 0);
  return { results: results.sort((a, b) => score(b) - score(a)).slice(0, 40), errors };
}

const ONLINE = /^(xunlei|assrt|sub_share):/;
export const isOnlineSource = (s: string) => ONLINE.test(s);

/** One online subtitle file's bytes and name (packs and archives are refused). */
export async function onlineSubtitle(source: string): Promise<{ body: Buffer; name: string }> {
  let url: string;
  let name: string;
  if (source.startsWith("xunlei:")) {
    const m = /^xunlei:([0-9A-F]{40})\.(srt|ass|ssa|vtt)$/i.exec(source);
    if (!m) throw Object.assign(new Error("迅雷字幕 source 格式不对"), { statusCode: 400 });
    url = XUNLEI_FILE(m[1].toUpperCase(), m[2].toLowerCase());
    name = `${m[1]}.${m[2]}`;
  } else if (source.startsWith("assrt:")) {
    ({ url, name } = await assrtFileUrl(source));
  } else {
    url = `https://raw.githubusercontent.com/foxofice/sub_share/master/${source.slice(10).split("/").map(encodeURIComponent).join("/")}`;
    name = source;
  }
  if (!/\.(ass|ssa|srt|vtt)$/i.test(name)) throw Object.assign(new Error("这是压缩包或字幕包，不能直接读：先列出里面的字幕文件"), { statusCode: 400 });
  const r = await ufetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw Object.assign(new Error(`下载字幕失败（${r.status}）`), { statusCode: 502 });
  const body = Buffer.from(await r.arrayBuffer());
  if (body.length > 10 * 1024 * 1024) throw Object.assign(new Error("字幕文件太大"), { statusCode: 413 });
  return { body, name };
}

/** A URL the plugin can download (installing an online subtitle beside the strm or on 115). */
export async function onlineSubtitleUrl(source: string): Promise<string> {
  if (source.startsWith("xunlei:")) {
    const m = /^xunlei:([0-9A-F]{40})\.(srt|ass|ssa|vtt)$/i.exec(source);
    if (!m) throw Object.assign(new Error("迅雷字幕 source 格式不对"), { statusCode: 400 });
    return XUNLEI_FILE(m[1].toUpperCase(), m[2].toLowerCase());
  }
  return (await assrtFileUrl(source)).url;
}
