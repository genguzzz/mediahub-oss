// The assistant's cast_to_tv: the server sends a `cast` event (lib/ai.ts), the phone casts the Emby item to a
// TV by DLNA — the TV named in the request, else the one used last, else the first found — and posts the
// outcome back to /v1/ai/cast/:rid, which the waiting tool returns to the model.
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
  const report = (r: { ok: boolean; tv?: string; error?: string; devices?: string[] }) =>
    api(`/v1/ai/cast/${req.rid}`, { method: "POST", body: r }).catch((e) => log.warn("cast report failed", e));
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
