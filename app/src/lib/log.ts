// Debug logging designed for remote diagnosis: every line carries a timestamp,
// level, tag and session id; API calls carry the request id the server logs too.
// Lines are kept in memory and appended to a daily file under documents/logs.
// Settings → 上传日志 sends the recent files to the backend.
import { Platform } from "react-native";
import { Directory, File, Paths } from "expo-file-system";

type Level = "debug" | "info" | "warn" | "error";

const MAX_MEMORY = 3000;
const memory: string[] = [];
let pending: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

export const sessionId = Math.random().toString(36).slice(2, 8);
const fsOk = Platform.OS !== "web";

function logDir(): Directory {
  const dir = new Directory(Paths.document, "logs");
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

function dayFile(d = new Date()): File {
  const name = `app-${d.toISOString().slice(0, 10)}.log`;
  return new File(logDir(), name);
}

function stringify(data: unknown): string {
  if (data === undefined) return "";
  if (data instanceof Error) return JSON.stringify({ name: data.name, message: data.message, stack: data.stack?.split("\n").slice(0, 6).join(" | ") });
  try {
    return JSON.stringify(data, (_k, v) => (v instanceof Error ? { name: v.name, message: v.message } : v));
  } catch {
    return String(data);
  }
}

// Lets tracking count errors without log.ts depending on it.
const errorHooks = new Set<(tag: string, msg: string) => void>();
export function onLogError(hook: (tag: string, msg: string) => void) {
  errorHooks.add(hook);
}

function write(level: Level, tag: string, msg: string, data?: unknown) {
  if (level === "error") errorHooks.forEach((h) => h(tag, msg));
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${sessionId}] ${tag}: ${msg}${data === undefined ? "" : " " + stringify(data)}`;
  memory.push(line);
  if (memory.length > MAX_MEMORY) memory.splice(0, memory.length - MAX_MEMORY);
  if (__DEV__) {
    (level === "error" ? origError : console.log)(line);
  }
  if (!fsOk) return;
  pending.push(line);
  if (level === "error") void flush();
  else if (!flushTimer) flushTimer = setTimeout(() => void flush(), 2000);
}

export async function flush(): Promise<void> {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  if (!fsOk || pending.length === 0) return;
  const chunk = pending.join("\n") + "\n";
  pending = [];
  try {
    const f = dayFile();
    if (!f.exists) f.create({ intermediates: true });
    await f.write(chunk, { append: true });
  } catch (e) {
    memory.push(`${new Date().toISOString()} ERROR [${sessionId}] log: flush failed ${stringify(e)}`);
  }
}

export function logger(tag: string) {
  return {
    debug: (msg: string, data?: unknown) => write("debug", tag, msg, data),
    info: (msg: string, data?: unknown) => write("info", tag, msg, data),
    warn: (msg: string, data?: unknown) => write("warn", tag, msg, data),
    error: (msg: string, data?: unknown) => write("error", tag, msg, data),
  };
}

export function recentLines(n = 300): string[] {
  return memory.slice(-n);
}

// Concatenate the last `days` log files (newest last), capped to ~maxBytes from the end.
export async function collectLogs(days = 3, maxBytes = 3_000_000): Promise<string> {
  await flush();
  if (!fsOk) return memory.join("\n");
  const parts: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const f = dayFile(new Date(Date.now() - i * 86_400_000));
    if (f.exists) parts.push(`===== ${f.name} =====\n` + (await f.text()));
  }
  const all = parts.join("\n");
  return all.length > maxBytes ? all.slice(all.length - maxBytes) : all;
}

// Remove log files older than 7 days.
export function pruneLogs() {
  if (!fsOk) return;
  try {
    const cutoff = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
    for (const item of logDir().list()) {
      const m = /^app-(\d{4}-\d{2}-\d{2})\.log$/.exec(item.name);
      if (m && m[1] < cutoff && item instanceof File) item.delete();
    }
  } catch (e) {
    write("warn", "log", "prune failed", e);
  }
}

const origError = console.error.bind(console);
let installed = false;

// Capture JS crashes and console.error/warn into the log.
export function installGlobalHandlers() {
  if (installed) return;
  installed = true;
  const g = globalThis as unknown as {
    ErrorUtils?: { getGlobalHandler(): (e: unknown, fatal?: boolean) => void; setGlobalHandler(h: (e: unknown, fatal?: boolean) => void): void };
  };
  if (g.ErrorUtils) {
    const prev = g.ErrorUtils.getGlobalHandler();
    g.ErrorUtils.setGlobalHandler((e, fatal) => {
      write("error", "crash", fatal ? "fatal JS error" : "JS error", e);
      void flush();
      prev(e, fatal);
    });
  }
  const origWarn = console.warn.bind(console);
  console.error = (...args: unknown[]) => {
    write("error", "console", args.map((a) => (typeof a === "string" ? a : stringify(a))).join(" ").slice(0, 2000));
    origError(...args);
  };
  console.warn = (...args: unknown[]) => {
    write("warn", "console", args.map((a) => (typeof a === "string" ? a : stringify(a))).join(" ").slice(0, 2000));
    origWarn(...args);
  };
}
