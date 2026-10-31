// Page fetchers for web catalogs, with a small in-memory cache:
// - flare(): Jable sits behind a Cloudflare challenge; FlareSolverr (Docker, default
//   127.0.0.1:8191) passes it in a real browser (~8–25 s, more on a busy 2-core server). Its answer
//   carries the clearance cookie and the browser's user agent; while that clearance holds, pages are
//   plain HTTP requests with it (~0.3 s). Cloudflare binds the clearance to the client IP: FlareSolverr's
//   Docker network is IPv4-only, so these requests go out over IPv4 too (over the host's IPv6 they were
//   challenged again). When Cloudflare challenges anyway, the clearance is dropped and the next page goes
//   through FlareSolverr, which renews it.
// - proxied(): pages from a source whose exit is configured per source (egress.ts, SOURCE_PROXY;
//   JavDB blocks some countries, so its default is INDEX_PROXY)
//   (e.g. home broadband) and pages and images go through it. Unset = direct.
import { Agent, fetch as ufetch } from "undici";
import { dispatcherFor, type Source } from "../egress.ts";
import { errText, logger } from "../log.ts";

const log = logger("catalog-http");
const SLOW_MS = 8000;
// Page loads: one line when a page fails or is slow (successful fast loads stay quiet).
async function timed<T>(via: string, url: string, run: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  const where = url.replace(/^https?:\/\//, "").slice(0, 160);
  try {
    const v = await run();
    const ms = Date.now() - t0;
    if (ms > SLOW_MS) log.info({ via, url: where, ms }, "page slow");
    return v;
  } catch (e) {
    log.warn({ via, url: where, ms: Date.now() - t0, err: errText(e) }, "page failed");
    throw e;
  }
}

const FLARE = process.env.FLARESOLVERR_URL ?? "http://127.0.0.1:8191/v1";
export const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36";

const cache = new Map<string, { at: number; ttl: number; value: Promise<string> }>();
function remember(key: string, ttlMs: number, fn: () => Promise<string>): Promise<string> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value;
  const value = fn();
  cache.set(key, { at: Date.now(), ttl: ttlMs, value });
  value.catch(() => cache.delete(key));
  if (cache.size > 800) for (const [k, v] of cache) if (Date.now() - v.at > v.ttl) cache.delete(k);
  return value;
}

// Two browser sessions: each is a headless Chrome (~0.7 GB, a core while loading); three on a 2-core
// server pushed the load past 7 and made pages time out.
const free = ["mediahub-1", "mediahub-2"];
const created = new Set<string>();
// Waiting requests: `urgent` ones (a work's page — playback sources, resolving a stream — that someone is
// looking at) go ahead of list loads, which take 15–80 s each through the challenge and include the
// 25-minute home warm-up; in arrival order they kept a detail's 在线播放 waiting up to 105 s.
const waiting: ((s: string) => void)[] = [];
async function slot<T>(fn: (session: string) => Promise<T>, urgent = false): Promise<T> {
  const session = free.shift() ?? (await new Promise<string>((r) => (urgent ? waiting.unshift(r) : waiting.push(r))));
  try {
    return await fn(session);
  } finally {
    const next = waiting.shift();
    if (next) next(session);
    else free.push(session);
  }
}

