// AI settings: API key, endpoint (an Anthropic-compatible base URL), model, thinking effort, web search. Each comes
// from the server environment (AI_API_KEY, AI_BASE_URL, AI_MODEL, AI_EFFORT) or is set from the app / /admin, which wins and is
// stored in DATA_DIR/ai/settings.json (mode 600). Clearing a stored value falls back to the environment.
//
// Model calls always go out through AI_PROXY (an http(s):// or socks5:// proxy, e.g. a residential exit);
// with no proxy configured the assistant refuses to run rather than calling from the server's own address.
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.ts";

export type Effort = "off" | "low" | "medium" | "high";
export interface Stored { apiKey?: string; baseUrl?: string; model?: string; effort?: Effort; webSearch?: boolean }

// How hard the model thinks (adaptive thinking's effort; "off" = no thinking): fewer thinking tokens at lower
// levels. The app's model menu shows these lists as given (chatOptions), so every app has the same choices.
export const DEFAULT_EFFORT: Effort = "medium";
export const EFFORTS = [
  { value: "off", label: "关", hint: "不思考，最快最省，适合简单问答" },
  { value: "low", label: "低", hint: "想得少，省 token" },
  { value: "medium", label: "中", hint: "平衡，大多数找片和推荐" },
  { value: "high", label: "高", hint: "想得最久，复杂的推荐和排查" },
];
export const isEffort = (v: unknown): v is Effort => EFFORTS.some((e) => e.value === v);

export const DEFAULT_MODEL = "claude-sonnet-5";
export const MODELS = [
  { value: "claude-sonnet-5", label: "Sonnet", hint: "快，日常够用" },
  { value: "claude-opus-5-5", label: "Opus", hint: "最强，慢一些、更费 token" },
];

// USD per million tokens (Anthropic's price list, platform.claude.com/docs/en/about-claude/pricing, 2026-11);
// cacheWrite = 5-minute cache writes (the prompt's cache_control). Web search: $10 per 1,000; web fetch free.
const PRICES: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  "claude-sonnet-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  "claude-opus-5-5": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
};
export interface Usage { input: number; output: number; cacheWrite: number; cacheRead: number; searches: number }
/** Cost of a turn's usage in USD; null for a model without a known price (a custom endpoint's own model). */
export function costOf(model: string, u: Usage): number | null {
  const p = PRICES[model];
  if (!p) return null;
  return (u.input * p.input + u.output * p.output + u.cacheWrite * p.cacheWrite + u.cacheRead * p.cacheRead) / 1e6 + u.searches * 0.01;
}

const dir = path.join(config.dataDir, "ai");
const file = path.join(dir, "settings.json");
let stored: Stored = {};
let loaded = false;

async function load(): Promise<Stored> {
  if (loaded) return stored;
  stored = await readFile(file, "utf8").then((t) => JSON.parse(t) as Stored).catch(() => ({}));
  loaded = true;
  return stored;
}

export interface Effective { apiKey: string; baseUrl: string; model: string; effort: Effort; webSearch: boolean; proxy: string }

export async function effective(): Promise<Effective> {
  const s = await load();
  return {
    apiKey: s.apiKey || process.env.AI_API_KEY || "",
    baseUrl: s.baseUrl || process.env.AI_BASE_URL || "",
    model: s.model || process.env.AI_MODEL || DEFAULT_MODEL,
    effort: s.effort ?? (isEffort(process.env.AI_EFFORT) ? process.env.AI_EFFORT : DEFAULT_EFFORT),
    webSearch: s.webSearch ?? process.env.AI_WEB_SEARCH !== "0",
    proxy: process.env.AI_PROXY || "",
  };
}

const mask = (k: string) => (k ? `已设置（${k.length} 位，末尾 ${k.slice(-4)}）` : "");
function proxyLabel(url: string) {
  try {
    const u = new URL(url);
    return `${u.protocol.replace(":", "")} ${u.hostname}:${u.port}`;
  } catch {
    return "代理地址无效";
  }
}

/** What the app / admin see: never the key itself. */
export async function status() {
  const s = await load();
  const e = await effective();
  return {
    configured: !!e.apiKey && !!e.proxy,
    apiKey: mask(e.apiKey),
    apiKeyFrom: s.apiKey ? "app" : process.env.AI_API_KEY ? "server" : null,
    baseUrl: e.baseUrl,
    baseUrlFrom: s.baseUrl ? "app" : process.env.AI_BASE_URL ? "server" : null,
    model: e.model,
    modelFrom: s.model ? "app" : process.env.AI_MODEL ? "server" : null,
    effort: e.effort,
    effortFrom: s.effort ? "app" : isEffort(process.env.AI_EFFORT) ? "server" : null,
    efforts: EFFORTS,
    webSearch: e.webSearch,
    proxy: e.proxy ? proxyLabel(e.proxy) : null,
    models: MODELS,
  };
}

/** Partial update; "" clears a stored value (back to the server environment). */
export async function update(patch: { apiKey?: string; baseUrl?: string; model?: string; effort?: Effort | null; webSearch?: boolean | null }) {
  const s = { ...(await load()) };
  for (const k of ["apiKey", "baseUrl", "model"] as const) {
    const v = patch[k];
    if (v === undefined) continue;
    if (v.trim()) s[k] = v.trim();
    else delete s[k];
  }
  if (patch.effort === null) delete s.effort;
  else if (patch.effort !== undefined) s.effort = patch.effort;
  if (patch.webSearch === null) delete s.webSearch;
  else if (patch.webSearch !== undefined) s.webSearch = patch.webSearch;
  if (s.baseUrl && !/^https?:\/\/[^\s]+$/.test(s.baseUrl)) throw Object.assign(new Error("接口地址要以 http:// 或 https:// 开头"), { statusCode: 400 });
  await mkdir(dir, { recursive: true });
  await writeFile(file, JSON.stringify(s, null, 2), { mode: 0o600 });
  await chmod(file, 0o600);
  stored = s;
  return status();
}

/** The app's model menu: models, thinking levels (the first, 默认 = "", sends nothing), web search default. */
export async function chatOptions() {
  const e = await effective();
  const now = EFFORTS.find((x) => x.value === e.effort)?.label ?? e.effort;
  return {
    models: MODELS,
    efforts: [{ value: "", label: "默认", hint: `不指定，用服务器的设置（现在是${now}）` }, ...EFFORTS],
    webSearch: { default: e.webSearch, hint: "查剧情、新片时搜网页；关掉更省" },
    defaults: { model: e.model, effort: "" },
  };
}
