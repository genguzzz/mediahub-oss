// The assistant chat (server/src/ai). One global conversation state for the AI sheet. A turn streams as Server-Sent Events over a POST (expo/fetch:
// a real streaming body on iOS); the run continues on the server when the stream drops, and
// openChat()/resume() re-attach to a running chat. AppState "active" and the network coming back
// play the role of the web's visibilitychange/online events.
import { useSyncExternalStore } from "react";
import { AppState, Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import { appVersion } from "./api";
import { has, notify } from "./device";
import { getSettings } from "./settings";
import { logger } from "./log";
import { track } from "./track";

const log = logger("ai");

export type ToolPart = { t: "tool"; id: string; name: string; label: string; input: string; ok: boolean | null; sub?: boolean; args?: string; output?: string };
/** The model's (summarized) reasoning; t0 = when it started streaming here, ms = its length once ended. */
export type ThinkPart = { t: "think"; v: string; ms?: number; t0?: number; live?: boolean };
export type Part = { t: "text"; v: string } | ThinkPart | ToolPart;
export interface Msg { id?: number; role: "user" | "assistant"; parts: Part[]; error?: string; costUsd?: number; latencyMs?: number; live?: boolean }
export interface ChatSummary { id: number; title: string; updated: number; costUsd: number; running: boolean }
export interface Note { id: number; ts: number; text: string; by: "ai" | "owner" }

export const AI_MODELS = [
  { value: "claude-sonnet-5", label: "Sonnet", hint: "快，日常够用" },
  { value: "claude-opus-5-5", label: "Opus", hint: "最强，慢一些、更费 token" },
];
export type Effort = "low" | "medium" | "high";
export const AI_EFFORTS: { value: Effort; label: string; hint: string }[] = [
  { value: "low", label: "低", hint: "最省 token、最快，适合简单问答" },
  { value: "medium", label: "中", hint: "平衡，大多数找片和推荐" },
  { value: "high", label: "高", hint: "想得最久，复杂的推荐和排查" },
];

export const ai = {
  /** the AI sheet is on screen */
  open: false,
  chatId: 0,
  title: "",
  msgs: [] as Msg[],
  running: false,
  chats: [] as ChatSummary[],
  error: "",
  /** an answer finished while the sheet was closed (orb dot) */
  unread: false,
  /** when the last text token arrived (thinking indicator) */
  lastDelta: 0,
  /** the stream dropped and we are polling the server back */
  reconnecting: false,
  /** the chat's last question has no answer and nothing runs (server restarted): offer retry */
  interrupted: false,
  /** the screen the chat was opened from ("影视详情：绝命毒师（tv 1396）"), sent as context */
  screen: "",
  /** model for the next turn (remembered on this device) */
  model: "claude-sonnet-5",
  /** thinking effort and web search for the next turns, picked on this device; null = the server's default */
  effort: null as Effort | null,
  webSearch: null as boolean | null,
  notes: [] as Note[],
};

// ---------- store plumbing (useSyncExternalStore over a version counter) ----------

let version = 0;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
function emit() {
  if (soon) {
    clearTimeout(soon);
    soon = null;
  }
  version++;
  listeners.forEach((l) => l());
}
let soon: ReturnType<typeof setTimeout> | null = null;
/** text deltas arrive many times a second: repaint at most every 60 ms */
function emitSoon() {
  if (!soon) soon = setTimeout(emit, 60);
}
export function useAi() {
  useSyncExternalStore(subscribe, () => version);
  return ai;
}
/** One derived value (primitive): re-renders only when it changes, not on every streamed token. */
export const useAiSelect = <T,>(pick: (a: typeof ai) => T): T => useSyncExternalStore(subscribe, () => pick(ai));

// ---------- device storage (web: localStorage, like the web app's keys) ----------

const kv =
  Platform.OS === "web"
    ? { get: async (k: string) => globalThis.localStorage?.getItem(k) ?? null, set: async (k: string, v: string) => (v ? globalThis.localStorage?.setItem(k, v) : globalThis.localStorage?.removeItem(k)) }
    : { get: (k: string) => SecureStore.getItemAsync(k), set: (k: string, v: string) => (v ? SecureStore.setItemAsync(k, v) : SecureStore.deleteItemAsync(k)) };
const CHAT_KEY = "mh.aiChat"; // the chat on screen, reopened after an app restart
const PENDING_KEY = "mh.aiPending"; // a chat whose answer we have not seen finish yet
const MODEL_KEY = "mh.aiModel";
const EFFORT_KEY = "mh.aiEffort";
const WEB_KEY = "mh.aiWebSearch";
const savedVals: Record<string, string> = {};
const saved = (k: string) => Number(savedVals[k] || 0);
function put(k: string, v: string) {
  savedVals[k] = v;
  void Promise.resolve(kv.set(k, v)).catch((e) => log.warn("save failed", { k, err: e }));
}
function setChat(id: number) {
  ai.chatId = id;
  put(CHAT_KEY, id ? String(id) : "");
}
function setPending(id: number) {
  put(PENDING_KEY, id ? String(id) : "");
}
export function setModel(m: string) {
  ai.model = m;
  put(MODEL_KEY, m);
  emit();
}
export function setEffort(e: Effort | null) {
  ai.effort = e;
  put(EFFORT_KEY, e ?? "");
  emit();
}
export function setWebSearch(on: boolean) {
  ai.webSearch = on;
  put(WEB_KEY, on ? "1" : "0");
  emit();
}

// ---------- HTTP ----------

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
const plainFetch: Fetch = (u, i) => fetch(u, i);
let streamFetchP: Promise<Fetch> | null = null;
/** expo/fetch streams the response body natively; the browser's fetch already does (web preview). */
function streamFetch(): Promise<Fetch> {
  if (Platform.OS === "web") return Promise.resolve(plainFetch);
  streamFetchP ??= import("expo/fetch").then((m) => m.fetch as unknown as Fetch);
  return streamFetchP;
}

const ascii = appVersion.replace(/[^\x20-\x7e]/g, "?"); // header values must be ASCII

/** fetch to this app's server with its token (same settings as every other request). */
async function kfetch(path: string, init: RequestInit = {}, f: Fetch = plainFetch): Promise<Response> {
  const { server, token } = getSettings();
  if (!token) throw new Error("还没有设置访问令牌，请在设置里填写");
  return f(server + path, { ...init, headers: { ...((init.headers as Record<string, string>) || {}), "x-app-version": ascii, authorization: `Bearer ${token}` } });
}

async function errorOf(r: Response) {
  const out = (await r.json().catch(() => ({}))) as { error?: string };
  return new Error(out?.error || `HTTP ${r.status}`);
}

// ---------- applying stream events ----------

function last(): Msg {
  let m = ai.msgs[ai.msgs.length - 1];
  if (!m || m.role !== "assistant" || !m.live) {
    m = { role: "assistant", parts: [], live: true };
    ai.msgs.push(m);
  }
  return m;
}

function apply(ev: any) {
  switch (ev.type) {
    case "chat":
      ai.chatId = ev.chatId;
      return emit();
    case "text": {
      ai.lastDelta = Date.now();
      const m = last();
      const p = m.parts[m.parts.length - 1];
      if (p && p.t === "text") p.v += ev.delta;
      else m.parts.push({ t: "text", v: ev.delta });
      return emitSoon();
    }
    case "text_start":
      last().parts.push({ t: "text", v: "" });
      return emit();
    case "think_start":
      last().parts.push({ t: "think", v: "", t0: Date.now(), live: true });
      return emit();
    case "think": {
      ai.lastDelta = Date.now();
      const m = last();
      const p = m.parts[m.parts.length - 1];
      if (p && p.t === "think") p.v += ev.delta;
      else m.parts.push({ t: "think", v: ev.delta, t0: Date.now(), live: true });
      return emitSoon();
    }
    case "think_end": {
      const m = last();
      for (let i = m.parts.length - 1; i >= 0; i--) {
        const p = m.parts[i];
        if (p.t === "think" && p.live) {
          p.live = false;
          p.ms = ev.ms;
          break;
        }
      }
      return emit();
    }
    case "tool": {
      const m = last();
      if (!m.parts.some((p) => p.t === "tool" && p.id === ev.id)) m.parts.push({ t: "tool", id: ev.id, name: ev.name, label: ev.label, input: "", ok: null, sub: ev.sub });
      return emit();
    }
    case "tool_input":
    case "tool_done": {
      const p = last().parts.find((x) => x.t === "tool" && x.id === ev.id) as ToolPart | undefined;
      if (!p) return;
      if (ev.type === "tool_input") {
        p.input = ev.input;
        if (ev.args) p.args = ev.args;
        if (ev.label) p.label = ev.label;
      } else {
        p.ok = ev.ok;
        if (ev.output != null) p.output = ev.output;
      }
      return emit();
    }
    case "cast":
      // cast_to_tv: the phone casts (it shares the TV's network) and reports back
      void import("./assistantCast").then((m) => m.castForAssistant(ev));
      return;
    case "done": {
      const m = last();
      m.live = false;
      m.costUsd = ev.cost;
      m.latencyMs = ev.latencyMs;
      m.parts.forEach((p) => {
        if (p.t === "tool" && p.ok == null) p.ok = true;
        if (p.t === "think") p.live = false;
      });
      return emit();
    }
    case "error": {
      const m = last();
      m.live = false;
      m.error = ev.error;
      m.parts.forEach((p) => {
        if (p.t === "think") p.live = false;
      });
      return emit();
    }
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  if (typeof TextDecoder !== "undefined") return new TextDecoder().decode(bytes);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  try {
    return decodeURIComponent(escape(s));
  } catch {
    return s;
  }
}

/** Read an SSE response body and apply its events until it ends. Bytes are decoded up to the last
 *  newline only, so a multi-byte character split across chunks is never cut. */
async function pump(r: Response, onEvent: (ev: any) => void, onData: () => void) {
  const reader = r.body!.getReader();
  let buf = "";
  let pending = new Uint8Array(0);
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    onData();
    if (!value?.length) continue;
    const all = new Uint8Array(pending.length + value.length);
    all.set(pending);
    all.set(value, pending.length);
    const nl = all.lastIndexOf(10);
    if (nl < 0) {
      pending = all;
      continue;
    }
    buf += decodeUtf8(all.subarray(0, nl + 1));
    pending = all.slice(nl + 1);
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of block.split("\n")) {
        if (!line.startsWith("data: ")) continue; // ": ping" keeps the connection warm
        let ev: any;
        try {
          ev = JSON.parse(line.slice(6));
        } catch {
          continue;
        }
        onEvent(ev);
        apply(ev);
      }
    }
  }
}

