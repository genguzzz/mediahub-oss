// Chats with the assistant (same protocol as the app's other AI clients): a turn runs detached from the
// HTTP request, its events are buffered and fanned out over Server-Sent Events, and the app can re-attach
// (/stream replays the turn from its start), stop it, or retry a question left unanswered by a restart.
// Storage: DATA_DIR/ai/chats/<id>.json (messages for the app + the Agent SDK session id; the session itself is
// the SDK's transcript under DATA_DIR/ai/claude) and
// memory.ts (profile always in the prompt, archival memories recalled per question).
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../config.ts";
import { logger } from "../log.ts";
import { agentOptions, aiConfig } from "./client.ts";
import { costOf, type Usage } from "./settings.ts";
import { systemPrompt } from "./prompt.ts";
import { lookup as lookupCard, refsIn, type Card, type CardStore } from "./cards.ts";
import { labelOf, mcpServer, type Resource, type ToolCtx } from "./tools.ts";
import { profile, recall } from "./memory.ts";

const log = logger("ai");

export type Step =
  | { t: "text"; v: string }
  | { t: "think"; v: string; ms?: number }
  | { t: "tool"; id: string; name: string; label: string; input: string; ok: boolean | null; output?: string };

interface StoredMsg { id: number; ts: number; role: "user" | "assistant"; content: string; steps: Step[]; latencyMs?: number; error?: string; costUsd?: number; usage?: Usage; cards?: Record<string, Card | null> }
interface Chat { id: number; created: number; updated: number; title: string; msgs: StoredMsg[]; /** the Agent SDK session (resumed each turn) */ sessionId?: string; /** pre-SDK model history, unused now */ history?: unknown[]; refs: Record<string, Resource>; cards?: CardStore }
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

