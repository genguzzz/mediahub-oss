// One logger for the whole server: Fastify's (JSON lines to journald, `journalctl -u mediahub -o cat`).
// Modules take a tagged child with `logger("images")`; every line then carries `mod`, so
// `journalctl -u mediahub -o cat | grep '"mod":"images"'` shows one subsystem. Request handlers keep using
// `req.log` (it carries the request id `rid` the app logs too).
//
// Rules: log a failure where it is swallowed (a `.catch(() => null)` must say what failed and why), log
// slow upstream calls, never log tokens or full signed URLs, and keep repeated failures of the same thing
// to one line per window (`once`).
import type { FastifyBaseLogger } from "fastify";

let base: FastifyBaseLogger | null = null;
const pending: [string, "debug" | "info" | "warn" | "error", object, string][] = [];

export function initLog(l: FastifyBaseLogger) {
  base = l;
  for (const [mod, level, o, m] of pending.splice(0)) l.child({ mod })[level](o, m);
}

export type Log = { [K in "debug" | "info" | "warn" | "error"]: (o: object, msg: string) => void };

export function logger(mod: string): Log {
  let child: FastifyBaseLogger | null = null;
  const at = (level: "debug" | "info" | "warn" | "error") => (o: object, msg: string) => {
    if (!base) {
      pending.push([mod, level, o, msg]);
      return;
    }
    child ??= base.child({ mod });
    child[level](o, msg);
  };
  return { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}

/** True the first time `key` is seen in `windowMs`: log a repeating failure once per window, with a count. */
const seen = new Map<string, { at: number; n: number }>();
export function once(key: string, windowMs = 10 * 60_000): number | null {
  const now = Date.now();
  const s = seen.get(key);
  if (s && now - s.at < windowMs) {
    s.n++;
    return null;
  }
  const skipped = s?.n ?? 0;
  seen.set(key, { at: now, n: 0 });
  if (seen.size > 2000) for (const [k, v] of seen) if (now - v.at > windowMs) seen.delete(k);
  return skipped;
}

export const errText = (e: unknown) => (e instanceof Error ? (e.cause instanceof Error ? `${e.message}: ${e.cause.message}` : e.message) : String(e));
