// Voice for the AI chat: iOS on-device speech recognition (expo-speech-recognition, already in the binary
// for voice search) instead of recording + server transcription. The recognizer's volume events drive the
// waveform; stop() waits briefly for the final transcript. Loaded lazily behind has("speech").
import { useCallback, useEffect, useRef, useState } from "react";
import { has, haptic } from "./device";
import { logger } from "./log";

const log = logger("voice");
const BARS = 24;

type Sub = { remove: () => void };

/** Listening with a live level (0–1) and the recent levels (waveform bars, newest last). */
export function useRecorder() {
  const [levels, setLevels] = useState<number[]>(() => Array(BARS).fill(0));
  const [level, setLevel] = useState(0);
  const [secs, setSecs] = useState(0);
  const on = useRef(false);
  const subs = useRef<Sub[]>([]);
  const text = useRef("");
  const ended = useRef<(() => void) | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAt = useRef(0);
  const lv = useRef(0);

  const cleanup = useCallback(() => {
    subs.current.forEach((s) => s.remove());
    subs.current = [];
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    on.current = false;
    lv.current = 0;
    setLevel(0);
    setSecs(0);
    setLevels(Array(BARS).fill(0));
  }, []);

  const start = useCallback(async () => {
    if (on.current) return;
    if (!has("speech")) throw new Error("此设备不支持语音识别");
    const { ExpoSpeechRecognitionModule: S } = await import("expo-speech-recognition");
    const perm = await S.requestPermissionsAsync();
    if (!perm.granted) throw new Error("没有麦克风或语音识别权限");
    text.current = "";
    on.current = true;
    startedAt.current = Date.now();
    subs.current = [
      S.addListener("result", (e: { results: { transcript: string }[] }) => {
        text.current = e.results[0]?.transcript ?? text.current;
      }),
      // value -2..10; speech sits around 0..8. Rise at once, fall a little smoothed.
      S.addListener("volumechange", (e: { value: number }) => {
        const x = Math.max(0, Math.min(1, (e.value + 1) / 9));
        lv.current = x >= lv.current ? x : lv.current * 0.55 + x * 0.45;
        setLevel(lv.current);
        setLevels((a) => [...a.slice(1), lv.current]);
      }),
      S.addListener("error", (e: { error?: string; message?: string }) => {
        if (e.error !== "no-speech" && e.error !== "aborted") log.warn("speech error", e);
        ended.current?.();
      }),
      S.addListener("end", () => ended.current?.()),
    ];
    timer.current = setInterval(() => setSecs(Math.floor((Date.now() - startedAt.current) / 1000)), 250);
    S.start({ lang: "zh-CN", interimResults: true, continuous: true, addsPunctuation: true, volumeChangeEventOptions: { enabled: true, intervalMillis: 60 } });
  }, []);

  /** Stop and return what was said ("" when nothing / shorter than 0.5 s). */
  const stop = useCallback(async (): Promise<string> => {
    if (!on.current) return "";
    const long = Date.now() - startedAt.current >= 500;
    const { ExpoSpeechRecognitionModule: S } = await import("expo-speech-recognition");
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 1500);
      ended.current = () => {
        clearTimeout(t);
        resolve();
      };
      S.stop();
    });
    ended.current = null;
    const out = long ? text.current.trim() : "";
    cleanup();
    return out;
  }, [cleanup]);

  const cancel = useCallback(() => {
    if (!on.current) return;
    void import("expo-speech-recognition").then(({ ExpoSpeechRecognitionModule: S }) => S.abort()).catch(() => {});
    cleanup();
  }, [cleanup]);

  useEffect(() => () => cancel(), [cancel]);
  return { level, levels, secs, start, stop, cancel };
}

