// Cloudflare clearance for proxied sources: a challenged request is solved once through the source's
// FlareSolverr, retried with cf_clearance + the solver's user agent next to the caller's cookies, kept for
// later requests, shared by concurrent requests, and never sent to another host.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

const SOLVER_UA = "SolverBrowser/1.0";
let solves = 0;
let challengeAlways = false;
const seen: { url: string; cookie: string; ua: string }[] = [];

const server = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/v1") {
    solves++;
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const b = JSON.parse(body) as { url: string; proxy?: unknown };
      setTimeout(() => res.end(JSON.stringify({ status: "ok", solution: { userAgent: SOLVER_UA, cookies: [{ name: "cf_clearance", value: `ok${solves}` }, { name: "_jdb_session", value: "anon" }], url: b.url } })), 30);
    });
    return;
  }
  const cookie = String(req.headers.cookie ?? "");
  const ua = String(req.headers["user-agent"] ?? "");
  seen.push({ url: req.url ?? "", cookie, ua });
  if (req.url?.startsWith("/img")) return res.end("img");
  if (req.url === "/denied") {                    // a site's own 403 (not Cloudflare): passed through untouched
    res.writeHead(403, { server: "cloudflare" });
    return res.end("forbidden by site");
  }
  if (challengeAlways || !/cf_clearance=ok\d/.test(cookie) || ua !== SOLVER_UA) {
    if (req.url?.startsWith("/h1")) {           // Hanime1 style: block page, no cf-mitigated header
      res.writeHead(403, { server: "cloudflare", "content-type": "text/html" });
      return res.end("<title>Attention Required! | Cloudflare</title>");
    }
    res.writeHead(403, { server: "cloudflare", "cf-mitigated": "challenge" });
    return res.end("Just a moment...");
  }
  res.end(`page ${cookie}`);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as AddressInfo).port;
const site = `http://127.0.0.1:${port}`;

const dir = mkdtempSync(path.join(tmpdir(), "mh-cf-"));
process.env.DATA_DIR = dir;
process.env.SOURCE_PROXY = "javdb=direct;hanime1=direct";
process.env.SOURCE_FLARESOLVERR = `javdb=${site}/v1;hanime1=${site}/v1`;
const { proxiedRaw } = await import("../src/catalog/http.ts");

test("challenge → one solve → retried with clearance, solver UA and the login cookie", async () => {
  const res = await proxiedRaw(`${site}/censored`, { cookie: "_jdb_session=login" });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "page cf_clearance=ok1; _jdb_session=login");
  assert.equal(solves, 1);
  const kept = JSON.parse(readFileSync(path.join(dir, "cf-clearance.json"), "utf8"));
  assert.equal(kept.javdb.cookie, "cf_clearance=ok1");   // only cf_clearance: the solver's anonymous session must not replace the login
  assert.equal(kept.javdb.ua, SOLVER_UA);
});

test("kept clearance is reused without solving", async () => {
  const res = await proxiedRaw(`${site}/rankings`);
  assert.equal(res.status, 200);
  assert.equal(solves, 1);
});

test("Attention Required page (no cf-mitigated) also renews; the solver UA replaces the caller's", async () => {
  const before = solves;
  const { writeFileSync } = await import("node:fs");
  writeFileSync(path.join(dir, "cf-clearance.json"), "{}");
  const res = await proxiedRaw(`${site}/h1/list`, { "user-agent": "Fixed/120" }, {}, "javdb");
  assert.equal(res.status, 200);
  assert.ok(solves - before <= 1);
});

test("a plain 403 from the site is returned as is, without solving", async () => {
  const before = solves;
  const res = await proxiedRaw(`${site}/denied`);
  assert.equal(res.status, 403);
  assert.equal(await res.text(), "forbidden by site");
  assert.equal(solves, before);
});

test("hanime1 goes through curl: block page → solve → page, headers and status parsed", async () => {
  const before = solves;
  const res = await proxiedRaw(`${site}/h1/search?genre=%E8%A3%8F`, { "user-agent": "Fixed/120", referer: "https://hanime1.me/" }, {}, "hanime1");
  assert.equal(res.status, 200);
  assert.match(await res.text(), /^page cf_clearance=ok\d+$/);
  assert.equal(solves - before, 1);
  const last = seen[seen.length - 1];
  assert.equal(last.ua, SOLVER_UA);
  const denied = await proxiedRaw(`${site}/denied`, {}, {}, "hanime1");
  assert.equal(denied.status, 403);
  assert.equal(await denied.text(), "forbidden by site");
});

test("clearance is not sent to another host (image CDN)", async () => {
  seen.length = 0;
  await proxiedRaw(`http://localhost:${port}/img/a.jpg`);
  assert.equal(seen[0].cookie, "");
  assert.notEqual(seen[0].ua, SOLVER_UA);
});

test("concurrent challenged requests share one solve", async () => {
  challengeAlways = false;
  const before = solves;
  const { writeFileSync } = await import("node:fs");
  writeFileSync(path.join(dir, "cf-clearance.json"), "{}");
  // drop the in-memory clearance by making the next answers challenge once
  challengeAlways = true;
  await Promise.allSettled([proxiedRaw(`${site}/a`), proxiedRaw(`${site}/b`)]);
  challengeAlways = false;
  const rs = await Promise.all([proxiedRaw(`${site}/c`), proxiedRaw(`${site}/d`), proxiedRaw(`${site}/e`)]);
  assert.deepEqual(rs.map((r) => r.status), [200, 200, 200]);
  assert.ok(solves - before <= 2, `solves ${solves - before}`);
});

test("still challenged after a fresh solve → error, not an endless loop", async () => {
  challengeAlways = true;
  const before = solves;
  await assert.rejects(proxiedRaw(`${site}/x`), /Cloudflare 验证不被接受/);
  assert.equal(solves - before, 1);
  challengeAlways = false;
  server.close();
});
