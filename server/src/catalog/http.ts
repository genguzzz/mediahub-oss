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
import { Agent, Headers, Response, fetch as ufetch } from "undici";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { config } from "../config.ts";
import { dispatcherFor, proxyOf, solverOf, type Source } from "../egress.ts";
import { errText, logger } from "../log.ts";
import { onClearCaches } from "../cacheControl.ts";


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

// Pages are fetched from the site on every request. The cache only enforces a minimum interval per page (so the
// home's rows, scrolling and several viewers hit the site once a minute, not once each) — longer for pages behind
// Cloudflare, whose loads are costly and get challenged when frequent — and keeps the last good copy to answer
// with when a refetch fails (challenge, timeout), so a hiccup shows slightly old results instead of an error.
export const MIN_INTERVAL = { plain: 60_000, cloudflare: 3 * 60_000 };
const KEEP_GOOD = 24 * 3600_000;
const cache = new Map<string, { at: number; ttl: number; value: Promise<string> }>();
const good = new Map<string, { at: number; value: string }>();
onClearCaches(() => { cache.clear(); good.clear(); });
function remember(key: string, minMs: number, fn: () => Promise<string>): Promise<string> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value;
  const value = fn().then(
    (v) => { good.set(key, { at: Date.now(), value: v }); return v; },
    (e: unknown) => {
      cache.delete(key);
      const g = good.get(key);
      if (g && Date.now() - g.at < KEEP_GOOD && !(e instanceof LoginRequired)) {
        log.warn({ key: key.slice(0, 160), err: errText(e), ageMin: Math.round((Date.now() - g.at) / 60_000) }, "refetch failed, serving the last good copy");
        return g.value;
      }
      throw e;
    });
  cache.set(key, { at: Date.now(), ttl: minMs, value });
  if (cache.size > 800) for (const [k, v] of cache) if (Date.now() - v.at > v.ttl) cache.delete(k);
  if (good.size > 1500) for (const [k, v] of good) if (Date.now() - v.at > KEEP_GOOD) good.delete(k);
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