async function flareCall(body: Record<string, unknown>, timeoutMs = 75_000) {
  const res = await fetch(FLARE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  return (await res.json()) as { status?: string; message?: string; solution?: { status: number; response: string; userAgent?: string; cookies?: { name: string; value: string; domain?: string; expires?: number }[] } };
}

// Clearance per site from FlareSolverr's last answer: its cookies and user agent.
const clearance = new Map<string, { cookie: string; ua: string; until: number }>();
const ipv4 = new Agent({ connect: { family: 4 } });

function keepClearance(url: string, sol: { userAgent?: string; cookies?: { name: string; value: string; expires?: number }[] }) {
  const cf = sol.cookies?.find((c) => c.name === "cf_clearance");
  if (!cf || !sol.userAgent) return;
  const until = cf.expires && cf.expires > 0 ? Math.min(cf.expires * 1000, Date.now() + 6 * 3600_000) : Date.now() + 30 * 60_000;
  clearance.set(new URL(url).host, { cookie: (sol.cookies ?? []).map((c) => `${c.name}=${c.value}`).join("; "), ua: sol.userAgent, until });
}

// A page with the kept clearance: its text, "" for 404, or null when there is none or Cloudflare
// challenged again (the clearance is dropped; the caller goes through FlareSolverr, which renews it).
async function withClearance(url: string): Promise<string | null> {
  const host = new URL(url).host;
  const c = clearance.get(host);
  if (!c || Date.now() > c.until) return null;
  const res = await ufetch(url, { dispatcher: ipv4, headers: { "user-agent": c.ua, cookie: c.cookie, "accept-language": "zh-CN,zh;q=0.9", accept: "text/html,application/xhtml+xml,*/*;q=0.8" }, signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  if (res.status === 403 || res.status === 503 || /<title>Just a moment|cf-chl-/.test(text)) {
    clearance.delete(host);
    log.info({ host, status: res.status }, "clearance no longer accepted, renewing through FlareSolverr");
    return null;
  }
  if (res.status === 404) return "";
  if (!res.ok) throw new Error(`页面返回 ${res.status}`);
  return text;
}

export function flare(url: string, ttlMs = 30 * 60_000, urgent = false): Promise<string> {
  return remember(`flare:${url}`, ttlMs, async () => {
    const fast = await timed("cf-clearance", url, () => withClearance(url)).catch(() => null);
    return fast !== null ? fast : viaBrowser(url, urgent);
  });
}

function viaBrowser(url: string, urgent: boolean): Promise<string> {
  return timed("flaresolverr", url, () => slot(async (session) => {
    if (!created.has(session)) {
      await flareCall({ cmd: "sessions.destroy", session }).catch(() => null);
      await flareCall({ cmd: "sessions.create", session });
      created.add(session);
    }
    const d = await flareCall({ cmd: "request.get", session, url, maxTimeout: 60_000 }).catch((e: Error) => ({ status: "error", message: e.message }) as { status?: string; message?: string; solution?: undefined });
    if (d.status !== "ok" || !d.solution) {
      created.delete(session); // a broken browser session: start a fresh one next time
      throw new Error(`FlareSolverr：${d.message ?? "无响应"}`);
    }
    keepClearance(url, d.solution);
    if (d.solution.status === 404) return "";
    if (d.solution.status >= 400) throw new Error(`页面返回 ${d.solution.status}`);
    return d.solution.response;
  }, urgent));
}

export async function proxiedRaw(url: string, headers: Record<string, string> = {}, init: { method?: string; body?: string; redirect?: "follow" | "manual" } = {}, source: Source = "javdb") {
  return ufetch(url, { dispatcher: dispatcherFor(source), ...init, headers: { "user-agent": UA, "accept-language": "zh-CN,zh;q=0.9", ...headers }, signal: AbortSignal.timeout(25_000) });
}

/** The page needs a logged-in account (the site redirected to its login page). */
export class LoginRequired extends Error {
  statusCode = 403;            // not 401: the app reads 401 as its own token being wrong
  code = "login_required";     // the app shows "去设置登录" instead of 重试
  site: string;
  constructor(site: string) {
    super(`${site} 需要登录：设置 → ${site} 账号`);
    this.site = site;
  }
}

// `cookie`: a logged-in session (JavDB); pages fetched with and without it are cached apart.
export function proxied(url: string, ttlMs = 30 * 60_000, cookie = "", source: Source = "javdb"): Promise<string> {
  return remember(`proxy:${cookie ? "auth:" : ""}${url}`, ttlMs, () => timed("proxy", url, async () => {
    const res = await proxiedRaw(url, cookie ? { cookie } : {}, {}, source);
    if (res.url && new URL(res.url).pathname === "/login") throw new LoginRequired("JavDB");
    if (res.status === 404) return "";
    if (!res.ok) throw new Error(`页面返回 ${res.status}`);
    const text = await res.text();
    if (text.includes("Due to copyright restrictions")) throw new Error("索引站拒绝了当前出口地区");
    return text;
  }));
}

// ---- tiny HTML helpers (the pages are server-rendered and stable enough for regexes) ----

export const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
export const text = (html: string) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
export { extUrl as img } from "../imageUrls.ts";

// Split a list page into the HTML of each item, starting at every match of `start`.
export function chunks(html: string, start: RegExp): string[] {
  const idx = [...html.matchAll(new RegExp(start.source, "g"))].map((m) => m.index!);
  return idx.map((s, i) => html.slice(s, idx[i + 1] ?? s + 4000));
}

export const num = (s?: string | null) => Number((s ?? "").replace(/[^\d.]/g, "")) || 0;