// Some tools act on the phone's surroundings (casting, the TV on its network — the server can't reach them):
// the tool sends an event (`cast`, `tv`), the app does it and posts the outcome to /v1/ai/phone/:rid, and the
// tool waits for it. The event carries `expires`, so a replay of the turn (re-attach) doesn't act again.
export interface PhoneOutcome { ok: boolean; error?: string; [k: string]: unknown }
const phoneWaits = new Map<string, (r: PhoneOutcome) => void>();
const PHONE_WAIT_MS = 45_000;
export function phoneResult(rid: string, r: PhoneOutcome) {
  const done = phoneWaits.get(rid);
  phoneWaits.delete(rid);
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
    .map((c) => ({ id: c.id, title: c.title, updated: c.updated, costUsd: Math.round(c.msgs.reduce((sum, m) => sum + (m.costUsd ?? 0), 0) * 10000) / 10000, running: runs.has(c.id) }));
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
const plain = (m: StoredMsg) => (m.content || m.steps.filter((s) => s.t === "text").map((s) => (s as { v: string }).v).join("\n"))
  .replace(/```media\s*([\s\S]*?)```/g, (_, j: string) => cardsText(j))
  .replace(/```cards\s*([\s\S]*?)```/g, (b: string) => `[卡片：${refsIn(b).map((r, i) => `${i + 1}.${m.cards?.[r]?.title ? `《${m.cards[r]!.title}》` : ""}(${r})`).join(" ")}]`);

// Any of the query's words (space-separated) matches; no hit → the recent chats, marked, so the model has
// something to go on instead of an empty list. The current chat is skipped: it is already in the context.
async function searchChats(query: string, limit: number, except: number) {
  await load();
  const words = query.toLowerCase().split(/[\s,，、]+/).filter(Boolean);
  const row = (c: Chat, hit?: string) => ({ id: c.id, title: c.title, updated: new Date(c.updated).toISOString().slice(0, 16), questions: c.msgs.filter((x) => x.role === "user").length, ...(hit ? { hit } : {}) });
  const list = [...chats.values()].filter((c) => c.id !== except).sort((a, b) => b.updated - a.updated);
  if (!words.length) return list.slice(0, limit).map((c) => row(c));
  const out: ReturnType<typeof row>[] = [];
  for (const c of list) {
    let hit: string | undefined;
    let found = words.some((w) => c.title.toLowerCase().includes(w));
    for (const m of c.msgs) {
      const t = plain(m);
      const low = t.toLowerCase();
      const w = words.find((x) => low.includes(x));
      if (!w) continue;
      const i = low.indexOf(w);
      hit = `${m.role === "user" ? "问" : "答"}：…${t.slice(Math.max(0, i - 40), i + 80).replace(/\s+/g, " ")}…`;
      found = true;
      break;
    }
    if (found) out.push(row(c, hit));
    if (out.length >= limit) break;
  }
  if (out.length) return out;
  return { noMatch: `以前的对话里没有「${query}」（当前这次对话不在搜索范围内，它已在上下文里）。最近的对话：`, recent: list.slice(0, Math.min(limit, 8)).map((c) => row(c)) };
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
    c = { id, created: now, updated: now, title: req.message.slice(0, 40), msgs: [], refs: {} };
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

// Chats made before the Agent SDK have no session: their last exchanges go into the first question once.
function earlier(c: Chat): string {
  const past = c.msgs.slice(0, -1).slice(-8).map((m) => `${m.role === "user" ? "主人" : "你"}：${plain(m).slice(0, 600)}`).join("\n");
  return past ? `<earlier_in_this_chat>\n${past}\n</earlier_in_this_chat>\n\n` : "";
}

const toolName = (n: string) => n.replace(/^mcp__mediahub__/, "");
const webLabel = (name: string, input: { query?: string; url?: string }) => {
  if (name === "WebFetch") {
    let host = input.url ?? "";
    try { host = new URL(host).hostname.replace(/^www\./, ""); } catch { /* keep as given */ }
    return host ? `读取网页 ${host}` : "读取网页";
  }
  return input.query ? `联网搜索「${input.query.slice(0, 24)}」` : "联网搜索";
};
const isWeb = (n: string) => n === "WebSearch" || n === "WebFetch";
const resultText = (c: unknown): string => typeof c === "string" ? c : Array.isArray(c) ? c.map((b: any) => (b?.type === "text" ? b.text : "")).join("") : "";

// One turn = one Claude Agent SDK query (the Claude Code harness, like OKX Helper): our tools are an in-process
// MCP server, the conversation is the SDK session (resumed by id, compacted by the harness when long), so a
// stopped or failed turn keeps its context too. The session id is stored as soon as it is known.
async function turn(app: FastifyInstance, c: Chat, question: string, model: string | undefined, context: Context, run: Run) {
  const t0 = Date.now();
  const steps: Step[] = [];
  const id = c.id;
  const ev = (e: Record<string, unknown>) => emit(id, e);
  let text = "";
  // cards the answer lists (```cards refs): data from this chat's tool results, else looked up once; sent as
  // `card` events while the block streams, stored on the answer
  const shown: Record<string, Card | null> = {};
  const pending: Promise<void>[] = [];
  const showCards = () => {
    if (!text.includes("```cards")) return;
    for (const ref of refsIn(text)) {
      if (ref in shown) continue;
      const have = c.cards?.[ref];
      shown[ref] = have ?? null;
      if (have) ev({ type: "card", ref, card: have });
      else pending.push(lookupCard(app, ref, context.adult).then((card) => {
        shown[ref] = card;
        ev({ type: "card", ref, card });
      }));
    }
  };
  let usage: Usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, searches: 0 };
  let usedModel = model ?? "";
  let sdkCost: number | null = null;
  const priced = () => {
    const c = sdkCost ?? costOf(usedModel, usage);
    return { usage, ...(c != null ? { costUsd: Math.round(c * 10000) / 10000 } : {}) };
  };
  const findTool = (tid: string) => steps.find((x): x is Extract<Step, { t: "tool" }> => x.t === "tool" && x.id === tid);
  try {
    const e = await aiConfig();
    usedModel = model || e.model;
    const ctx: ToolCtx = {
      app, adult: context.adult, refs: c.refs, cards: (c.cards ??= {}),
      saved: (text, replaces) => ev({ type: "memory", text, replaces }),
      phone: (type, req) => new Promise<PhoneOutcome>((resolve) => {
        const rid = Math.random().toString(36).slice(2, 12);
        const timer = setTimeout(() => {
          phoneWaits.delete(rid);
          resolve({ ok: false, error: "App 没有回应：要 App 开着（在前台），手机和电视在同一个 Wi-Fi" });
        }, PHONE_WAIT_MS);
        phoneWaits.set(rid, (r) => {
          clearTimeout(timer);
          resolve(r);
        });
        ev({ type, rid, expires: Date.now() + PHONE_WAIT_MS, ...req });
      }),
      chats: { list: (q, n) => searchChats(q, n, id), read: (cid, n) => readChat(cid, n) },
    };
    // memory: the core profile always; archival memories relevant to this question (and the chat's title).
    // The stable part is the system prompt; time, memory, recent chats and the screen go with the question.
    const [core, recalled] = await Promise.all([profile(), recall(`${c.title} ${question}`)]);
    const system = systemPrompt({ profile: core, recalled, recent: await recentTitles(id), context, now: new Date() });
    const web = context.webSearch ?? e.webSearch;
    const effort = context.effort ?? e.effort;
    const prompt = `<turn_context>\n${system.turn}\n</turn_context>\n\n${c.sessionId ? "" : earlier(c)}${question}`;
    const stream = query({
      prompt,
      options: agentOptions({ e, model: usedModel, system: system.stable, web, effort, resume: c.sessionId, abort: run.abort, mcp: mcpServer(ctx) }),
    });
    // a content block's step, by its index in the current API message (reset at each message_start)
    let blockStep = new Map<number, Step>();
    const thinkStart = new Map<number, number>();
    for await (const m of stream) {
      if (m.session_id && m.session_id !== c.sessionId) {
        c.sessionId = m.session_id;
        void save(c);
      }
      if ("parent_tool_use_id" in m && m.parent_tool_use_id) continue;
      if (m.type === "stream_event") {
        const e = m.event;
        if (e.type === "message_start") {
          blockStep = new Map();
          thinkStart.clear();
        } else if (e.type === "content_block_start") {
          const b = e.content_block;
          if (b.type === "thinking") {
            const s: Step = { t: "think", v: "" };
            steps.push(s);
            blockStep.set(e.index, s);
            thinkStart.set(e.index, Date.now());
            ev({ type: "think_start" });
          } else if (b.type === "text") {
            // a text block right after another continues it (web search answers split at each citation)
            const prev = steps[steps.length - 1];
            if (prev?.t === "text") blockStep.set(e.index, prev);
            else {
              const s: Step = { t: "text", v: "" };
              steps.push(s);
              blockStep.set(e.index, s);
              ev({ type: "text_start" });
            }
          } else if (b.type === "tool_use" || b.type === "server_tool_use") {
            const name = toolName(b.name);
            const s: Step = { t: "tool", id: b.id, name, label: isWeb(name) ? webLabel(name, {}) : labelOf(name, {}), input: "", ok: null };
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
            if (e.delta.text.includes("\n") || e.delta.text.includes("`")) showCards();
          }
        } else if (e.type === "content_block_stop") {
          const s = blockStep.get(e.index);
          if (s?.t === "think") {
            s.ms = Date.now() - (thinkStart.get(e.index) ?? Date.now());
            ev({ type: "think_end", ms: s.ms });
          }
        }
      } else if (m.type === "assistant") {
        // complete tool inputs: label them
        for (const b of m.message.content) {
          if (b.type !== "tool_use") continue;
          const name = toolName(b.name);
          const input = JSON.stringify(b.input);
          const label = isWeb(name) ? webLabel(name, b.input as never) : labelOf(name, b.input);
          const s = findTool(b.id);
          if (s) Object.assign(s, { label, input });
          else steps.push({ t: "tool", id: b.id, name, label, input, ok: null });
          ev({ type: "tool_input", id: b.id, input, label });
        }
      } else if (m.type === "user") {
        const content = m.message.content;
        if (!Array.isArray(content)) continue;
        for (const b of content) {
          if (b.type !== "tool_result") continue;
          const s = findTool(b.tool_use_id);
          const ok = !b.is_error;
          const full = resultText(b.content);
          const output = full.length > 3000 ? `${full.slice(0, 3000)}…` : full;
          if (s) Object.assign(s, { ok, output });
          ev({ type: "tool_done", id: b.tool_use_id, ok, output });
          if (s) log.info({ chat: id, tool: s.name, ok, len: full.length }, "ai tool");
        }
      } else if (m.type === "result") {
        const u = m.usage;
        usage = {
          input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0,
          cacheRead: u.cache_read_input_tokens ?? 0, searches: u.server_tool_use?.web_search_requests ?? 0,
        };
        sdkCost = typeof m.total_cost_usd === "number" ? m.total_cost_usd : null;
        if (m.subtype !== "success" || m.is_error) {
          const detail = "errors" in m && Array.isArray(m.errors) ? m.errors.join("; ") : "result" in m ? String(m.result ?? "") : "";
          throw new Error(m.subtype === "error_max_turns" ? "步骤太多，没做完" : detail || `模型调用失败（${m.subtype}）`);
        }
      }
    }
    if (run.abort.signal.aborted) throw new Error("已停止");
    for (const s of steps) if (s.t === "tool" && s.ok == null) s.ok = true;
    showCards();
    await Promise.race([Promise.all(pending), new Promise((r) => setTimeout(r, 8000))]);
    const latencyMs = Date.now() - t0;
    const p = priced();
    c.msgs.push({ id: c.msgs.length + 1, ts: Date.now(), role: "assistant", content: text, steps: steps.filter((s) => s.t !== "text" || s.v), latencyMs, ...p, ...(Object.keys(shown).length ? { cards: shown } : {}) });
    c.updated = Date.now();
    await save(c);
    ev({ type: "done", text, cost: p.costUsd ?? 0, usage, latencyMs });
    log.info({ chat: id, ms: latencyMs, steps: steps.length, model: usedModel, ...usage, cost: p.costUsd }, "ai turn done");
  } catch (e) {
    const err = run.abort.signal.aborted ? "已停止" : e instanceof Error ? e.message : String(e);
    if (!run.abort.signal.aborted) log.warn({ chat: id, err }, "ai turn failed");
    for (const s of steps) if (s.t === "tool" && s.ok == null) s.ok = false;
    c.msgs.push({ id: c.msgs.length + 1, ts: Date.now(), role: "assistant", content: text, steps: steps.filter((s) => s.t !== "text" || s.v), error: err, latencyMs: Date.now() - t0, ...priced(), ...(Object.keys(shown).length ? { cards: shown } : {}) });
    c.updated = Date.now();
    await save(c);
    ev({ type: "error", error: err });
  }
}
