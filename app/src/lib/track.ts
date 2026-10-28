// Usage events (埋点): small counters about what was used and how it went (screen, search mode,
// ingest result, playback start/stall/error with codec and route), batched to /v1/events every
// 30 s and on background, so problems show up without asking for a log upload.
import { AppState } from "react-native";
import { api } from "./api";
import { logger, onLogError, sessionId } from "./log";
import { getSettings } from "./settings";

const log = logger("track");

type Props = Record<string, string | number | boolean | null | undefined>;
interface TrackEvent { e: string; t: string; s: string; p?: Record<string, string | number | boolean | null> }

const MAX_QUEUE = 500;
const BATCH = 200;
let queue: TrackEvent[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let sending = false;

export function track(event: string, props?: Props) {
  const p: TrackEvent["p"] = {};
  if (props) for (const [k, v] of Object.entries(props)) if (v !== undefined) p[k] = typeof v === "string" ? v.slice(0, 160) : v;
  queue.push({ e: event, t: new Date().toISOString(), s: sessionId, ...(props ? { p } : {}) });
  if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
  if (!timer) timer = setTimeout(() => void flushEvents(), 30_000);
}

// Times an async operation and records `event` with ok/ms (and the error message on failure).
export async function timed<T>(event: string, fn: () => Promise<T>, props?: Props): Promise<T> {
  const t0 = Date.now();
  try {
    const r = await fn();
    track(event, { ...props, ok: true, ms: Date.now() - t0 });
    return r;
  } catch (e) {
    track(event, { ...props, ok: false, ms: Date.now() - t0, err: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

export async function flushEvents(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = null;
  if (sending || !queue.length || !getSettings().token) return;
  sending = true;
  const batch = queue.slice(0, BATCH);
  try {
    await api("/v1/events", { body: { events: batch }, timeoutMs: 15_000 });
    queue = queue.slice(batch.length);
  } catch (e) {
    log.debug("event upload failed, will retry", { n: batch.length, err: e instanceof Error ? e.message : e });
  } finally {
    sending = false;
    if (queue.length && !timer) timer = setTimeout(() => void flushEvents(), 60_000);
  }
}

let installed = false;

export function installTracking() {
  if (installed) return;
  installed = true;
  onLogError((tag, msg) => track("error", { area: tag, msg }));
  AppState.addEventListener("change", (s) => {
    track("app_state", { state: s });
    if (s === "background") void flushEvents();
  });
}
