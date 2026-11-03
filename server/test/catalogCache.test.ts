// Catalog pages are fetched on every request: the cache only holds a page for the minimum interval (requests
// inside it share one fetch) and answers with the last good copy when a refetch fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

let hits = 0;
let fail = false;
let flaky = 0;      // answer 502 this many more times (site briefly down)
const server = createServer((_req, res) => {
  hits++;
  if (flaky > 0) { flaky--; res.writeHead(502); return res.end("bad gateway"); }
  if (fail) { res.writeHead(500); return res.end("down"); }
  res.end(`page ${hits}`);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/list`;

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "mh-cat-"));
process.env.SOURCE_PROXY = "javdb=direct";
const { proxied, MIN_INTERVAL, RETRY_WAITS } = await import("../src/catalog/http.ts");
MIN_INTERVAL.plain = 80;
RETRY_WAITS.splice(0, RETRY_WAITS.length, 10, 20);

test("requests inside the minimum interval share one fetch", async () => {
  const [a, b, c] = await Promise.all([proxied(url), proxied(url), proxied(url)]);
  assert.equal(hits, 1);
  assert.deepEqual([a, b, c], ["page 1", "page 1", "page 1"]);
  assert.equal(await proxied(url), "page 1");
  assert.equal(hits, 1);
});

test("after the interval the page is fetched again", async () => {
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(await proxied(url), "page 2");
  assert.equal(hits, 2);
});

test("a failed refetch answers with the last good copy", async () => {
  await new Promise((r) => setTimeout(r, 120));
  fail = true;
  assert.equal(await proxied(url), "page 2");
  assert.equal(hits, 3);
  fail = false;
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(await proxied(url), "page 4");       // the failure was not cached
});

test("a brief 502 is retried; a lasting one says the site is temporarily down", async () => {
  flaky = 1;
  assert.match(await proxied(`${url}?flaky`), /^page /);
  flaky = 5;
  await assert.rejects(proxied(`${url}?down`), /站点暂时不可用（502）/);
  flaky = 0;
});

test("no copy yet: the failure is reported", async () => {
  fail = true;
  await assert.rejects(proxied(`${url}?other`), /页面返回 500/);
  fail = false;
  server.close();
});
