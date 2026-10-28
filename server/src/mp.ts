// MoviePilot REST client. MP wraps most answers as {success, message, data}; `mp()` unwraps
// them and turns success=false into an error. Plugin routes answer plain JSON.
import { config } from "./config.ts";

export class UpstreamError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

type Query = Record<string, string | number | boolean | undefined | null>;

function url(path: string, query?: Query): string {
  const u = new URL(config.mpUrl + path);
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
  return u.toString();
}

async function call(method: string, path: string, opts: { query?: Query; body?: unknown; timeoutMs?: number } = {}): Promise<Response> {
  const res = await fetch(url(path, opts.query), {
    method,
    headers: { "X-API-KEY": config.mpKey, ...(opts.body !== undefined ? { "content-type": "application/json" } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
  }).catch((e: unknown) => {
    const name = (e as { name?: string }).name;
    throw new UpstreamError(name === "TimeoutError" ? `MoviePilot 超时：${path}` : `MoviePilot 无法连接：${String(e)}`, 504);
  });
  if (!res.ok) throw new UpstreamError(`MoviePilot ${res.status}：${path} ${(await res.text()).slice(0, 200)}`, res.status === 404 ? 404 : 502);
  return res;
}

export async function mp<T = unknown>(method: string, path: string, opts: { query?: Query; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
  const data = (await (await call(method, path, opts)).json()) as unknown;
  if (data && typeof data === "object" && "success" in data && "data" in data) {
    const d = data as { success: boolean; message?: string; data: unknown };
    if (!d.success && d.message) throw new UpstreamError(d.message, 400);
    return d.data as T;
  }
  return data as T;
}

// Raw answer from MP (success/message kept), for writes whose message the app shows.
export async function mpRaw<T = unknown>(method: string, path: string, opts: { query?: Query; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
  return (await (await call(method, path, opts)).json()) as T;
}

export function plug<T = unknown>(method: string, path: string, opts: { query?: Query; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
  return mp<T>(method, `/plugin/${config.plugin}${path}`, opts);
}

export async function plugBytes(path: string, query: Query): Promise<{ body: Buffer; type: string } | null> {
  try {
    const res = await call("GET", `/plugin/${config.plugin}${path}`, { query, timeoutMs: 30_000 });
    return { body: Buffer.from(await res.arrayBuffer()), type: res.headers.get("content-type") ?? "image/jpeg" };
  } catch {
    return null;
  }
}
