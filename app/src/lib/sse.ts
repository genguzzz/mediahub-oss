// Server-Sent Events from this app's server: a fetch that streams the body (expo/fetch on device, the browser's
// on web), the token header, and a reader that turns `data: <json>` blocks into events (`: ping` keeps it warm).
import { Platform } from "react-native";
import { appVersion } from "./api";
import { getSettings } from "./settings";

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;
const plainFetch: Fetch = (u, i) => fetch(u, i);
let streamFetchP: Promise<Fetch> | null = null;
/** expo/fetch streams the response body natively; the browser's fetch already does (web preview). */
export function streamFetch(): Promise<Fetch> {
  if (Platform.OS === "web") return Promise.resolve(plainFetch);
  streamFetchP ??= import("expo/fetch").then((m) => m.fetch as unknown as Fetch);
  return streamFetchP;
}

const ascii = appVersion.replace(/[^\x20-\x7e]/g, "?"); // header values must be ASCII

/** fetch to this app's server with its token (same settings as every other request). */
export async function kfetch(path: string, init: RequestInit = {}, f: Fetch = plainFetch): Promise<Response> {
  const { server, token } = getSettings();
  if (!token) throw new Error("还没有设置访问令牌，请在设置里填写");
  return f(server + path, { ...init, headers: { ...((init.headers as Record<string, string>) || {}), "x-app-version": ascii, authorization: `Bearer ${token}` } });
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

/** Read an SSE response body until it ends. Bytes are decoded up to the last newline only, so a multi-byte
 *  character split across chunks is never cut. */
export async function pump(r: Response, onEvent: (ev: any) => void, onData: () => void) {
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
      }
    }
  }
}
