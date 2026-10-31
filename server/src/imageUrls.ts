// Where the app loads each image from. Sources the phone can reach are handed out as their own https URL
// (the phone fetches and caches them itself, one hop); the app adds the Referer Douban / JavDB require
// (app/src/lib/api.ts img()). The rest go through the backend (/v1/img/ext): Jable's CDN sits behind
// Cloudflare; hanime-cdn takes 1-2 s per image, so the backend pre-fills its cache (catalog/hanime.ts).
// Emby images keep their own route (the plugin holds the Emby key).
const DIRECT = /^(image\.tmdb\.org|lain\.bgm\.tv|[a-z0-9]+\.doubanio\.com|c\d\.jdbstatic\.com)$/;
const PROXIED = /^(assets-cdn\.jable\.tv|hanime-cdn\.com)$/;

// Bangumi's "l" cover is the original scan (up to ~6000×8000, several MB); its resizer serves 400 px wide.
const BGM_COVER = /^https:\/\/lain\.bgm\.tv\/pic\/cover\/[lcm]\//;

export function extUrl(src: string | null | undefined): string | null {
  if (!src) return null;
  let u: URL;
  try {
    u = new URL(src.replace(/^http:/, "https:"));
  } catch {
    return null;
  }
  const s = u.toString();
  if (DIRECT.test(u.hostname)) return BGM_COVER.test(s) ? s.replace(BGM_COVER, "https://lain.bgm.tv/r/400/pic/cover/l/") : s;
  if (PROXIED.test(u.hostname)) return `/v1/img/ext?u=${encodeURIComponent(s)}`;
  return null;
}

/** Hosts /v1/img/ext still serves (kept for direct hosts too, so older app builds keep working). */
export const EXT_HOSTS = new RegExp(`${DIRECT.source}|${PROXIED.source}`);

// "https://image.tmdb.org/t/p/original/abc.jpg" or "/abc.jpg" → "https://image.tmdb.org/t/p/w342/abc.jpg"
export function tmdbPath(src: string | null | undefined, size = "w342"): string | null {
  if (!src) return null;
  const m = /([A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp))$/.exec(src);
  return m ? `https://image.tmdb.org/t/p/${size}/${m[1]}` : null;
}

// Any poster URL MP hands out → where the app loads it.
export function posterPath(src: string | null | undefined, size = "w342"): string | null {
  if (!src) return null;
  if (src.includes("image.tmdb.org") || src.startsWith("/")) return tmdbPath(src, size);
  return extUrl(src);
}
