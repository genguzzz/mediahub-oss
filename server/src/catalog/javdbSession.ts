// A logged-in JavDB session for the parts JavDB keeps behind an account (the 無碼 section, its rankings
// and detail pages). The owner logs in once from the app (Settings → JavDB 账号): the backend fetches the
// login form and its picture captcha through the index proxy, the app shows the captcha, the owner types
// it, the backend posts the form with "remember me". Only the session cookies are kept
// ($DATA_DIR/javdb-session.json, mode 600); the password is not stored. When JavDB starts redirecting
// to /login again the session is marked expired and 概览 → 健康检查 / the app ask for a new login.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.ts";
import { errText, logger } from "../log.ts";
import { proxiedRaw } from "./http.ts";

const log = logger("javdb-session");
const BASE = "https://javdb.com";
const FILE = () => path.join(config.dataDir, "javdb-session.json");

type Jar = Record<string, string>;
interface Saved { cookies: Jar; user: string; since: number; expired?: number }

let saved: Saved | null = null;
let loaded = false;
const pending = new Map<string, { at: number; cookies: Jar; token: string }>();

async function load() {
  if (loaded) return;
  loaded = true;
  saved = await readFile(FILE(), "utf8").then((t) => JSON.parse(t) as Saved).catch(() => null);
}

async function save() {
  await mkdir(config.dataDir, { recursive: true });
  await writeFile(FILE(), JSON.stringify(saved), { mode: 0o600 });
}

const cookieHeader = (jar: Jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");

function absorb(jar: Jar, res: { headers: { getSetCookie(): string[] } }) {
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    if (i > 0) jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
}

/** Cookie header for JavDB page requests, or "" without a live session. */
export async function javdbCookie(): Promise<string> {
  await load();
  return saved && !saved.expired ? cookieHeader(saved.cookies) : "";
}

/** JavDB sent a logged-in request to /login: the session is gone. */
export async function javdbExpired() {
  await load();
  if (!saved || saved.expired) return;
  saved.expired = Date.now();
  log.warn({ user: saved.user, since: saved.since }, "javdb session expired");
  await save();
}

export async function javdbStatus() {
  await load();
  return saved ? { loggedIn: !saved.expired, user: saved.user, since: saved.since, expired: saved.expired ?? null } : { loggedIn: false, user: "", since: null, expired: null };
}

/** Step 1: a fresh login form; returns its captcha image for the owner to read. */
export async function javdbLoginStart(): Promise<{ id: string; captcha: string }> {
  const jar: Jar = {};
  const page = await proxiedRaw(`${BASE}/login`);
  absorb(jar, page);
  const html = await page.text();
  const token = /<form action="\/user_sessions"[\s\S]*?name="authenticity_token" value="([^"]+)"/.exec(html)?.[1];
  if (!token) throw Object.assign(new Error("没有拿到 JavDB 登录表单"), { statusCode: 502 });
  const img = await proxiedRaw(`${BASE}/rucaptcha/?t=${Date.now()}`, { cookie: cookieHeader(jar), referer: `${BASE}/login` });
  absorb(jar, img);
  if (!img.ok) throw Object.assign(new Error(`验证码图片 ${img.status}`), { statusCode: 502 });
  const body = Buffer.from(await img.arrayBuffer());
  const id = randomUUID().slice(0, 12);
  for (const [k, v] of pending) if (Date.now() - v.at > 10 * 60_000) pending.delete(k);
  pending.set(id, { at: Date.now(), cookies: jar, token });
  return { id, captcha: `data:${img.headers.get("content-type") ?? "image/png"};base64,${body.toString("base64")}` };
}

/** Step 2: post the form with the captcha the owner typed. */
export async function javdbLogin(b: { id: string; email: string; password: string; captcha: string }): Promise<{ ok: boolean; error?: string }> {
  const p = pending.get(b.id);
  if (!p) return { ok: false, error: "验证码已过期，请刷新验证码" };
  pending.delete(b.id);
  const form = new URLSearchParams({ authenticity_token: p.token, email: b.email, password: b.password, _rucaptcha: b.captcha.trim(), remember: "1", commit: "登入" });
  try {
    const res = await proxiedRaw(`${BASE}/user_sessions`, {
      cookie: cookieHeader(p.cookies), referer: `${BASE}/login`, origin: BASE, "content-type": "application/x-www-form-urlencoded",
    }, { method: "POST", body: form.toString(), redirect: "manual" });
    absorb(p.cookies, res);
    const to = res.headers.get("location") ?? "";
    if (res.status >= 300 && res.status < 400 && !/\/login/.test(to)) {
      saved = { cookies: p.cookies, user: b.email, since: Date.now() };
      await save();
      log.info({ user: b.email }, "javdb logged in");
      return { ok: true };
    }
    const html = await res.text().catch(() => "");
    const msg = /<div class="message-body">\s*([^<]+)/.exec(html)?.[1]?.trim() || /class="(?:notification|flash)[^"]*"[^>]*>\s*([^<]+)/.exec(html)?.[1]?.trim() || `JavDB 返回 ${res.status}`;
    log.warn({ user: b.email, status: res.status, msg }, "javdb login failed");
    return { ok: false, error: msg };
  } catch (e) {
    log.warn({ err: errText(e) }, "javdb login failed");
    return { ok: false, error: errText(e) };
  }
}

export async function javdbLogout() {
  saved = null;
  loaded = true;
  await writeFile(FILE(), "null", { mode: 0o600 }).catch(() => {});
}
