// DLNA / UPnP casting: finds renderers (TVs) and drives their AVTransport + RenderingControl over
// plain SOAP. The TV pulls the video itself (Emby URL → NAS → 115 302), the phone only remote-controls.
import { device } from "../../modules/mediahub-player";
import { logger } from "./log";

const log = logger("dlna");

export interface Renderer { name: string; location: string; base: string; avt: string; rc: string }
export interface CastStatus { state: string; position: number; duration: number }

const xmlText = (xml: string, tag: string) => new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(xml)?.[1]?.trim() ?? "";
const unescapeXml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

async function get(url: string, ms = 4000): Promise<string> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await (await fetch(url, { signal: ctl.signal })).text();
  } finally {
    clearTimeout(t);
  }
}

function serviceControl(xml: string, kind: "AVTransport" | "RenderingControl"): string {
  for (const m of xml.matchAll(/<service>([\s\S]*?)<\/service>/gi)) {
    if (m[1].includes(`service:${kind}:`)) return xmlText(m[1], "controlURL");
  }
  return "";
}

export async function describe(location: string): Promise<Renderer | null> {
  try {
    const xml = await get(location);
    if (!/MediaRenderer/i.test(xml)) return null;
    const avt = serviceControl(xml, "AVTransport");
    if (!avt) return null;
    const u = new URL(location);
    const urlBase = xmlText(xml, "URLBase");
    const base = (urlBase || `${u.protocol}//${u.host}/`).replace(/\/?$/, "/");
    return { name: unescapeXml(xmlText(xml, "friendlyName")) || u.hostname, location, base, avt, rc: serviceControl(xml, "RenderingControl") };
  } catch (e) {
    log.warn("describe failed", { location, err: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

// Native unicast/multicast SSDP sweep (runtime 5+). null = binary without it.
export async function discover(): Promise<Renderer[] | null> {
  const hits = await device.ssdpScan();
  if (!hits) return null;
  const found = await Promise.all(hits.map((h) => describe(h.location)));
  const seen = new Set<string>();
  return found.filter((r): r is Renderer => !!r && !seen.has(r.location) && !!seen.add(r.location));
}

// "192.168.1.50:16990" or a full description URL typed by hand.
export async function fromAddress(text: string): Promise<Renderer | null> {
  const t = text.trim();
  if (!t) return null;
  return describe(/^https?:\/\//.test(t) ? t : `http://${t}`);
}

function url(r: Renderer, path: string) {
  return path.startsWith("http") ? path : new URL(path.replace(/^\//, ""), r.base).toString();
}

async function soap(r: Renderer, service: "AVTransport" | "RenderingControl", action: string, args: string): Promise<string> {
  const path = service === "AVTransport" ? r.avt : r.rc;
  const body = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="urn:schemas-upnp-org:service:${service}:1"><InstanceID>0</InstanceID>${args}</u:${action}></s:Body></s:Envelope>`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await fetch(url(r, path), {
      method: "POST",
      headers: { "Content-Type": 'text/xml; charset="utf-8"', SOAPAction: `"urn:schemas-upnp-org:service:${service}:1#${action}"` },
      body,
      signal: ctl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(xmlText(text, "errorDescription") || `${action} ${res.status}`);
    return text;
  } finally {
    clearTimeout(t);
  }
}

const clock = (s: number) => {
  const n = Math.max(0, Math.round(s));
  return [Math.floor(n / 3600), Math.floor((n % 3600) / 60), n % 60].map((x) => String(x).padStart(2, "0")).join(":");
};
const seconds = (t: string) => {
  const p = t.split(":").map(Number);
  return p.length === 3 && p.every((x) => !Number.isNaN(x)) ? p[0] * 3600 + p[1] * 60 + p[2] : 0;
};

export const cast = {
  async load(r: Renderer, uri: string, title: string, at = 0) {
    const didl = `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"><item id="1" parentID="0" restricted="1"><dc:title>${escapeXml(title)}</dc:title><upnp:class>object.item.videoItem</upnp:class><res protocolInfo="http-get:*:video/mp4:*">${escapeXml(uri)}</res></item></DIDL-Lite>`;
    await soap(r, "AVTransport", "Stop", "").catch(() => {});
    await soap(r, "AVTransport", "SetAVTransportURI", `<CurrentURI>${escapeXml(uri)}</CurrentURI><CurrentURIMetaData>${escapeXml(didl)}</CurrentURIMetaData>`);
    await soap(r, "AVTransport", "Play", "<Speed>1</Speed>");
    if (at > 5) {
      // Most TVs refuse Seek until they are PLAYING with a known duration: retry for a few seconds.
      for (let i = 0; i < 8; i++) {
        await new Promise((res) => setTimeout(res, 1200));
        const s = await cast.status(r).catch(() => null);
        if (s?.state === "PLAYING" && s.duration > 0) {
          await cast.seek(r, at).catch(() => {});
          break;
        }
      }
    }
  },
  play: (r: Renderer) => soap(r, "AVTransport", "Play", "<Speed>1</Speed>"),
  pause: (r: Renderer) => soap(r, "AVTransport", "Pause", ""),
  stop: (r: Renderer) => soap(r, "AVTransport", "Stop", ""),
  seek: (r: Renderer, to: number) => soap(r, "AVTransport", "Seek", `<Unit>REL_TIME</Unit><Target>${clock(to)}</Target>`),
  async status(r: Renderer): Promise<CastStatus> {
    const [t, p] = await Promise.all([soap(r, "AVTransport", "GetTransportInfo", ""), soap(r, "AVTransport", "GetPositionInfo", "")]);
    return { state: xmlText(t, "CurrentTransportState"), position: seconds(xmlText(p, "RelTime")), duration: seconds(xmlText(p, "TrackDuration")) };
  },
  async volume(r: Renderer): Promise<number | null> {
    if (!r.rc) return null;
    const v = Number(xmlText(await soap(r, "RenderingControl", "GetVolume", "<Channel>Master</Channel>"), "CurrentVolume"));
    return Number.isNaN(v) ? null : v;
  },
  setVolume: (r: Renderer, v: number) => soap(r, "RenderingControl", "SetVolume", `<Channel>Master</Channel><DesiredVolume>${Math.max(0, Math.min(100, Math.round(v)))}</DesiredVolume>`),
};
