// Cache control for the apps. Every /v1 response carries `x-cache-epoch` (a number the server bumps when cached
// data must go, e.g. after bad upstream data was fixed) and, when set, `x-cache-max-age` (seconds: no list in
// the app is kept fresh longer than that). An app that sees a new epoch drops its whole query cache (memory
// and disk). Bumped from the app's 设置 → 清除缓存 (POST /v1/cache/clear, which also clears this server's own
// caches) or from /admin/cache. Stored in DATA_DIR/cache-control.json.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.ts";
import { logger } from "./log.ts";

const log = logger("cache");
const file = path.join(config.dataDir, "cache-control.json");
let state: { epoch: number; maxAge: number | null } = { epoch: 1, maxAge: null };
const clearers: (() => void)[] = [];

export async function loadCacheControl() {
  state = await readFile(file, "utf8").then((t) => ({ ...state, ...(JSON.parse(t) as typeof state) })).catch(() => state);
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
  return { "x-cache-epoch": String(state.epoch), ...(state.maxAge ? { "x-cache-max-age": String(state.maxAge) } : {}) };
}

export function cacheStatus() {
  return { ...state };
}

/** Empty this server's caches and tell every app to drop its own (new epoch). */
export async function clearAllCaches(by: string) {
  for (const fn of clearers) fn();
  state.epoch += 1;
  await save();
  log.info({ epoch: state.epoch, by }, "caches cleared");
  return cacheStatus();
}

/** Cap how long the apps keep a list fresh (seconds); null removes the cap. */
export async function setMaxAge(seconds: number | null) {
  state.maxAge = seconds && seconds > 0 ? Math.round(seconds) : null;
  await save();
  return cacheStatus();
}
