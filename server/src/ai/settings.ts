// AI settings: API key, endpoint (an Anthropic-compatible base URL), model, web search. Each comes from the
// server environment (AI_API_KEY, AI_BASE_URL, AI_MODEL) or is set from the app / /admin, which wins and is
// stored in DATA_DIR/ai/settings.json (mode 600). Clearing a stored value falls back to the environment.
//
// Model calls always go out through AI_PROXY (an http(s):// or socks5:// proxy, e.g. a residential exit);
// with no proxy configured the assistant refuses to run rather than calling from the server's own address.
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.ts";

export interface Stored { apiKey?: string; baseUrl?: string; model?: string; webSearch?: boolean }

export const DEFAULT_MODEL = "claude-sonnet-5";
export const MODELS = [
  { value: "claude-sonnet-5", label: "Sonnet" },
  { value: "claude-opus-5-5", label: "Opus" },
];

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

export interface Effective { apiKey: string; baseUrl: string; model: string; webSearch: boolean; proxy: string }

export async function effective(): Promise<Effective> {
  const s = await load();
  return {
    apiKey: s.apiKey || process.env.AI_API_KEY || "",
    baseUrl: s.baseUrl || process.env.AI_BASE_URL || "",
    model: s.model || process.env.AI_MODEL || DEFAULT_MODEL,
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
    webSearch: e.webSearch,
    proxy: e.proxy ? proxyLabel(e.proxy) : null,
    models: MODELS,
  };
}

/** Partial update; "" clears a stored value (back to the server environment). */
export async function update(patch: { apiKey?: string; baseUrl?: string; model?: string; webSearch?: boolean | null }) {
  const s = { ...(await load()) };
  for (const k of ["apiKey", "baseUrl", "model"] as const) {
    const v = patch[k];
    if (v === undefined) continue;
    if (v.trim()) s[k] = v.trim();
    else delete s[k];
  }
  if (patch.webSearch === null) delete s.webSearch;
  else if (patch.webSearch !== undefined) s.webSearch = patch.webSearch;
  if (s.baseUrl && !/^https?:\/\/[^\s]+$/.test(s.baseUrl)) throw Object.assign(new Error("接口地址要以 http:// 或 https:// 开头"), { statusCode: 400 });
  await mkdir(dir, { recursive: true });
  await writeFile(file, JSON.stringify(s, null, 2), { mode: 0o600 });
  await chmod(file, 0o600);
  stored = s;
  return status();
}
