// Page fetchers for web catalogs, with a small in-memory cache:
// - flare(): Jable sits behind a Cloudflare challenge; FlareSolverr (Docker, default
//   127.0.0.1:8191) loads the page in a real browser. Three long-lived FlareSolverr sessions keep
//   the clearance cookie: the first page of a session takes ~15 s, later ones 1-4 s.
// - proxied(): JavDB blocks some countries; set INDEX_PROXY to a proxy with a suitable exit
//   (e.g. home broadband) and pages and images go through it. Unset = direct.
import { Agent, fetch as ufetch, ProxyAgent } from "undici";

const FLARE = process.env.FLARESOLVERR_URL ?? "http://127.0.0.1:8191/v1";
const PROXY = process.env.INDEX_PROXY ?? "";
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

const free = ["mediahub-1", "mediahub-2", "mediahub-3"];
const created = new Set<string>();
const waiting: ((s: string) => void)[] = [];
async function slot<T>(fn: (session: string) => Promise<T>): Promise<T> {
  const session = free.shift() ?? (await new Promise<string>((r) => waiting.push(r)));
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
  return (await res.json()) as { status?: string; message?: string; solution?: { status: number; response: string } };
}

export function flare(url: string, ttlMs = 30 * 60_000): Promise<string> {
  return remember(`flare:${url}`, ttlMs, () => slot(async (session) => {
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
    if (d.solution.status === 404) return "";
    if (d.solution.status >= 400) throw new Error(`页面返回 ${d.solution.status}`);
    return d.solution.response;
  }));
}

const agent = PROXY ? new ProxyAgent(PROXY) : new Agent();

export async function proxiedRaw(url: string, headers: Record<string, string> = {}) {
  return ufetch(url, { dispatcher: agent, headers: { "user-agent": UA, "accept-language": "zh-CN,zh;q=0.9", ...headers }, signal: AbortSignal.timeout(25_000) });
}

export function proxied(url: string, ttlMs = 30 * 60_000): Promise<string> {
  return remember(`proxy:${url}`, ttlMs, async () => {
    const res = await proxiedRaw(url);
    if (res.status === 404) return "";
    if (!res.ok) throw new Error(`页面返回 ${res.status}`);
    const text = await res.text();
    if (text.includes("Due to copyright restrictions")) throw new Error("索引站拒绝了当前出口地区");
    return text;
  });
}

// ---- tiny HTML helpers (the pages are server-rendered and stable enough for regexes) ----

export const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
export const text = (html: string) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
export const img = (u?: string | null) => (u ? `/v1/img/ext?u=${encodeURIComponent(u)}` : null);

// Split a list page into the HTML of each item, starting at every match of `start`.
export function chunks(html: string, start: RegExp): string[] {
  const idx = [...html.matchAll(new RegExp(start.source, "g"))].map((m) => m.index!);
  return idx.map((s, i) => html.slice(s, idx[i + 1] ?? s + 4000));
}

export const num = (s?: string | null) => Number((s ?? "").replace(/[^\d.]/g, "")) || 0;