// ---------- connection: a turn runs on the server; the app only watches it and can always pick it up again ----------

const STALE_MS = 40_000; // the server pings every 15 s: this much silence means the stream is dead
type End = "ended" | "dropped" | "replaced";
let abort: AbortController | null = null;
let lastData = 0; // last byte from the server (stream liveness)
let syncSeq = 0; // bumps whenever another chat load starts: older loads give way

const inFront = () => AppState.currentState === "active" || AppState.currentState == null;

function finishedAway(ev: any) {
  // the answer finished while the owner was elsewhere: badge on the tab, a notification when in background
  if (!ai.open || !inFront()) ai.unread = true;
  if (!inFront() && has("notifications")) {
    const body = ev.type === "error" ? `出错：${ev.error ?? ""}` : (ai.title || "点开查看").slice(0, 80);
    void notify("AI 回答好了", body, { url: "/ai" }).catch(() => {});
  }
}

/** Stream one response. ended = the turn finished (done/error/idle event); dropped = the connection
 *  broke first; replaced = a newer stream or chat load took over (it owns the state now). */
async function stream(open: (signal: AbortSignal) => Promise<Response>): Promise<End> {
  abort?.abort();
  const ac = new AbortController();
  abort = ac;
  ai.running = true;
  ai.error = "";
  emit();
  lastData = Date.now();
  let ended = false;
  const dog = setInterval(() => {
    if (Date.now() - lastData > STALE_MS) ac.abort();
  }, 5000);
  const onEvent = (ev: any) => {
    if (ev.type === "chat") setChat(ev.chatId);
    if (ev.type === "done" || ev.type === "error" || ev.type === "idle") ended = true;
    if (ev.type === "done" || ev.type === "error") finishedAway(ev);
  };
  try {
    const r = await open(ac.signal);
    if (!r.ok) throw await errorOf(r);
    await pump(r, onEvent, () => {
      lastData = Date.now();
      if (ai.reconnecting) {
        ai.reconnecting = false;
        emit();
      }
    });
  } catch (e) {
    if (abort !== ac) return "replaced";
    if (!ended) ai.error = ac.signal.aborted ? "连接超时" : (e as Error)?.message || String(e);
  } finally {
    clearInterval(dog);
    if (abort === ac) {
      abort = null;
      ai.running = false;
    }
    emit();
  }
  if (abort !== null && abort !== ac) return "replaced";
  return ended ? "ended" : "dropped";
}

