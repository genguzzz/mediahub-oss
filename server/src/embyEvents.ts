// Emby push → plugin. Emby sends `LibraryChanged` (ItemsAdded / ItemsUpdated) over /embywebsocket, but only to
// sessions of a signed-in user (an API-key connection gets nothing), and Webhooks need Emby Premiere. The server
// already holds the app's Emby account (EMBY_USER/EMBY_PASS), so it signs in, listens, and forwards the changed
// item ids to the plugin (/hub/emby/changed), which confirms waiting ingest tasks and identifies new 里番 right away
// instead of polling every few minutes.
import { config } from "./config.ts";
import { plug } from "./mp.ts";

type Log = { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void };

const AUTH = 'MediaBrowser Client="MediaHubServer", Device="server", DeviceId="mediahub-server", Version="1.0"';
const DEBOUNCE_MS = 3000;
const KEEPALIVE_MS = 30_000;

export const embyEvents = { connected: false, since: 0, events: 0, forwarded: 0, lastEvent: 0, lastError: "" };

export function startEmbyEvents(log: Log): void {
  if (!config.emby.user || !config.emby.url) return;
  const base = config.emby.url.replace(/\/+$/, "");
  let backoff = 5000;
  let pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = async () => {
    const ids = [...pending].slice(0, 300);
    pending = new Set();
    timer = null;
    try {
      await plug("POST", "/hub/emby/changed", { body: { ids }, timeoutMs: 30_000 });
      embyEvents.forwarded += ids.length;
    } catch (e) {
      log.warn({ err: e instanceof Error ? e.message : String(e) }, "emby events forward failed");
    }
  };

  const login = async (): Promise<string> => {
    const r = await fetch(`${base}/emby/Users/AuthenticateByName`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-emby-authorization": AUTH },
      body: JSON.stringify({ Username: config.emby.user, Pw: config.emby.pass }),
    });
    if (!r.ok) throw new Error(`Emby login ${r.status}`);
    return ((await r.json()) as { AccessToken: string }).AccessToken;
  };

  const connect = async () => {
    let ws: WebSocket;
    try {
      const token = await login();
      ws = new WebSocket(`${base.replace(/^http/, "ws")}/embywebsocket?api_key=${token}&deviceId=mediahub-server`);
    } catch (e) {
      embyEvents.lastError = e instanceof Error ? e.message : String(e);
      log.warn({ err: embyEvents.lastError, retryMs: backoff }, "emby events connect failed");
      setTimeout(() => void connect(), backoff);
      backoff = Math.min(backoff * 2, 300_000);
      return;
    }
    const keep = setInterval(() => { try { ws.send(JSON.stringify({ MessageType: "KeepAlive" })); } catch { /* reconnect below */ } }, KEEPALIVE_MS);
    ws.onopen = () => {
      embyEvents.connected = true;
      embyEvents.since = Date.now();
      backoff = 5000;
      log.info({}, "emby events connected");
    };
    ws.onmessage = (ev) => {
      let m: { MessageType?: string; Data?: { ItemsAdded?: string[]; ItemsUpdated?: string[] } };
      try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.MessageType === "ForceKeepAlive") ws.send(JSON.stringify({ MessageType: "KeepAlive" }));
      if (m.MessageType !== "LibraryChanged") return;
      const ids = [...(m.Data?.ItemsAdded ?? []), ...(m.Data?.ItemsUpdated ?? [])];
      if (!ids.length) return;
      embyEvents.events++;
      embyEvents.lastEvent = Date.now();
      for (const id of ids) pending.add(id);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void flush(), DEBOUNCE_MS);
    };
    ws.onclose = () => {
      clearInterval(keep);
      embyEvents.connected = false;
      log.warn({ retryMs: backoff }, "emby events closed");
      setTimeout(() => void connect(), backoff);
      backoff = Math.min(backoff * 2, 300_000);
    };
    ws.onerror = () => { /* onclose follows */ };
  };

  void connect();
}
