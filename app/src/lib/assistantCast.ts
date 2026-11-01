// The assistant's TV tools, run on the phone (it shares the TV's network): the server sends an event
// (lib/ai.ts) — `cast` (cast_to_tv: an Emby item to a TV by DLNA) or `tv` (tv_control: play / pause / seek /
// volume / status) — on the TV named in the request, else the one used last, else the first found; the
// outcome goes back to /v1/ai/phone/:rid, which the waiting tool returns to the model.
import { api } from "./api";
import { cast, describe, discover, type Renderer } from "./dlna";
import { embyApi, playbackPlan } from "./emby";
import { logger } from "./log";
import { getSettings, setSettings } from "./settings";
import { track } from "./track";
import { toast, toastError } from "@/components/ui";

const log = logger("ai-cast");
const handled = new Set<string>();

export interface CastRequest { rid: string; expires: number; embyId: string; title: string; resume: boolean; tv?: string }

const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, "");

async function pickTv(want?: string): Promise<{ tv: Renderer | null; devices: string[] }> {
  const saved = getSettings().castTv;
  if (!want && saved) {
    const r = await describe(saved.location);
    if (r) return { tv: r, devices: [r.name] };
  }
  const found = (await discover()) ?? [];
  const devices = found.map((r) => r.name);
  if (want) return { tv: found.find((r) => norm(r.name).includes(norm(want))) ?? null, devices };
  return { tv: found[0] ?? null, devices };
}

export async function castForAssistant(req: CastRequest) {
  // a re-attached stream replays the turn's events: cast each request once, and only while the tool waits
  if (handled.has(req.rid) || Date.now() > req.expires) return;
  handled.add(req.rid);
  const report = (r: { ok: boolean; error?: string; [k: string]: unknown }) =>
    api(`/v1/ai/phone/${req.rid}`, { method: "POST", body: r }).catch((e) => log.warn("cast report failed", e));
  try {
    const { tv, devices } = await pickTv(req.tv);
    if (!tv) {
      const error = req.tv
        ? `没找到名字像「${req.tv}」的电视${devices.length ? `，找到的有：${devices.join("、")}` : ""}`
        : "没找到电视：确认手机和电视在同一个 Wi-Fi，并允许影库访问「本地网络」";
      toast("投屏失败", error, undefined, true);
      await report({ ok: false, error, devices });
      return;
    }
    const at = req.resume ? ((await embyApi.item(req.embyId).catch(() => null))?.UserData?.PlaybackPositionTicks ?? 0) / 1e7 : 0;
    const plan = await playbackPlan(req.embyId, at);
    await cast.load(tv, plan.uri, req.title, at);
    setSettings({ castTv: { name: tv.name, location: tv.location } });
    track("ai_cast", { ok: true });
    toast(`已投到 ${tv.name}`, req.title);
    await report({ ok: true, tv: tv.name, devices });
  } catch (e) {
    track("ai_cast", { ok: false });
    toastError("投屏失败", e);
    await report({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

export interface TvRequest { rid: string; expires: number; action: string; seconds?: number; level?: number; step?: number; tv?: string }

const LABEL: Record<string, string> = { PLAYING: "播放中", PAUSED_PLAYBACK: "已暂停", STOPPED: "已停止", TRANSITIONING: "加载中", NO_MEDIA_PRESENT: "没有在放" };

export async function controlForAssistant(req: TvRequest) {
  if (handled.has(req.rid) || Date.now() > req.expires) return;
  handled.add(req.rid);
  const report = (r: { ok: boolean; error?: string; [k: string]: unknown }) =>
    api(`/v1/ai/phone/${req.rid}`, { method: "POST", body: r }).catch((e) => log.warn("tv report failed", e));
  try {
    const { tv, devices } = await pickTv(req.tv);
    if (!tv) {
      const error = req.tv ? `没找到名字像「${req.tv}」的电视${devices.length ? `，找到的有：${devices.join("、")}` : ""}` : "没找到电视：确认手机和电视在同一个 Wi-Fi";
      await report({ ok: false, error, devices });
      return;
    }
    const now = await cast.status(tv);
    const step = req.step ?? 5;
    switch (req.action) {
      case "play": await cast.play(tv); break;
      case "pause": await cast.pause(tv); break;
      case "stop": await cast.stop(tv); break;
      case "seek": await cast.seek(tv, req.seconds ?? 0); break;
      case "forward": await cast.seek(tv, Math.min(now.duration || Infinity, now.position + (req.seconds ?? 30))); break;
      case "back": await cast.seek(tv, Math.max(0, now.position - (req.seconds ?? 30))); break;
      case "volume": await cast.setVolume(tv, req.level ?? 0); break;
      case "volume_up":
      case "volume_down": {
        const v = await cast.volume(tv);
        if (v == null) throw new Error("这台电视不支持调音量");
        await cast.setVolume(tv, v + (req.action === "volume_up" ? step : -step));
        break;
      }
    }
    // the TV settles a moment after a command before its state reads back right
    if (req.action !== "status") await new Promise((r) => setTimeout(r, 800));
    const [st, vol] = await Promise.all([cast.status(tv), cast.volume(tv).catch(() => null)]);
    track("ai_tv", { action: req.action, ok: true });
    await report({ ok: true, tv: tv.name, state: LABEL[st.state] ?? st.state, position: Math.round(st.position), duration: Math.round(st.duration), title: st.title, volume: vol });
  } catch (e) {
    track("ai_tv", { action: req.action, ok: false });
    await report({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}