function stopStream() {
  abort?.abort();
  abort = null;
  ai.running = false;
}

/** voice: the text came from speech recognition (the server tells the model it may hold homophone errors). */
export async function send(text: string, retrying = false, voice = false) {
  text = text.trim();
  if ((!text && !retrying) || ai.running) return;
  if (retrying) {
    const m = ai.msgs[ai.msgs.length - 1];
    if (m?.role === "assistant") ai.msgs.pop(); // the failed answer is replaced
  } else {
    ai.msgs.push({ role: "user", parts: [{ t: "text", v: text }] });
    if (!ai.chatId) ai.title = text.slice(0, 40);
  }
  ai.interrupted = false;
  ai.reconnecting = false;
  syncSeq++;
  track("ai.send", { model: ai.model, screen: ai.screen ? 1 : undefined, retry: retrying || undefined, len: text.length });
  const body = JSON.stringify({ chatId: ai.chatId || 0, message: text, screen: ai.screen || undefined, model: ai.model, effort: ai.effort ?? undefined, webSearch: ai.webSearch ?? undefined, retry: retrying, voice: voice || undefined, adult: getSettings().showAdult });
  const f = await streamFetch();
  const end = await stream((signal) => kfetch("/v1/ai/chat", { method: "POST", body, headers: { "Content-Type": "application/json", accept: "text/event-stream" }, signal }, f));
  if (end === "replaced") return;
  if (end === "ended") {
    setPending(0);
    return;
  }
  if (ai.chatId) {
    // the server has the question: the answer goes on there, follow it again
    setPending(ai.chatId);
    return reconnect(ai.chatId);
  }
  // never reached the server (no chat id yet): keep the question, offer to send it again
  const m = ai.msgs[ai.msgs.length - 1];
  if (m?.role === "assistant" && m.live) ai.msgs.pop();
  ai.msgs.push({ role: "assistant", parts: [], error: "没发出去：" + (ai.error || "网络错误") });
  emit();
}