export function flare(url: string, urgent = false): Promise<string> {
  return remember(`flare:${url}`, MIN_INTERVAL.cloudflare, async () => {
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

// ---- Cloudflare clearance for proxied sources (JavDB challenges every client since 2026-11-02) ----
// A clearance only works from the IP and user agent that solved it, so it is solved by the source's own
// FlareSolverr (SOURCE_FLARESOLVERR) through the source's proxy, kept in $DATA_DIR/cf-clearance.json and
// sent (cf_clearance + that browser's user agent) with every request of the source, next to its login
// cookies. A new challenge drops it and solves again, once per request.
type Clr = { ua: string; cookie: string; at: number; host: string };
const CF_PAGE = /<title>Just a moment|Attention Required! \| Cloudflare|cf-chl-|challenge-platform/;
const CLR_FILE = () => path.join(config.dataDir, "cf-clearance.json");
let clrs: Partial<Record<Source, Clr>> | null = null;
const solving = new Map<Source, Promise<void>>();

async function clrLoad() {
  clrs ??= await readFile(CLR_FILE(), "utf8").then((t) => JSON.parse(t) as Partial<Record<Source, Clr>>).catch(() => ({}));
  return clrs;
}
async function clrSave() {
  await mkdir(config.dataDir, { recursive: true });
  await writeFile(CLR_FILE(), JSON.stringify(clrs), { mode: 0o600 });
}

/** Solve the challenge for `source` through its FlareSolverr and proxy; concurrent callers share one solve. */
export function renewClearance(source: Source, url: string): Promise<void> {
  const busy = solving.get(source);
  if (busy) return busy;
  const run = timed("cf-solve", url, async () => {
    const solver = solverOf(source);
    if (!solver) throw new Error(`${source} 被 Cloudflare 拦截，没有配置 SOURCE_FLARESOLVERR`);
    const proxy = proxyOf(source).replace(/^socks5h:/i, "socks5:");
    const res = await fetch(solver, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(90_000),
      body: JSON.stringify({ cmd: "request.get", url, maxTimeout: 60_000, ...(proxy ? { proxy: { url: proxy } } : {}) }) });
    const d = (await res.json()) as { status?: string; message?: string; solution?: { userAgent?: string; cookies?: { name: string; value: string }[] } };
    const cf = d.solution?.cookies?.find((c) => c.name === "cf_clearance");
    if (d.status !== "ok" || !cf || !d.solution?.userAgent) throw new Error(`Cloudflare 验证没过：${d.message ?? "没拿到 cf_clearance"}`);
    (await clrLoad())[source] = { ua: d.solution.userAgent, cookie: `cf_clearance=${cf.value}`, at: Date.now(), host: new URL(url).host };
    await clrSave();
    log.info({ source }, "cloudflare clearance renewed");
  }).finally(() => solving.delete(source));
  solving.set(source, run);
  return run;
}

// Hanime1's Cloudflare refuses Node's HTTP client by its TLS fingerprint even with a valid clearance
// (403 「Attention Required」), but serves curl: its requests go through a curl child process (no shell).
const CURL_SOURCES = new Set<Source>(["hanime1"]);
const run = promisify(execFile);

async function curlFetch(url: string, headers: Record<string, string>, init: { method?: string; body?: string; redirect?: "follow" | "manual" }, proxy: string): Promise<Response> {
  const args = ["-sS", "-i", "--compressed", "--max-time", "25", "-X", init.method ?? "GET"];
  if (init.redirect !== "manual") args.push("-L");
  if (proxy) args.push("-x", proxy.replace(/^socks5:/i, "socks5h:"));
  for (const [k, v] of Object.entries(headers)) args.push("-H", `${k}: ${v}`);
  if (init.body !== undefined) args.push("--data-binary", init.body);
  args.push("--", url);
  const { stdout } = await run("curl", args, { encoding: "buffer", maxBuffer: 32 << 20, timeout: 30_000 });
  // -i puts every header block (proxy CONNECT, redirects, final) before the body: keep the last one
  let body = stdout;
  let head = "";
  while (body.subarray(0, 5).toString("latin1") === "HTTP/") {
    const end = body.indexOf("\r\n\r\n");
    if (end < 0) break;
    head = body.subarray(0, end).toString("latin1");
    body = body.subarray(end + 4);
  }
  const [status = "", ...lines] = head.split("\r\n");
  const hs = new Headers();
  for (const l of lines) {
    const i = l.indexOf(":");
    if (i > 0) hs.append(l.slice(0, i).trim(), l.slice(i + 1).trim());
  }
  hs.delete("content-encoding");      // curl already decoded the body
  hs.delete("content-length");
  return new Response(body, { status: Number(status.split(" ")[1]) || 502, headers: hs });
}

export async function proxiedRaw(url: string, headers: Record<string, string> = {}, init: { method?: string; body?: string; redirect?: "follow" | "manual" } = {}, source: Source = "javdb") {
  for (let attempt = 0; ; attempt++) {
    const kept = (await clrLoad())[source];
    const clr = kept?.host === new URL(url).host ? kept : undefined;   // only for the host it was solved on (not the image CDN)
    const h: Record<string, string> = { "user-agent": UA, "accept-language": "zh-CN,zh;q=0.9", ...headers };
    if (clr) {
      h["user-agent"] = clr.ua;              // the clearance only holds with the browser that solved it
      h.cookie = [clr.cookie, headers.cookie].filter(Boolean).join("; ");
    }
    const res = CURL_SOURCES.has(source)
      ? await curlFetch(url, h, init, proxyOf(source))
      : await ufetch(url, { dispatcher: dispatcherFor(source), ...init, headers: h, signal: AbortSignal.timeout(25_000) });
    if ((res.status !== 403 && res.status !== 503) || res.headers.get("server") !== "cloudflare") return res;
    // JavDB marks its challenge with cf-mitigated; Hanime1 answers with an 「Attention Required」 page instead
    if (res.headers.get("cf-mitigated") === "challenge") await res.body?.cancel();
    else {
      const body = await res.text();
      if (!CF_PAGE.test(body)) return new Response(body, { status: res.status, headers: res.headers });
    }
    if (clr) {
      delete clrs![source];
      await clrSave();
    }
    if (attempt > 0) throw new Error(`${source} 刚过的 Cloudflare 验证不被接受`);
    await renewClearance(source, url);
  }
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
// `headers`: extra request headers a source expects (they replace the defaults of the same name).
const TRANSIENT = new Set([502, 503, 504, 520, 521, 522, 523, 524]);
export const RETRY_WAITS = [1500, 3000];

export function proxied(url: string, cookie = "", source: Source = "javdb", headers: Record<string, string> = {}): Promise<string> {
  return remember(`proxy:${cookie ? "auth:" : ""}${url}`, MIN_INTERVAL.plain, () => timed("proxy", url, async () => {
    let res = await proxiedRaw(url, { ...headers, ...(cookie ? { cookie } : {}) }, {}, source);
    // The site or Cloudflare briefly down (502/503/504, Cloudflare 520–524; Hanime1 gave 502s for ~90 s on 2026-11-04):
    // try again a little later instead of failing the page. A Cloudflare challenge is handled in proxiedRaw.
    for (const wait of RETRY_WAITS) {
      if (!TRANSIENT.has(res.status)) break;
      await res.body?.cancel();
      await new Promise((r) => setTimeout(r, wait));
      res = await proxiedRaw(url, { ...headers, ...(cookie ? { cookie } : {}) }, {}, source);
    }
    if (res.url && new URL(res.url).pathname === "/login") throw new LoginRequired("JavDB");
    if (res.status === 404) return "";
    if (!res.ok) throw new Error(TRANSIENT.has(res.status) ? `站点暂时不可用（${res.status}），稍后再试` : `页面返回 ${res.status}`);
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
