// Chats with the assistant (same protocol as the app's other AI clients): a turn runs detached from the
// HTTP request, its events are buffered and fanned out over Server-Sent Events, and the app can re-attach
// (/stream replays the turn from its start), stop it, or retry a question left unanswered by a restart.
// Storage: DATA_DIR/ai/chats/<id>.json (messages for the app + the model's own history, trimmed) and
// memory.ts (profile always in the prompt, archival memories recalled per question).
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.ts";
import { logger } from "../log.ts";
import { aiClient } from "./client.ts";
import { systemPrompt } from "./prompt.ts";
import { labelOf, runTool, toolList, type Resource, type ToolCtx } from "./tools.ts";
import { profile, recall } from "./memory.ts";

const log = logger("ai");
type Msg = Anthropic.Beta.BetaMessageParam;

export type Step =
  | { t: "text"; v: string }
  | { t: "think"; v: string; ms?: number }
  | { t: "tool"; id: string; name: string; label: string; input: string; ok: boolean | null; output?: string };

interface StoredMsg { id: number; ts: number; role: "user" | "assistant"; content: string; steps: Step[]; latencyMs?: number; error?: string }
interface Chat { id: number; created: number; updated: number; title: string; msgs: StoredMsg[]; history: Msg[]; refs: Record<string, Resource> }
export interface Context {
  adult: boolean; screen?: string;
  /** this turn's thinking effort and web search, picked in the app; unset = the server's settings */
  effort?: "off" | "low" | "medium" | "high"; webSearch?: boolean;
}

const dir = path.join(config.dataDir, "ai");
const chatDir = path.join(dir, "chats");
const chats = new Map<number, Chat>();
let loaded: Promise<void> | null = null;

function load() {
  loaded ??= (async () => {
    await mkdir(chatDir, { recursive: true });
    for (const f of await readdir(chatDir)) {
      if (!/^\d+\.json$/.test(f)) continue;
      try {
        const c = JSON.parse(await readFile(path.join(chatDir, f), "utf8")) as Chat;
        chats.set(c.id, c);
      } catch (e) {
        log.warn({ file: f, err: e instanceof Error ? e.message : String(e) }, "chat file unreadable");
      }
    }
  })();
  return loaded;
}

const save = (c: Chat) => writeFile(path.join(chatDir, `${c.id}.json`), JSON.stringify(c)).catch((e) => log.error({ id: c.id, err: String(e) }, "chat save failed"));

// ---------- runs ----------

interface Run { events: unknown[]; subs: Set<(ev: unknown) => void>; abort: AbortController }

// Casting runs on the phone (it shares the TV's network; the server can't reach the TV): cast_to_tv sends a
// `cast` event, the app casts by DLNA and posts the outcome to /v1/ai/cast/:rid, and the tool waits for it.
// The event carries `expires`, so a replay of the turn (re-attach) doesn't cast again.
export interface CastOutcome { ok: boolean; tv?: string; error?: string; devices?: string[] }
const castWaits = new Map<string, (r: CastOutcome) => void>();
const CAST_WAIT_MS = 45_000;
export function castResult(rid: string, r: CastOutcome) {
  const done = castWaits.get(rid);
  castWaits.delete(rid);
  done?.(r);
  return !!done;
}
const runs = new Map<number, Run>();
const MAX_RUNS = 2;
const TURN_TIMEOUT_MS = 10 * 60_000;

function emit(id: number, ev: unknown) {
  const r = runs.get(id);
  if (!r) return;
  r.events.push(ev);
  for (const s of r.subs) s(ev);
}

export async function listChats() {
  await load();
  return [...chats.values()].sort((a, b) => b.updated - a.updated).slice(0, 200)
    .map((c) => ({ id: c.id, title: c.title, updated: c.updated, costUsd: 0, running: runs.has(c.id) }));
}

export async function getChat(id: number) {
  await load();
  const c = chats.get(id);
  if (!c) return null;
  const running = runs.has(id);
  const lastMsg = c.msgs[c.msgs.length - 1];
  return { id: c.id, title: c.title, running, interrupted: !running && lastMsg?.role === "user", messages: c.msgs };
}

// ---------- past conversations, for the assistant's list_chats / read_chat ----------

// Poster-card blocks become their works in order ("[卡片：1.《无双》(movie 531384) 2.…]"), so "上次推荐的第一部" resolves.
function cardsText(json: string) {
  try {
    const list = JSON.parse(json) as { type?: string; tmdbid?: number; title?: string; year?: string }[];
    return `[卡片：${list.map((w, i) => `${i + 1}.《${w.title}》(${w.year ?? ""} ${w.type} ${w.tmdbid})`).join(" ")}]`;
  } catch {
    return "[卡片]";
  }
}
const plain = (m: StoredMsg) => (m.content || m.steps.filter((s) => s.t === "text").map((s) => (s as { v: string }).v).join("\n")).replace(/```media\s*([\s\S]*?)```/g, (_, j: string) => cardsText(j));

