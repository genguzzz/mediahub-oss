// Poster/backdrop cache on disk. Emby images come through the plugin (the Emby key stays in
// MP); TMDb images are fetched here so the phone never needs to reach image.tmdb.org.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.ts";
import { plugBytes } from "./mp.ts";
import { proxiedRaw } from "./catalog/http.ts";

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
  return cached(`emby:${id}:${type}:${w}:${tag}`, () => plugBytes("/hub/emby/image", { id, type, w, tag }), tag ? 30 * 86400_000 : 86400_000);
}

export function tmdbImage(size: string, file: string) {
  return cached(`tmdb:${size}:${file}`, async () => {
    const res = await fetch(`https://image.tmdb.org/t/p/${size}/${file}`, { signal: AbortSignal.timeout(20_000) }).catch(() => null);
    if (!res?.ok) return null;
    return { body: Buffer.from(await res.arrayBuffer()), type: res.headers.get("content-type") ?? "image/jpeg" };
  }, 90 * 86400_000);
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
  if (!EXT_HOSTS.test(u.hostname)) return Promise.resolve(null);
  return cached(`ext:${u}`, async () => {
    const res = PROXIED_HOSTS.test(u.hostname)
      ? await proxiedRaw(u.toString(), { referer: "https://javdb.com/" }).catch(() => null)
      : await fetch(u, {
        headers: { "user-agent": "Mozilla/5.0", ...(u.hostname.endsWith("doubanio.com") ? { referer: "https://movie.douban.com/" } : {}) },
        signal: AbortSignal.timeout(20_000),
      }).catch(() => null);
    if (!res?.ok) return null;
    return { body: Buffer.from(await res.arrayBuffer()), type: res.headers.get("content-type") ?? "image/jpeg" };
  }, 30 * 86400_000);
}

// Any poster URL MP hands out → a backend image path.
export function posterPath(src: string | null | undefined, size = "w342"): string | null {
  if (!src) return null;
  if (src.includes("image.tmdb.org") || src.startsWith("/")) return tmdbPath(src, size);
  return `/v1/img/ext?u=${encodeURIComponent(src)}`;
}
