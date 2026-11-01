// Where each outside source goes out. Some sites refuse the server's address (country or datacenter
// blocks) and need another exit; which one depends on the deployment, so it is configuration:
//
//   SOURCE_PROXY="javdb=http://127.0.0.1:10809;hanime=socks5://user:pass@host:1080;tmdb=direct"
//
// Values: `direct`, `http(s)://…` (HTTP CONNECT proxy) or `socks5://…`. A source not listed goes direct,
// except `javdb`, which falls back to INDEX_PROXY (the older single setting). Sources: javdb, jable,
// hanime, hanime1 (refuses datacenter addresses: offered only when an exit is set), tmdb, douban,
// bangumi, bilibili, youtube (video search, ugc.ts). Jable pages go through FlareSolverr (FLARESOLVERR_URL), which uses its own network; Emby, MoviePilot and the plugin are reached directly.
import { Agent, type Dispatcher, ProxyAgent, Socks5ProxyAgent } from "undici";
import { logger } from "./log.ts";

export type Source = "javdb" | "jable" | "hanime" | "hanime1" | "tmdb" | "douban" | "bangumi" | "bilibili" | "youtube";

const log = logger("egress");

function parse(): Map<string, string> {
  const m = new Map<string, string>();
  for (const part of (process.env.SOURCE_PROXY ?? "").split(/[;\n]/)) {
    const i = part.indexOf("=");
    if (i > 0) m.set(part.slice(0, i).trim().toLowerCase(), part.slice(i + 1).trim());
  }
  if (!m.has("javdb") && process.env.INDEX_PROXY) m.set("javdb", process.env.INDEX_PROXY);
  return m;
}

const config = parse();
const agents = new Map<string, Dispatcher>();
const directAgent = new Agent();

/** Proxy URL for a source, or "" for direct (credentials are never logged). */
export function proxyOf(source: Source): string {
  const v = config.get(source) ?? "";
  return v === "direct" ? "" : v;
}

export function dispatcherFor(source: Source): Dispatcher {
  const url = proxyOf(source);
  if (!url) return directAgent;
  let a = agents.get(url);
  if (!a) {
    a = /^socks5h?:\/\//i.test(url) ? new Socks5ProxyAgent(url.replace(/^socks5h:/i, "socks5:")) : new ProxyAgent(url);
    agents.set(url, a);
  }
  return a;
}

/** How each source goes out (for logs and /admin): "direct", "http proxy host:port", "socks5 host:port". */
export function egressSummary(): Record<Source, string> {
  const out = {} as Record<Source, string>;
  for (const s of ["javdb", "jable", "hanime", "hanime1", "tmdb", "douban", "bangumi", "bilibili", "youtube"] as Source[]) {
    const url = proxyOf(s);
    if (!url) {
      out[s] = s === "jable" ? "FlareSolverr (its own network) + direct IPv4 with its clearance" : "direct";
      continue;
    }
    try {
      const u = new URL(url);
      out[s] = `${u.protocol.replace(":", "")} proxy ${u.hostname}:${u.port || (u.protocol === "https:" ? 443 : 80)}`;
    } catch {
      out[s] = "invalid proxy URL";
    }
  }
  return out;
}

log.info(egressSummary(), "egress per source");