async function searchChats(query: string, limit: number, except: number) {
  await load();
  const q = query.trim().toLowerCase();
  const out: { id: number; title: string; updated: string; questions: number; hit?: string }[] = [];
  for (const c of [...chats.values()].sort((a, b) => b.updated - a.updated)) {
    if (c.id === except) continue;
    let hit: string | undefined;
    if (q) {
      const m = c.msgs.find((x) => plain(x).toLowerCase().includes(q));
      if (!m && !c.title.toLowerCase().includes(q)) continue;
      if (m) {
        const t = plain(m);
        const i = t.toLowerCase().indexOf(q);
        hit = `${m.role === "user" ? "问" : "答"}：…${t.slice(Math.max(0, i - 40), i + 80).replace(/\s+/g, " ")}…`;
      }
    }
    out.push({ id: c.id, title: c.title, updated: new Date(c.updated).toISOString().slice(0, 16), questions: c.msgs.filter((x) => x.role === "user").length, ...(hit ? { hit } : {}) });
    if (out.length >= limit) break;
  }
  return out;
}

async function readChat(id: number, maxChars: number) {
  await load();
  const c = chats.get(id);
  if (!c) throw new Error(`没有对话 ${id}`);
  let text = c.msgs.map((m) => `${m.role === "user" ? "主人" : "助手"}：${plain(m)}`).join("\n\n");
  if (text.length > maxChars) text = `…（前面略）\n${text.slice(-maxChars)}`;
  return { id: c.id, title: c.title, updated: new Date(c.updated).toISOString().slice(0, 16), text };
}

/** The last few conversations (titles only), so the assistant knows what was talked about lately. */
export async function recentTitles(except: number, n = 6) {
  await load();
  return [...chats.values()].filter((c) => c.id !== except).sort((a, b) => b.updated - a.updated).slice(0, n)
    .map((c) => ({ id: c.id, title: c.title, updated: new Date(c.updated).toISOString().slice(0, 10) }));
}

export async function removeChat(id: number) {
  await load();
  runs.get(id)?.abort.abort();
  chats.delete(id);
  await rm(path.join(chatDir, `${id}.json`), { force: true });
}

export function stopChat(id: number) {
  const r = runs.get(id);
  if (!r) return false;
  r.abort.abort();
  return true;
}

/** Subscribe to a running chat: past events first, then live ones. Returns null when nothing runs. */
export function attach(id: number, onEvent: (ev: unknown) => void): (() => void) | null {
  const r = runs.get(id);
  if (!r) return null;
  for (const ev of r.events) onEvent(ev);
  r.subs.add(onEvent);
  return () => r.subs.delete(onEvent);
}

export class Busy extends Error {
  statusCode = 409;
}

/** Start a turn; returns the chat id at once, the answer streams to attach()ed listeners. */
export async function startChat(app: FastifyInstance, req: { chatId?: number; message: string; retry?: boolean; voice?: boolean; model?: string; context: Context }): Promise<number> {
  await load();
  if (runs.size >= MAX_RUNS) throw new Busy("已经有两个问题在回答，稍等");
  let c = req.chatId ? chats.get(req.chatId) : undefined;
  if (req.chatId && !c) throw Object.assign(new Error("没有这个对话"), { statusCode: 404 });
  if (c && runs.has(c.id)) throw new Busy("这个对话还在回答");
  const now = Date.now();
  if (!c) {
    const id = Math.max(0, ...chats.keys()) + 1;
    c = { id, created: now, updated: now, title: req.message.slice(0, 40), msgs: [], history: [], refs: {} };
    chats.set(id, c);
  }
  let question = req.message.trim();
  if (req.retry) {
    while (c.msgs.length && c.msgs[c.msgs.length - 1].role === "assistant") c.msgs.pop();
    const lastQ = c.msgs[c.msgs.length - 1];
    if (!lastQ) throw Object.assign(new Error("没有可以重试的问题"), { statusCode: 400 });
    question = lastQ.content;
  } else {
    if (!question) throw Object.assign(new Error("问题是空的"), { statusCode: 400 });
    c.msgs.push({ id: c.msgs.length + 1, ts: now, role: "user", content: question, steps: [] });
  }
  c.updated = now;
  await save(c);
  const run: Run = { events: [], subs: new Set(), abort: new AbortController() };
  runs.set(c.id, run);
  emit(c.id, { type: "chat", chatId: c.id });
  const chat = c;
  const timer = setTimeout(() => run.abort.abort(), TURN_TIMEOUT_MS);
  // speech-recognised questions are marked for the model only (the chat shows what was said)
  const forModel = req.voice ? `[语音输入，可能有同音/近音错字] ${question}` : question;
  void turn(app, chat, forModel, req.model, req.context, run).finally(() => {
    clearTimeout(timer);
    runs.delete(chat.id);
  });
  return c.id;
}