async function toText(said: string, onText: (t: string) => void, onError: (m: string) => void) {
  if (said) onText(said);
  else onError("没有识别到语音");
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Tap to start, tap again to stop and send (the composer mic). cancel() drops the recording. */
export function useTapToTalk(opts: { onText: (text: string) => void; onError: (msg: string) => void }) {
  const rec = useRecorder();
  const [phase, setPhase] = useState<"idle" | "rec" | "busy">("idle");
  const o = useRef(opts);
  useEffect(() => {
    o.current = opts;
  });

  const toggle = async () => {
    if (phase === "busy") return;
    if (phase === "idle") {
      setPhase("rec");
      void haptic("medium");
      try {
        await rec.start();
      } catch (e) {
        log.warn("start failed", e);
        setPhase("idle");
        o.current.onError(errText(e));
      }
      return;
    }
    setPhase("busy");
    try {
      await toText(await rec.stop(), o.current.onText, o.current.onError);
    } catch (e) {
      o.current.onError(errText(e));
    } finally {
      setPhase("idle");
    }
  };

  const cancel = () => {
    if (phase === "rec") rec.cancel();
    if (phase !== "busy") setPhase("idle");
  };

  return { phase, levels: rec.levels, level: rec.level, secs: rec.secs, toggle, cancel };
}

const HOLD_MS = 260;
const CANCEL_PX = 70;
const NEW_PX = 70;

/** Tap vs press-and-hold on one view (responder props): a tap calls onTap; holding records until
 *  release, then transcribes and calls onText. Sliding up by CANCEL_PX arms "release to cancel";
 *  with `newChat`, sliding left by NEW_PX arms "release to send as a new conversation" (onText gets
 *  fresh = true). */
export function useHoldToTalk(opts: { onTap?: () => void; onText: (text: string, fresh?: boolean) => void; onError: (msg: string) => void; newChat?: boolean }) {
  const rec = useRecorder();
  const [phase, setPhase] = useState<"idle" | "arming" | "rec" | "busy">("idle");
  const [cancelZone, setCancelZone] = useState(false);
  const [newZone, setNewZone] = useState(false);
  const fresh = useRef(false);
  const startX = useRef(0);
  const ph = useRef<"idle" | "arming" | "rec" | "busy">("idle");
  const o = useRef(opts);
  useEffect(() => {
    o.current = opts;
  });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startY = useRef(0);
  const zone = useRef(false);

  const set = (p: typeof phase) => {
    ph.current = p;
    setPhase(p);
  };

  const handlers = {
    onStartShouldSetResponder: () => ph.current !== "busy",
    onResponderTerminationRequest: () => ph.current === "idle",
    onResponderGrant: (e: { nativeEvent: { pageX: number; pageY: number } }) => {
      startY.current = e.nativeEvent.pageY;
      startX.current = e.nativeEvent.pageX;
      zone.current = false;
      fresh.current = false;
      setCancelZone(false);
      setNewZone(false);
      set("arming");
      timer.current = setTimeout(async () => {
        timer.current = null;
        if (ph.current !== "arming") return;
        set("rec");
        void haptic("medium");
        try {
          await rec.start();
          if ((ph.current as string) !== "rec") rec.cancel(); // released while the mic was opening
        } catch (err) {
          set("idle");
          o.current.onError(errText(err));
        }
      }, HOLD_MS);
    },
    onResponderMove: (e: { nativeEvent: { pageX: number; pageY: number } }) => {
      if (ph.current !== "rec") return;
      const z = startY.current - e.nativeEvent.pageY > CANCEL_PX;
      const n = !z && !!o.current.newChat && startX.current - e.nativeEvent.pageX > NEW_PX;
      if (z !== zone.current) {
        zone.current = z;
        setCancelZone(z);
        void haptic("select");
      }
      if (n !== fresh.current) {
        fresh.current = n;
        setNewZone(n);
        void haptic("select");
      }
    },
    onResponderRelease: async () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
        set("idle");
        o.current.onTap?.();
        return;
      }
      if (ph.current !== "rec") return;
      if (zone.current) {
        rec.cancel();
        set("idle");
        zone.current = false;
        setCancelZone(false);
        return;
      }
      set("busy");
      const asNew = fresh.current;
      fresh.current = false;
      setNewZone(false);
      try {
        await toText(await rec.stop(), (t) => o.current.onText(t, asNew), o.current.onError);
      } catch (err) {
        o.current.onError(errText(err));
      } finally {
        set("idle");
      }
    },
    onResponderTerminate: () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      if (ph.current === "rec") rec.cancel();
      if (ph.current !== "busy") set("idle");
      zone.current = false;
      setCancelZone(false);
      fresh.current = false;
      setNewZone(false);
    },
  };

  return { phase, cancelZone, newZone, levels: rec.levels, level: rec.level, secs: rec.secs, handlers };
}
