// Device capabilities behind one door : feature code calls these, never
// expo-* directly. Every wrapper checks that the native module exists in this binary (OTA code can
// run on an older runtime), logs and tracks the call, and returns null instead of throwing when the
// user cancels or the module is missing.
import { Platform, Share } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";
import { logger } from "./log";
import { track } from "./track";

const log = logger("device");

const MODULES = {
  keepAwake: "ExpoKeepAwake",
  biometrics: "ExpoLocalAuthentication",
  documentPicker: "ExpoDocumentPicker",
  sharing: "ExpoSharing",
  network: "ExpoNetwork",
  sqlite: "ExpoSQLite",
  speech: "ExpoSpeechRecognition",
  gradient: "ExpoLinearGradient",
  glass: "ExpoGlassEffect",
  quickActions: "ExpoQuickActions",
  localization: "ExpoLocalization",
  player: "MediahubPlayer",
  airplay: "MediahubAirPlay",
} as const;
export type Capability = keyof typeof MODULES;

const present = new Map<Capability, boolean>();
export function has(c: Capability): boolean {
  if (Platform.OS === "web") return c === "gradient" || c === "localization";
  if (!present.has(c)) present.set(c, requireOptionalNativeModule(MODULES[c]) !== null);
  return present.get(c)!;
}

export function capabilities(): Record<Capability, boolean> {
  return Object.fromEntries((Object.keys(MODULES) as Capability[]).map((c) => [c, has(c)])) as Record<Capability, boolean>;
}

// ---------- keep awake (player) ----------

export async function keepAwake(tag: string, on: boolean) {
  if (!has("keepAwake")) return;
  const m = await import("expo-keep-awake");
  try {
    if (on) await m.activateKeepAwakeAsync(tag);
    else await m.deactivateKeepAwake(tag);
  } catch (e) {
    log.warn("keepAwake failed", { on, err: e instanceof Error ? e.message : e });
  }
}

// ---------- Face ID / passcode ----------

export async function authenticate(reason: string): Promise<boolean> {
  if (!has("biometrics")) return true;
  const m = await import("expo-local-authentication");
  const r = await m.authenticateAsync({ promptMessage: reason, cancelLabel: "取消", disableDeviceFallback: false });
  track("device.auth", { ok: r.success, err: r.success ? undefined : r.error });
  return r.success;
}

// ---------- files ----------

// Pick a file from Files / iCloud Drive and keep a cached copy; null when cancelled.
export async function pickFile(types: string[] = ["*/*"]): Promise<{ uri: string; name: string; size?: number } | null> {
  if (!has("documentPicker")) return null;
  const m = await import("expo-document-picker");
  const r = await m.getDocumentAsync({ type: types, copyToCacheDirectory: true, multiple: false });
  track("device.pick_file", { ok: !r.canceled });
  if (r.canceled || !r.assets?.[0]) return null;
  return { uri: r.assets[0].uri, name: r.assets[0].name, size: r.assets[0].size ?? undefined };
}

export async function shareText(text: string) {
  track("device.share");
  await Share.share({ message: text });
}

export async function shareFile(uri: string) {
  if (!has("sharing")) return shareText(uri);
  const m = await import("expo-sharing");
  if (await m.isAvailableAsync()) await m.shareAsync(uri);
}

// ---------- network ----------

export async function connection(): Promise<{ type: string; cellular: boolean } | null> {
  if (!has("network")) return null;
  const m = await import("expo-network");
  const s = await m.getNetworkStateAsync();
  return { type: String(s.type ?? "unknown"), cellular: s.type === m.NetworkStateType.CELLULAR };
}

// ---------- voice input ----------

// One-shot speech → text (Chinese by default) for the search box; null when unavailable or denied.
export async function listenOnce(lang = "zh-CN", timeoutMs = 8000): Promise<string | null> {
  if (!has("speech")) return null;
  const { ExpoSpeechRecognitionModule: S } = await import("expo-speech-recognition");
  const perm = await S.requestPermissionsAsync();
  if (!perm.granted) {
    track("device.speech", { ok: false, err: "denied" });
    return null;
  }
  return new Promise((resolve) => {
    let text = "";
    const subs = [
      S.addListener("result", (e: { results: { transcript: string }[]; isFinal: boolean }) => {
        text = e.results[0]?.transcript ?? text;
        if (e.isFinal) finish();
      }),
      S.addListener("error", () => finish()),
      S.addListener("end", () => finish()),
    ];
    const timer = setTimeout(() => {
      S.stop();
      finish();
    }, timeoutMs);
    let done = false;
    function finish() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      subs.forEach((s) => s.remove());
      track("device.speech", { ok: !!text, len: text.length });
      resolve(text || null);
    }
    S.start({ lang, interimResults: true, continuous: false });
  });
}
