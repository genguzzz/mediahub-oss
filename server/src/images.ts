// Poster/backdrop cache on disk. Emby images come through the plugin (the Emby key stays in
// MP); TMDb images are fetched here so the phone never needs to reach image.tmdb.org.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.ts";
import { plugBytes } from "./mp.ts";
import { proxiedRaw } from "./catalog/http.ts";
import { errText, logger, once } from "./log.ts";

const log = logger("images");
const SLOW_MS = 4000;
type Got = { body: Buffer; type: string } | null;

// Fetch one upstream image and say what happened when it did not work (status, error, time) or was slow.
// Failures are not cached, so the next request retries; the same image is logged once per 10 minutes.
async function fetchImage(kind: string, url: string, run: () => Promise<{ ok: boolean; status: number; headers: { get(n: string): string | null }; arrayBuffer(): Promise<ArrayBuffer> }>): Promise<Got> {
  const t0 = Date.now();
  const where = (() => {
    try {
      const u = new URL(url);
      return { host: u.hostname, path: u.pathname.slice(0, 120) };
    } catch {
      return { host: "", path: url.slice(0, 120) };
    }
  })();
  try {
    const res = await run();
    const ms = Date.now() - t0;
    if (!res.ok) {
      const skipped = once(`${kind}:${url}`);
      if (skipped !== null) log.warn({ kind, ...where, status: res.status, ms, repeats: skipped }, "image upstream failed");
      return null;
    }
    const body = Buffer.from(await res.arrayBuffer());
    const type = res.headers.get("content-type") ?? "image/jpeg";
    if (!body.length || !type.startsWith("image/")) {
      log.warn({ kind, ...where, type, bytes: body.length, ms }, "image upstream returned no image");
      return null;
    }
    if (Date.now() - t0 > SLOW_MS) log.info({ kind, ...where, bytes: body.length, ms: Date.now() - t0 }, "image upstream slow");
    return { body, type };
  } catch (e) {
    const skipped = once(`${kind}:${url}`);
    if (skipped !== null) log.warn({ kind, ...where, err: errText(e), ms: Date.now() - t0, repeats: skipped }, "image upstream failed");
    return null;
  }
}

const inflight = new Map<string, Promise<{ body: Buffer; type: string } | null>>();

async function cached(key: string, fetcher: () => Promise<{ body: Buffer; type: string } | null>, maxAgeMs: number) {
  const name = createHash("sha1").update(key).digest("hex");
  const file = path.join(config.cacheDir, name.slice(0, 2), name);
  try {
    const st = await stat(file);
    if (Date.now() - st.mtimeMs < maxAgeMs) {
      const buf = await readFile(file);
      const sep = buf.indexOf(0x0a);
      return { type: buf.subarray(0, sep).toString(), body: buf.subarray(sep + 1) };
    }
  } catch {
    // miss
  }
  let p = inflight.get(key);
  if (!p) {
    p = fetcher();
    inflight.set(key, p);
    void p.finally(() => inflight.delete(key));
  }
  const got = await p;
  if (got && got.body.length > 0) {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, Buffer.concat([Buffer.from(got.type + "\n"), got.body]));
    await rename(tmp, file);
  }
  return got;
}

export function embyImage(id: string, type: string, w: number, tag: string) {
  // With a tag the image is immutable; without one refresh daily.
  return cached(`emby:${id}:${type}:${w}:${tag}`, async () => {
    const t0 = Date.now();
    const got = await plugBytes("/hub/emby/image", { id, type, w, tag });
    if (!got && once(`emby:${id}:${type}`) !== null) log.warn({ kind: "emby", id, type, ms: Date.now() - t0 }, "image upstream failed");
    return got;
  }, tag ? 30 * 86400_000 : 86400_000);
}

export function tmdbImage(size: string, file: string) {
  const url = `https://image.tmdb.org/t/p/${size}/${file}`;
  return cached(`tmdb:${size}:${file}`, () => fetchImage("tmdb", url, () => fetch(url, { signal: AbortSignal.timeout(20_000) })), 90 * 86400_000);
}

// "https://image.tmdb.org/t/p/original/abc.jpg" or "/abc.jpg" → "/v1/img/tmdb/w342/abc.jpg"
export function tmdbPath(src: string | null | undefined, size = "w342"): string | null {
  if (!src) return null;
  const m = /([A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp))$/.exec(src);
  return m ? `/v1/img/tmdb/${size}/${m[1]}` : null;
}

// Posters from Bangumi / Douban (discover lists) and hanime (里番 index). Douban refuses hotlinks without its Referer.
const EXT_HOSTS = /^(lain\.bgm\.tv|[a-z0-9]+\.doubanio\.com|hanime-cdn\.com|assets-cdn\.jable\.tv|c\d\.jdbstatic\.com)$/;
// JavDB images, like its pages, only answer through the home-broadband proxy.
const PROXIED_HOSTS = /\.jdbstatic\.com$/;
export function extImage(raw: string) {
  let u: URL;
  try {
    u = new URL(raw.replace(/^http:/, "https:"));
  } catch {
    return Promise.resolve(null);
  }
  if (!EXT_HOSTS.test(u.hostname)) {
    if (once(`ext-host:${u.hostname}`) !== null) log.warn({ host: u.hostname }, "image host not allowed");
    return Promise.resolve(null);
  }
  const proxied = PROXIED_HOSTS.test(u.hostname);
  return cached(`ext:${u}`, () => fetchImage(proxied ? "ext-proxied" : "ext", u.toString(), () => proxied
    ? proxiedRaw(u.toString(), { referer: "https://javdb.com/" })
    : fetch(u, {
      headers: { "user-agent": "Mozilla/5.0", ...(u.hostname.endsWith("doubanio.com") ? { referer: "https://movie.douban.com/" } : {}) },
      signal: AbortSignal.timeout(20_000),
    })), 30 * 86400_000);
}

// Any poster URL MP hands out → a backend image path.
export function posterPath(src: string | null | undefined, size = "w342"): string | null {
  if (!src) return null;
  if (src.includes("image.tmdb.org") || src.startsWith("/")) return tmdbPath(src, size);
  return `/v1/img/ext?u=${encodeURIComponent(src)}`;
}