/** Ask the last question again: in place on the server, or from scratch when it never got there. */
export async function retry() {
  if (ai.chatId) return send("", true);
  const i = ai.msgs.map((m) => m.role).lastIndexOf("user");
  if (i < 0) return;
  const q = textOf(ai.msgs[i]);
  ai.msgs.splice(i);
  return send(q);
}

export async function stop() {
  if (!ai.chatId) return;
  track("ai.stop");
  await kfetch(`/v1/ai/chats/${ai.chatId}/stop`, { method: "POST" }).catch((e) => log.warn("stop failed", e));
}

interface StoredMsg { id: number; role: "user" | "assistant"; content: string; steps: any[]; costUsd?: number; latencyMs?: number; error?: string }
function fromStored(m: StoredMsg): Msg {
  const parts: Part[] =
    Array.isArray(m.steps) && m.steps.length ? m.steps.map((s: any) => (s.t === "text" ? { t: "text", v: s.v } : s.t === "think" ? { t: "think", v: s.v, ms: s.ms } : { ...s, t: "tool" })) : m.content ? [{ t: "text", v: m.content }] : [];
  return { id: m.id, role: m.role, parts, error: m.error, costUsd: m.costUsd, latencyMs: m.latencyMs };
}

/** Load a chat from the server and, while it is answering, follow it to the end. Throws on HTTP errors. */
async function sync(id: number): Promise<End> {
  const my = ++syncSeq;
  const r = await kfetch(`/v1/ai/chats/${id}`);
  if (my !== syncSeq) return "replaced";
  if (!r.ok) {
    if (r.status === 404 && id === ai.chatId) newChat();
    throw await errorOf(r);
  }
  const c = await r.json();
  if (my !== syncSeq) return "replaced";
  setChat(c.id);
  ai.title = c.title;
  ai.msgs = ((c.messages ?? []) as StoredMsg[]).map(fromStored);
  ai.interrupted = !!c.interrupted;
  ai.error = "";
  if (!c.running) {
    stopStream();
    if (saved(PENDING_KEY) === c.id) {
      setPending(0);
      if (!ai.open) ai.unread = true;
    }
    emit();
    return "ended";
  }
  setPending(c.id);
  ai.msgs.push({ role: "assistant", parts: [], live: true }); // the stream replays this turn from its start
  emit();
  const f = await streamFetch();
  const end = await stream((signal) => kfetch(`/v1/ai/chats/${c.id}/stream`, { signal, headers: { accept: "text/event-stream" } }, f));
  if (end === "ended" && my === syncSeq) return sync(id); // load the stored answer: complete, every step's result
  return end;
}

/** Show a chat (history, app start); a dropped stream turns into reconnecting. */
export async function openChat(id: number) {
  ai.reconnecting = false;
  if ((await sync(id)) === "dropped") await reconnect(id);
}

