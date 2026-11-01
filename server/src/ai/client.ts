// How the assistant reaches the model: the Claude Agent SDK (the Claude Code harness, as in OKX Helper), one
// CLI process per turn. Every request goes through AI_PROXY (see settings.ts); there is no direct path, so a
// missing or broken proxy shows up as an error in the chat instead of a silent call from the server's
// datacenter address. The CLI's own state (session transcripts, config) lives in DATA_DIR/ai/claude.
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { McpSdkServerConfigWithInstance, Options } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../config.ts";
import { effective, type Effective } from "./settings.ts";

export class AiNotReady extends Error {
  statusCode = 503;
  code = "ai_not_configured";
}

const home = path.join(config.dataDir, "ai", "claude");
const cwd = path.join(home, "work");

export async function aiConfig(): Promise<Effective> {
  const e = await effective();
  if (!e.apiKey) throw new AiNotReady("还没有配置 AI：设置 → AI 助手里填 API Key");
  if (!e.proxy) throw new AiNotReady("服务端没有配置 AI_PROXY：模型请求必须经代理发出，不会直连");
  if (/^socks/i.test(e.proxy)) throw new AiNotReady("AI_PROXY 要是 http(s):// 代理（Claude 运行时不支持 socks）");
  return e;
}

/** The CLI's environment: replaces process.env entirely, so nothing else (keys, proxies) leaks in. */
function env(e: Effective): Record<string, string> {
  const noProxy = "127.0.0.1,localhost,::1";
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    CLAUDE_CONFIG_DIR: home,
    TZ: process.env.TZ ?? "Asia/Shanghai",
    // OAuth tokens and API keys go in different variables
    ...(/^sk-ant-oat/.test(e.apiKey) ? { CLAUDE_CODE_OAUTH_TOKEN: e.apiKey } : { ANTHROPIC_API_KEY: e.apiKey }),
    ...(e.baseUrl ? { ANTHROPIC_BASE_URL: e.baseUrl } : {}),
    HTTPS_PROXY: e.proxy, HTTP_PROXY: e.proxy, https_proxy: e.proxy, http_proxy: e.proxy, NO_PROXY: noProxy, no_proxy: noProxy,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", // no telemetry / update checks
    DISABLE_AUTOUPDATER: "1",
    ENABLE_TOOL_SEARCH: "false",
    CLAUDE_CODE_MAX_RETRIES: "3",
    MAX_MCP_OUTPUT_TOKENS: "12000",
    CLAUDE_AGENT_SDK_CLIENT_APP: "mediahub",
  };
}

export function agentOptions(o: {
  e: Effective; model: string; system: string; web: boolean; effort: Effective["effort"]; resume?: string;
  abort: AbortController; mcp: McpSdkServerConfigWithInstance;
}): Options {
  mkdirSync(cwd, { recursive: true });
  const web = o.web ? ["WebSearch", "WebFetch"] : [];
  return {
    model: o.model,
    // the stable prompt (changes only with 隐藏内容): rendered every request, not frozen into the session
    systemPrompt: { type: "custom", prompt: o.system, snapshot: false },
    tools: web, // built-in tools: only web search / fetch
    allowedTools: ["mcp__mediahub__*", ...web],
    mcpServers: { mediahub: o.mcp },
    strictMcpConfig: true,
    settingSources: [],
    permissionMode: "dontAsk",
    maxTurns: 30,
    includePartialMessages: true,
    ...(o.effort === "off"
      ? { thinking: { type: "disabled" } }
      : { thinking: { type: "adaptive", display: "summarized" }, effort: o.effort }),
    ...(o.resume ? { resume: o.resume } : {}),
    abortController: o.abort,
    cwd,
    env: env(o.e),
    stderr: () => {},
  };
}
