// Remote config for the apps: settings the server can override without an app release. SCHEMA declares every
// key, its type and default; overrides live in DATA_DIR/app-config.json (only the keys that differ) and are
// validated against the schema. The apps read GET /v1/config and refetch when `x-config-version` (sent with
// every /v1 answer) changes. Edit with /admin/config (or ops.sh config).
//
// Adding a key: declare it here with its default, read it in the app through useConfig() (app/src/lib/
// remoteConfig.ts, where the same defaults apply when the server is unreachable), document it in docs/APP.md.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { config } from "./config.ts";
import { logger } from "./log.ts";

const log = logger("app-config");

export const SCHEMA = z.object({
  /** cap (seconds) on how long the app keeps any list fresh; null = each screen's own time */
  cacheMaxAgeSec: z.number().int().min(10).max(30 * 86400).nullable().default(null),
  /** sources 按来源搜索 starts with when the owner hasn't saved their own (ids from /v1/sources) */
  defaultSources: z.array(z.string().max(40)).max(40).default(["nyaa", "animetosho", "mikan", "dmhy", "prowlarr"]),
  /** the assistant's floating orb */
  aiOrb: z.boolean().default(true),
  /** 发现 sections (ids from /v1/discover) not shown, e.g. while an upstream list is broken */
  hiddenDiscoverSections: z.array(z.string().max(40)).max(40).default([]),
});
export type AppConfig = z.infer<typeof SCHEMA>;
type Key = keyof AppConfig;

const file = path.join(config.dataDir, "app-config.json");
let overrides: Partial<AppConfig> = {};
let version = 1;

export async function loadAppConfig() {
  const saved = await readFile(file, "utf8").then((t) => JSON.parse(t) as { version?: number; overrides?: Record<string, unknown> }).catch(() => null);
  if (!saved) return;
  version = saved.version ?? 1;
  // keep only keys that still exist and still validate (a key may have been removed or retyped since)
  const ok: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(saved.overrides ?? {})) {
    const field = SCHEMA.shape[k as Key];
    if (field?.safeParse(v).success) ok[k] = v;
    else log.warn({ key: k }, "stored override dropped (unknown key or invalid value)");
  }
  overrides = ok as Partial<AppConfig>;
}

export function appConfig(): AppConfig {
  return SCHEMA.parse(overrides);
}

export function configVersion() {
  return version;
}

export function configView() {
  return { version, values: appConfig(), overridden: Object.keys(overrides), defaults: SCHEMA.parse({}) };
}

/** Set (validated) and unset keys; bumps the version so the apps refetch. */
export async function updateAppConfig(set: Record<string, unknown>, unset: string[]) {
  const next: Record<string, unknown> = { ...overrides };
  for (const k of unset) delete next[k];
  for (const [k, v] of Object.entries(set)) {
    if (!(k in SCHEMA.shape)) throw Object.assign(new Error(`没有这个配置项：${k}`), { statusCode: 400 });
    next[k] = v;
  }
  const parsed = SCHEMA.partial().safeParse(next);
  if (!parsed.success) throw Object.assign(new Error(`配置不合法：${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`), { statusCode: 400 });
  // an override equal to the default is no override
  const defaults = SCHEMA.parse({});
  overrides = Object.fromEntries(Object.entries(parsed.data).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(defaults[k as Key]))) as Partial<AppConfig>;
  version += 1;
  await mkdir(config.dataDir, { recursive: true });
  await writeFile(file, JSON.stringify({ version, overrides }, null, 1));
  log.info({ version, keys: Object.keys(overrides) }, "app config updated");
  return configView();
}
