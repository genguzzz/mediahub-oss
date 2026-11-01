// list_chats search over stored chats (DATA_DIR/ai/chats): any word matches title or Q&A, the current chat is
// marked, no match falls back to the recent chats.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "mh-chats-"));
process.env.DATA_DIR = dir;
mkdirSync(path.join(dir, "ai", "chats"), { recursive: true });
const chat = (id: number, title: string, q: string, a: string, updated: number) =>
  writeFileSync(path.join(dir, "ai", "chats", `${id}.json`), JSON.stringify({
    id, title, created: updated, updated, refs: {},
    msgs: [{ id: 1, ts: updated, role: "user", content: q, steps: [] }, { id: 2, ts: updated, role: "assistant", content: a, steps: [] }],
  }));
chat(1, "推荐几部悬疑片", "推荐几部悬疑片", "《彗星来的那一夜》很烧脑", 1000);
chat(2, "至高之力怎么入库的", "至高之力怎么入库的", "是新番自动订阅", 2000);
chat(3, "无间道", "无间道在库里吗", "在，超清版本", 3000);
const { searchChats } = await import("../src/ai/chat.ts");

test("any word matches title or content, newest first, with a snippet", async () => {
  const r = (await searchChats("彗星 至高之力", 10, 0)) as any[];
  assert.deepEqual(r.map((c) => c.id), [2, 1]);
  assert.match(r[1].hit, /彗星/);
});

test("the current chat is listed and marked", async () => {
  const r = (await searchChats("超清", 10, 3)) as any[];
  assert.equal(r.length, 1);
  assert.equal(r[0].current, true);
});

test("no match gives the recent chats instead of an empty list", async () => {
  const r = (await searchChats("不存在的词", 10, 0)) as any;
  assert.match(r.noMatch, /不存在的词/);
  assert.deepEqual(r.recent.map((c: any) => c.id), [3, 2, 1]);
});

test("no query lists recent chats up to the limit", async () => {
  const r = (await searchChats("", 2, 0)) as any[];
  assert.deepEqual(r.map((c) => c.id), [3, 2]);
});
