// The assistant's memory: lightweight, local, fast recall (no vector store).
//   profile  — core memory, always in the system prompt: the owner's stable taste and rules (≤ 12 short items).
//   fact / event / watching / plan — archival memory: searched, never dumped. Each turn the entries most
//              relevant to the question are recalled into the prompt (<recalled_memories>); memory_search
//              digs further.
// Design after Letta/MemGPT (core vs archival), mem0 (update instead of duplicating) and Claude's memory tool
// (check before writing, edit by id). Scoring: character-bigram overlap (works for Chinese without a
// tokenizer) + tag hits + recency + use, all in memory. Stored in DATA_DIR/ai/memory.json; the old
// notes.json becomes profile entries on first load.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.ts";
import { logger } from "../log.ts";

const log = logger("ai-memory");

export const KINDS = ["profile", "fact", "event", "watching", "plan"] as const;
export type Kind = (typeof KINDS)[number];
export interface Memory { id: number; kind: Kind; text: string; tags: string[]; created: number; updated: number; used: number; hits: number; by: "ai" | "owner" }

const dir = path.join(config.dataDir, "ai");
const file = path.join(dir, "memory.json");
const legacy = path.join(dir, "notes.json");
const MAX = 400;
const MAX_PROFILE = 12;

let mem: Memory[] | null = null;

async function load(): Promise<Memory[]> {
  if (mem) return mem;
  mem = await readFile(file, "utf8").then((t) => JSON.parse(t) as Memory[]).catch(() => null as Memory[] | null);
  if (!mem) {
    const old = await readFile(legacy, "utf8").then((t) => JSON.parse(t) as { id: number; ts: number; text: string; by: "ai" | "owner" }[]).catch(() => []);
    mem = old.map((n) => ({ id: n.id, kind: "profile", text: n.text, tags: [], created: n.ts, updated: n.ts, used: 0, hits: 0, by: n.by }));
    if (old.length) log.info({ n: old.length }, "notes migrated to memory");
    await save();
  }
  return mem;
}

// Writes are serialized (recall's hit counts and a save in the same turn would race on the file).
let chain: Promise<void> = Promise.resolve();
function save(): Promise<void> {
  chain = chain.then(async () => {
    await mkdir(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(mem ?? [], null, 1));
    await rename(tmp, file);
  }).catch((e) => log.error({ err: e instanceof Error ? e.message : String(e) }, "memory save failed"));
  return chain;
}

// ---------- scoring ----------

const norm = (s: string) => s.normalize("NFKC").toLowerCase();
function grams(s: string): Set<string> {
  const t = norm(s).replace(/[\s\p{P}\p{S}]+/gu, " ");
  const out = new Set<string>();
  for (const w of t.split(" ")) {
    if (!w) continue;
    if (/^[a-z0-9]+$/.test(w)) out.add(w);                    // latin words whole
    else for (let i = 0; i < w.length - 1; i++) out.add(w.slice(i, i + 2));   // CJK: bigrams
    if (w.length === 1) out.add(w);
  }
  return out;
}
function overlap(q: Set<string>, d: Set<string>) {
  if (!q.size || !d.size) return 0;
  let n = 0;
  for (const g of q) if (d.has(g)) n++;
  return n / Math.sqrt(q.size * d.size);
}
const similar = (a: string, b: string) => overlap(grams(a), grams(b));

function score(m: Memory, q: Set<string>, qText: string, now: number) {
  const text = overlap(q, grams(`${m.text} ${m.tags.join(" ")}`));
  const tag = m.tags.some((t) => t && norm(qText).includes(norm(t))) ? 0.35 : 0;
  const ageDays = (now - m.updated) / 86400_000;
  const recency = 0.15 * Math.exp(-ageDays / 60);            // fresh memories rank a little higher
  const use = Math.min(0.1, m.hits * 0.01);
  return text + tag + recency + use;
}

// ---------- API used by the chat and tools ----------

export async function profile(): Promise<Memory[]> {
  return (await load()).filter((m) => m.kind === "profile").sort((a, b) => a.id - b.id);
}

/** The archival memories most relevant to a question (for the turn's system prompt). */
export async function recall(query: string, n = 6): Promise<Memory[]> {
  const all = (await load()).filter((m) => m.kind !== "profile");
  if (!all.length) return [];
  const q = grams(query);
  const now = Date.now();
  const ranked = all.map((m) => ({ m, s: score(m, q, query, now) })).filter((x) => x.s > 0.18).sort((a, b) => b.s - a.s).slice(0, n);
  if (ranked.length) {
    for (const { m } of ranked) {
      m.hits += 1;
      m.used = now;
    }
    void save().catch(() => {});
  }
  return ranked.map((x) => x.m);
}

export async function search(query: string, kind?: Kind, limit = 10): Promise<(Memory & { score: number })[]> {
  const q = grams(query);
  const now = Date.now();
  return (await load()).filter((m) => !kind || m.kind === kind)
    .map((m) => ({ ...m, score: Math.round(score(m, q, query, now) * 100) / 100 }))
    .filter((m) => !query.trim() || m.score > 0.1)
    .sort((a, b) => b.score - a.score || b.updated - a.updated).slice(0, limit);
}

/** Save a memory. A near-duplicate of the same kind (or `replaces`) is updated instead of added. */
export async function saveMemory(p: { text: string; kind: Kind; tags?: string[]; replaces?: number; by: "ai" | "owner" }): Promise<{ memory: Memory; action: "added" | "updated" }> {
  const all = await load();
  const text = p.text.trim().slice(0, 300);
  const tags = [...new Set((p.tags ?? []).map((t) => t.trim()).filter(Boolean))].slice(0, 6);
  const now = Date.now();
  let hit = p.replaces ? all.find((m) => m.id === p.replaces) : undefined;
  hit ??= all.find((m) => m.kind === p.kind && similar(m.text, text) >= 0.72);
  if (hit) {
    Object.assign(hit, { text, kind: p.kind, tags: tags.length ? tags : hit.tags, updated: now, by: p.by });
    await save();
    return { memory: hit, action: "updated" };
  }
  if (p.kind === "profile" && all.filter((m) => m.kind === "profile").length >= MAX_PROFILE) {
    throw new Error(`核心画像已有 ${MAX_PROFILE} 条：合并或用 replaces 替换一条，或存成 fact`);
  }
  const m: Memory = { id: Math.max(0, ...all.map((x) => x.id)) + 1, kind: p.kind, text, tags, created: now, updated: now, used: 0, hits: 0, by: p.by };
  all.push(m);
  // over the cap: drop the least useful archival memories (old, never recalled)
  if (all.length > MAX) {
    const drop = all.filter((x) => x.kind !== "profile").sort((a, b) => (a.hits - b.hits) || (a.updated - b.updated)).slice(0, all.length - MAX).map((x) => x.id);
    mem = all.filter((x) => !drop.includes(x.id));
  }
  await save();
  return { memory: m, action: "added" };
}

export async function forget(id: number): Promise<boolean> {
  const all = await load();
  const n = all.length;
  mem = all.filter((m) => m.id !== id);
  if (mem.length === n) return false;
  await save();
  return true;
}

export async function allMemories(): Promise<Memory[]> {
  return [...(await load())].sort((a, b) => (a.kind === "profile" ? 0 : 1) - (b.kind === "profile" ? 0 : 1) || b.updated - a.updated);
}
