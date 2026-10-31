// Image load diagnostics for expo-image (tag "img"), once per URL per session, never with the token:
// - failed: the load errored (HTTP error, timeout, decode) — error level, so it is on disk at once;
// - slow: it took longer than SLOW_MS;
// - missing: a card had no image URL at all (the source has no poster).
// Most images load straight from their source (TMDb, Bangumi, 豆瓣, JavDB); the URL says which. For images
// through the backend, its "img res" / "image upstream failed" lines show the other side.
// Upload the log from Settings → 上传日志.
import type { ImageErrorEventData } from "expo-image";
import { logger } from "./log";
import { getSettings } from "./settings";

const log = logger("img");
const SLOW_MS = 5000;
const reported = new Set<string>();
const started = new Map<string, number>();   // by URL: the handlers are rebuilt on every render

const short = (uri: string) => {
  const { server } = getSettings();
  const p = server && uri.startsWith(server) ? uri.slice(server.length) : uri;
  try {
    return decodeURIComponent(p).slice(0, 200);
  } catch {
    return p.slice(0, 200);
  }
};

function once(kind: string, uri: string) {
  const k = `${kind}:${uri}`;
  if (reported.has(k)) return false;
  if (reported.size > 500) reported.clear();
  reported.add(k);
  return true;
}

/** Spread onto an expo-image <Image>: `<Image {...imageLog(source?.uri, "poster")} />`. */
export function imageLog(uri: string | undefined, where: string) {
  const elapsed = () => {
    const t0 = uri ? started.get(uri) : undefined;
    if (uri) started.delete(uri);
    return t0 ? Date.now() - t0 : null;
  };
  return {
    onLoadStart: () => {
      if (!uri) return;
      if (started.size > 300) started.clear();
      started.set(uri, Date.now());
    },
    onLoad: (e: { cacheType?: string }) => {
      const ms = elapsed();
      if (uri && ms !== null && ms > SLOW_MS && once("slow", uri)) log.info("slow", { where, url: short(uri), ms, cache: e.cacheType });
    },
    onError: (e: ImageErrorEventData) => {
      const ms = elapsed();
      if (uri && once("err", uri)) log.error("failed", { where, url: short(uri), ms, err: e.error });
    },
  };
}

/** A card that has no image URL at all (shown as the placeholder icon). */
export function logMissing(where: string, label: string | undefined) {
  if (label && once("missing", `${where}:${label}`)) log.info("missing", { where, title: label.slice(0, 80) });
}