/** Keep the model's history bounded: the last ~40 messages, starting at a plain user question. */
function trim(h: Msg[]): Msg[] {
  let start = Math.max(0, h.length - 40);
  while (start < h.length && !(h[start].role === "user" && typeof h[start].content === "string")) start++;
  return h.slice(start);
}

async function turn(app: FastifyInstance, c: Chat, question: string, model: string | undefined, context: Context, run: Run) {
  const t0 = Date.now();
  const steps: Step[] = [];
  const id = c.id;
  const ev = (e: Record<string, unknown>) => emit(id, e);
  let text = "";
  try {
    const { client, model: defModel, effort, webSearch } = await aiClient();
    const ctx: ToolCtx = {
      app, adult: context.adult, refs: c.refs,
      saved: (text, replaces) => ev({ type: "memory", text, replaces }),
      cast: (req) => new Promise<CastOutcome>((resolve) => {
        const rid = Math.random().toString(36).slice(2, 12);
        const timer = setTimeout(() => {
          castWaits.delete(rid);
          resolve({ ok: false, error: "App 没有回应：投屏要 App 开着（在前台），手机和电视在同一个 Wi-Fi" });
        }, CAST_WAIT_MS);
        castWaits.set(rid, (r) => {
          clearTimeout(timer);
          resolve(r);
        });
        ev({ type: "cast", rid, expires: Date.now() + CAST_WAIT_MS, ...req });
      }),
      chats: { list: (q, n) => searchChats(q, n, id), read: (cid, n) => readChat(cid, n) },
    };
    // memory: the core profile always; archival memories relevant to this question (and the chat's title)
    const [core, recalled] = await Promise.all([profile(), recall(`${c.title} ${question}`)]);
    const system = systemPrompt({ profile: core, recalled, recent: await recentTitles(id), context, now: new Date() });
    const tools = toolList(context.adult, context.webSearch ?? webSearch);
    const messages: Msg[] = [...trim(c.history), { role: "user", content: question }];
    for (let round = 0; round < 30; round++) {
      if (run.abort.signal.aborted) throw new Error("已停止");
      const stream = client.beta.messages.stream({
        model: model || defModel,
        max_tokens: 16_000,
        system: [{ type: "text", text: system.stable, cache_control: { type: "ephemeral" } }, { type: "text", text: system.turn }],
        messages,
        tools,
        // "off": no thinking at all; otherwise adaptive thinking at this effort
        ...((context.effort ?? effort) === "off"
          ? { thinking: { type: "disabled" } as never }
          : { thinking: { type: "adaptive", display: "summarized" } as never, output_config: { effort: context.effort ?? effort } as never }),
      }, { signal: run.abort.signal });
      // Map the stream to the app's events; each content block becomes one step.
      const blockStep = new Map<number, Step>();
      const thinkStart = new Map<number, number>();
      stream.on("streamEvent", (e) => {
        if (e.type === "content_block_start") {
          const b = e.content_block;
          if (b.type === "thinking") {
            const s: Step = { t: "think", v: "" };
            steps.push(s);
            blockStep.set(e.index, s);
            thinkStart.set(e.index, Date.now());
            ev({ type: "think_start" });
          } else if (b.type === "text") {
            const s: Step = { t: "text", v: "" };
            steps.push(s);
            blockStep.set(e.index, s);
            ev({ type: "text_start" });
          } else if (b.type === "tool_use" || b.type === "server_tool_use") {
            const name = b.name;
            const s: Step = { t: "tool", id: b.id, name, label: name === "web_search" ? "联网搜索" : name === "web_fetch" ? "读取网页" : labelOf(name, {}), input: "", ok: null };
            steps.push(s);
            blockStep.set(e.index, s);
            ev({ type: "tool", id: b.id, name, label: s.label });
          }
        } else if (e.type === "content_block_delta") {
          const s = blockStep.get(e.index);
          if (e.delta.type === "thinking_delta" && s?.t === "think") {
            s.v += e.delta.thinking;
            ev({ type: "think", delta: e.delta.thinking });
          } else if (e.delta.type === "text_delta" && s?.t === "text") {
            s.v += e.delta.text;
            text += e.delta.text;
            ev({ type: "text", delta: e.delta.text });
          }
        } else if (e.type === "content_block_stop") {
          const s = blockStep.get(e.index);
          if (s?.t === "think") {
            s.ms = Date.now() - (thinkStart.get(e.index) ?? Date.now());
            ev({ type: "think_end", ms: s.ms });
          }
        }
      });
      const msg = await stream.finalMessage();
      if (msg.stop_reason === "refusal") throw new Error("模型拒绝回答这个问题");
      // Tool inputs are complete only now: label them, run ours, mark web searches done.
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      const uses: Anthropic.Beta.BetaToolUseBlock[] = [];
      for (const b of msg.content) {
        if (b.type === "server_tool_use") {
          const s = steps.find((x): x is Extract<Step, { t: "tool" }> => x.t === "tool" && x.id === b.id);
          const inp = (b.input ?? {}) as { query?: string; url?: string };
          if (s) {
            s.input = JSON.stringify(b.input);
            if (b.name === "web_fetch") {
              let host = inp.url ?? "";
              try { host = new URL(host).hostname.replace(/^www\./, ""); } catch { /* keep as given */ }
              s.label = host ? `读取网页 ${host}` : "读取网页";
            } else s.label = inp.query ? `联网搜索「${inp.query.slice(0, 24)}」` : "联网搜索";
          }
          ev({ type: "tool_input", id: b.id, input: JSON.stringify(b.input), label: s?.label });
        } else if (b.type === "web_search_tool_result") {
          const s = steps.find((x): x is Extract<Step, { t: "tool" }> => x.t === "tool" && x.id === b.tool_use_id);
          const ok = Array.isArray(b.content);
          const output = ok ? (b.content as { title?: string; url?: string }[]).slice(0, 8).map((r) => `${r.title ?? ""} ${r.url ?? ""}`).join("\n") : "搜索失败";
          if (s) Object.assign(s, { ok, output });
          ev({ type: "tool_done", id: b.tool_use_id, ok, output });
        } else if (b.type === "web_fetch_tool_result") {
          const s = steps.find((x): x is Extract<Step, { t: "tool" }> => x.t === "tool" && x.id === b.tool_use_id);
          const c = b.content as { type?: string; url?: string; error_code?: string; content?: { title?: string } };
          const ok = c?.type === "web_fetch_result";
          const output = ok ? `${c.content?.title ?? ""} ${c.url ?? ""}`.trim() : `读取失败${c?.error_code ? `：${c.error_code}` : ""}`;
          if (s) Object.assign(s, { ok, output });
          ev({ type: "tool_done", id: b.tool_use_id, ok, output });
        } else if (b.type === "tool_use") uses.push(b);
      }
      if (msg.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: msg.content });
        continue;
      }
      if (!uses.length) {
        messages.push({ role: "assistant", content: msg.content });
        break;
      }
      if (msg.stop_reason === "max_tokens") throw new Error("回答太长被截断了");
      await Promise.all(uses.map(async (u) => {
        const s = steps.find((x): x is Extract<Step, { t: "tool" }> => x.t === "tool" && x.id === u.id);
        const label = labelOf(u.name, u.input);
        const input = JSON.stringify(u.input);
        if (s) Object.assign(s, { label, input });
        ev({ type: "tool_input", id: u.id, input, label });
        const r = await runTool(ctx, u.name, u.input);
        const output = r.content.length > 3000 ? `${r.content.slice(0, 3000)}…` : r.content;
        if (s) Object.assign(s, { ok: r.ok, output });
        ev({ type: "tool_done", id: u.id, ok: r.ok, output });
        log.info({ chat: id, tool: u.name, ok: r.ok, len: r.content.length }, "ai tool");
        results.push({ type: "tool_result", tool_use_id: u.id, content: r.content, ...(r.ok ? {} : { is_error: true }) });
      }));
      messages.push({ role: "assistant", content: msg.content }, { role: "user", content: uses.map((u) => results.find((r) => r.tool_use_id === u.id)!) });
    }
    const latencyMs = Date.now() - t0;
    c.history = messages;
    c.msgs.push({ id: c.msgs.length + 1, ts: Date.now(), role: "assistant", content: text, steps: steps.filter((s) => s.t !== "text" || s.v), latencyMs });
    c.updated = Date.now();
    await save(c);
    ev({ type: "done", text, cost: 0, latencyMs });
    log.info({ chat: id, ms: latencyMs, steps: steps.length }, "ai turn done");
  } catch (e) {
    const err = run.abort.signal.aborted ? "已停止" : e instanceof Error ? e.message : String(e);
    if (!run.abort.signal.aborted) log.warn({ chat: id, err }, "ai turn failed");
    c.msgs.push({ id: c.msgs.length + 1, ts: Date.now(), role: "assistant", content: text, steps: steps.filter((s) => s.t !== "text" || s.v), error: err, latencyMs: Date.now() - t0 });
    c.updated = Date.now();
    await save(c);
    ev({ type: "error", error: err });
  }
}
