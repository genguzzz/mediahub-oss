// Image load diagnostics for expo-image: a failed load, or one slower than SLOW_MS, is logged once per
// URL per session (tag "img"), with the backend path (never the token) and the elapsed time. Upload the
// log from Settings → 上传日志; the server's "img res" / "image upstream failed" lines show the other side.
import type { ImageErrorEventData } from "expo-image";
import { logger } from "./log";
import { getSettings } from "./settings";

const log = logger("img");
const SLOW_MS = 5000;
const reported = new Set<string>();

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
  let t0 = 0;
  return {
    onLoadStart: () => { t0 = Date.now(); },
    onLoad: (e: { cacheType?: string }) => {
      const ms = t0 ? Date.now() - t0 : 0;
      if (uri && ms > SLOW_MS && once("slow", uri)) log.info("slow", { where, url: short(uri), ms, cache: e.cacheType });
    },
    onError: (e: ImageErrorEventData) => {
      if (uri && once("err", uri)) log.warn("failed", { where, url: short(uri), ms: t0 ? Date.now() - t0 : null, err: e.error });
    },
  };
}
