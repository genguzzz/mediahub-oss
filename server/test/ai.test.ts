// Unit tests for the assistant's pure helpers: card refs and builders, step labels, the API route hint.
// Run: npm test (node:test, no network).
import { test } from "node:test";
import assert from "node:assert/strict";
import { build, refsIn, remember, type CardStore } from "../src/ai/cards.ts";
import { labelOf, TOOLS } from "../src/ai/tools.ts";

test("refsIn reads finished lines of closed and streaming blocks", () => {
  assert.deepEqual(refsIn("intro\n```cards\ntv:1396 | 好看\n- person:17419\nemby:11"), ["tv:1396", "person:17419"]);
  assert.deepEqual(refsIn("```cards\ntv:1396\nbili:BV1xx\n```\n```cards\ntv:1396\nsub:21\n```"), ["tv:1396", "bili:BV1xx", "sub:21"]);
  assert.deepEqual(refsIn("```media\n[{\"tmdbid\":1}]\n```"), []);
});

test("work card: ingest only when known not in library", () => {
  const [ref, c] = build.work({ type: "tv", tmdbid: 1396, title: "绝命毒师", year: "2008", poster: "/x.jpg", library: null })!;
  assert.equal(ref, "tv:1396");
  assert.deepEqual(c.ingest, { type: "tv", tmdbid: 1396 });
  assert.equal(c.link, "/media/tv/1396");
  assert.equal(build.work({ type: "movie", tmdbid: 1, title: "a", inLibrary: true })![1].badge?.text, "已入库");
  assert.equal(build.work({ type: "movie", tmdbid: 1, title: "a" })![1].ingest, undefined);
  assert.equal(build.work({ type: "person", tmdbid: 1 }), null);
});

test("person, video, live, task, sub cards", () => {
  assert.equal(build.person({ id: 287, name: "Brad Pitt", dept: "Acting" })![1].sub, "演员");
  const [vref, v] = build.video({ site: "bilibili", id: "BV1ab", title: "t", cover: "i0.hdslb.com/a.jpg" })!;
  assert.equal(vref, "bili:BV1ab");
  assert.equal(v.image, "https://i0.hdslb.com/a.jpg");
  assert.equal(v.app, "bilibili://video/BV1ab");
  assert.equal(build.video({ site: "bilibili", live: true, roomId: "123", title: "x" })![0], "bililive:123");
  assert.equal(build.video({ site: "youtube", id: "abcdefg", title: "y" })![1].image, "https://i.ytimg.com/vi/abcdefg/mqdefault.jpg");
  assert.equal(build.task({ hash: "z" }), null);
  assert.equal(build.task({ hash: "a".repeat(40), status: "failed" })![1].badge?.tone, "warn");
  assert.equal(build.sub({ id: 21, title: "至高之力", season: 1, state: "R", lack: 9, total: 14 })![1].sub, "追更中 · 缺 9/14 集");
});

test("card store keeps the newest 400", () => {
  const s: CardStore = {};
  for (let i = 0; i < 410; i++) remember(s, build.work({ type: "movie", tmdbid: i + 1, title: String(i) }));
  assert.equal(Object.keys(s).length, 400);
  assert.ok(!("movie:1" in s) && "movie:410" in s);
  remember(s, build.work({ type: "movie", tmdbid: 20, title: "again" }));
  assert.equal(Object.keys(s).at(-1), "movie:20");
});

test("step labels never show undefined before the input arrives", () => {
  for (const name of Object.keys(TOOLS)) {
    const l = labelOf(name, {});
    assert.ok(l && !/undefined|null|NaN|「」/.test(l), `${name}: ${l}`);
  }
  assert.equal(labelOf("search_media", { query: "无间道" }), "搜索「无间道」");
  assert.equal(labelOf("nope", {}), "nope");
});