let loop: Promise<void> | null = null;
let loopId = 0;
/** The stream dropped (background, network, server restart): retry with backoff until the turn is over. */
function reconnect(id: number): Promise<void> {
  if (loop && loopId === id) return loop;
  loopId = id;
  loop = (async () => {
    for (let i = 0; i < 10; i++) {
      ai.reconnecting = true;
      emit();
      await new Promise((r) => setTimeout(r, Math.min(15_000, 1000 * 2 ** i)));
      if (ai.chatId !== id || !inFront()) return; // resume() picks it up on return
      try {
        const end = await sync(id);
        if (end !== "dropped") return;
        i = -1; // was connected again for a while: start the backoff over
      } catch {
        // offline or server restarting: next attempt
      }
    }
  })().finally(() => {
    if (loopId === id) {
      loop = null;
      ai.reconnecting = false;
      emit();
    }
  });
  return loop;
}

/** App back in front / network back / tab shown: catch up with the chat on screen or the one left running. */
export async function resume() {
  const id = ai.chatId || saved(CHAT_KEY);
  if (!id) return;
  if (ai.running && abort && Date.now() - lastData < 20_000) return; // a live stream is still flowing
  if (!ai.chatId && saved(PENDING_KEY) !== id && !ai.open) return; // nothing in flight: load when the tab opens
  await openChat(id).catch((e) => log.warn("resume failed", { id, err: e }));
}

export function newChat() {
  stopStream();
  syncSeq++;
  loopId = 0;
  setChat(0);
  setPending(0);
  ai.title = "";
  ai.msgs = [];
  ai.error = "";
  ai.interrupted = false;
  ai.reconnecting = false;
  emit();
}

/** The AI tab came into view / left it. */
export function setOpen(open: boolean) {
  ai.open = open;
  if (open) ai.unread = false;
  emit();
  if (open) void resume();
}

/** The floating orb opened the chat from a page: that page becomes the context of the next turns. */
export function setContext(screen: string) {
  if (ai.screen === screen) return;
  ai.screen = screen;
  emit();
}
export function clearContext() {
  ai.screen = "";
  emit();
}

let started = false;
/** App start (root layout): restore the device state, pick up a question left running, follow
 *  foreground and network changes. */
export async function initAi() {
  if (started) return;
  started = true;
  try {
    const [c, p, m, e, w] = await Promise.all([kv.get(CHAT_KEY), kv.get(PENDING_KEY), kv.get(MODEL_KEY), kv.get(EFFORT_KEY), kv.get(WEB_KEY)]);
    if (e && AI_EFFORTS.some((x) => x.value === e)) ai.effort = e as Effort;
    if (w === "1" || w === "0") ai.webSearch = w === "1";
    savedVals[CHAT_KEY] = c ?? "";
    savedVals[PENDING_KEY] = p ?? "";
    if (m && AI_MODELS.some((x) => x.value === m)) ai.model = m;
  } catch (e) {
    log.warn("load failed", e);
  }
  emit();
  AppState.addEventListener("change", (s) => {
    if (s !== "active") return;
    if (ai.open && ai.unread) {
      ai.unread = false;
      emit();
    }
    void resume();
  });
  if (has("network")) {
    void import("expo-network").then((N) => {
      let was = true;
      N.addNetworkStateListener((st) => {
        const on = st.isConnected !== false && st.isInternetReachable !== false;
        if (on && !was) void resume();
        was = on;
      });
    });
  } else if (Platform.OS === "web" && typeof window !== "undefined") {
    window.addEventListener("online", () => void resume());
  }
  void resume(); // app start: pick up a question left running
}

// ---------- history, voice, notes ----------

export async function loadChats() {
  const r = await kfetch("/v1/ai/chats");
  if (!r.ok) throw await errorOf(r);
  ai.chats = await r.json();
  emit();
}

export async function deleteChat(id: number) {
  const r = await kfetch(`/v1/ai/chats/${id}`, { method: "DELETE" });
  if (!r.ok) throw await errorOf(r);
  ai.chats = ai.chats.filter((c) => c.id !== id);
  if (ai.chatId === id) newChat();
  emit();
}

/** Plain text of a message (copy button). */
export const textOf = (m: Msg) =>
  m.parts
    .filter((p) => p.t === "text")
    .map((p) => (p as { v: string }).v)
    .join("\n\n");

export async function loadNotes() {
  const r = await kfetch("/v1/ai/notes");
  if (!r.ok) throw await errorOf(r);
  ai.notes = await r.json();
  emit();
}
export async function addNote(text: string) {
  const r = await kfetch("/v1/ai/notes", { method: "POST", body: JSON.stringify({ text }), headers: { "Content-Type": "application/json" } });
  if (!r.ok) throw await errorOf(r);
  await loadNotes();
}
export async function deleteNote(id: number) {
  const r = await kfetch(`/v1/ai/notes/${id}`, { method: "DELETE" });
  if (!r.ok) throw await errorOf(r);
  ai.notes = ai.notes.filter((n) => n.id !== id);
  emit();
}
