// Cache control for the apps. Every /v1 response carries `x-cache-epoch` (a number the server bumps when cached
// data must go, e.g. after bad upstream data was fixed), `x-config-version` (appConfig.ts: the app refetches
// /v1/config when it changes) and, when the config sets cacheMaxAgeSec, `x-cache-max-age`. An app that sees a
// new epoch drops its whole query cache (memory and disk). Bumped from the app's 设置 → 清除缓存
// (POST /v1/cache/clear, which also clears this server's own caches) or from /admin/cache. Stored in
// DATA_DIR/cache-control.json.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { appConfig, configVersion } from "./appConfig.ts";
import { config } from "./config.ts";
import { logger } from "./log.ts";

const log = logger("cache");
const file = path.join(config.dataDir, "cache-control.json");
let state: { epoch: number } = { epoch: 1 };
const clearers: (() => void)[] = [];

export async function loadCacheControl() {
  state = await readFile(file, "utf8").then((t) => ({ epoch: Number((JSON.parse(t) as typeof state).epoch) || 1 })).catch(() => state);
}

async function save() {
  await mkdir(config.dataDir, { recursive: true });
  await writeFile(file, JSON.stringify(state));
}

/** Server-side caches register here so one call empties all of them. */
export function onClearCaches(fn: () => void) {
  clearers.push(fn);
}

export function cacheHeaders(): Record<string, string> {
  const maxAge = appConfig().cacheMaxAgeSec;
  return { "x-cache-epoch": String(state.epoch), "x-config-version": String(configVersion()), ...(maxAge ? { "x-cache-max-age": String(maxAge) } : {}) };
}

export function cacheStatus() {
  return { epoch: state.epoch, maxAge: appConfig().cacheMaxAgeSec };
}

/** Empty this server's caches and tell every app to drop its own (new epoch). */
export async function clearAllCaches(by: string) {
  for (const fn of clearers) fn();
  state.epoch += 1;
  await save();
  log.info({ epoch: state.epoch, by }, "caches cleared");
  return cacheStatus();
}
