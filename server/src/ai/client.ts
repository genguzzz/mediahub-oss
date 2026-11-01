// The Anthropic client for the assistant. Every request goes through AI_PROXY (see settings.ts); there is
// no direct path, so a missing or broken proxy shows up as an error in the chat instead of a silent
// call from the server's datacenter address.
import Anthropic from "@anthropic-ai/sdk";
import { fetch as undiciFetch, ProxyAgent, Socks5ProxyAgent, type Dispatcher } from "undici";
import { effective } from "./settings.ts";

export class AiNotReady extends Error {
  statusCode = 503;
  code = "ai_not_configured";
}

const dispatchers = new Map<string, Dispatcher>();
function dispatcher(proxy: string): Dispatcher {
  let d = dispatchers.get(proxy);
  if (!d) {
    d = /^socks5h?:\/\//i.test(proxy) ? new Socks5ProxyAgent(proxy.replace(/^socks5h:/i, "socks5:")) : new ProxyAgent(proxy);
    dispatchers.set(proxy, d);
  }
  return d;
}

let cached: { key: string; client: Anthropic } | null = null;

export async function aiClient(): Promise<{ client: Anthropic; model: string; webSearch: boolean }> {
  const e = await effective();
  if (!e.apiKey) throw new AiNotReady("还没有配置 AI：设置 → AI 助手里填 API Key");
  if (!e.proxy) throw new AiNotReady("服务端没有配置 AI_PROXY：模型请求必须经代理发出，不会直连");
  const key = `${e.apiKey}\n${e.baseUrl}\n${e.proxy}`;
  if (cached?.key !== key) {
    const d = dispatcher(e.proxy);
    const proxied = ((input: Parameters<typeof undiciFetch>[0], init?: Parameters<typeof undiciFetch>[1]) =>
      undiciFetch(input, { ...init, dispatcher: d })) as unknown as typeof globalThis.fetch;
    cached = { key, client: new Anthropic({ apiKey: e.apiKey, ...(e.baseUrl ? { baseURL: e.baseUrl } : {}), maxRetries: 2, timeout: 180_000, fetch: proxied }) };
  }
  return { client: cached.client, model: e.model, webSearch: e.webSearch };
}
