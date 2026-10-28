import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View, type LayoutChangeEvent } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useLocalSearchParams, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { Easing, FadeIn, FadeOut, SlideInRight, SlideOutRight, useAnimatedStyle, useSharedValue, withSequence, withSpring, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AirPlayButton, PlayerView, device, nativeCaps, playerAvailable, type ExternalSub, type NativeCaps, type Phase, type PlayerHandle, type PlayerInfo, type PlayerTrack } from "../../modules/mediahub-player";
import { tap, toast, toastError } from "@/components/ui";
import { api, appVersion } from "@/lib/api";
import { connection, has, keepAwake, pickFile } from "@/lib/device";
import { embyApi, nextEpisode, posterOf, prefetchPlan, prewarmedBytes, report, seconds, takePlan, type Item, type PlaybackPlan } from "@/lib/emby";
import { PlayTimeline } from "@/lib/playStats";
import { collectLogs, logger } from "@/lib/log";
import { useQuery } from "@/lib/query";
import { getSettings, setSettings, useSettings } from "@/lib/settings";
import { track } from "@/lib/track";

const log = logger("player");
const ACCENT = "#E8B04B";
const SUB_LANGS = ["chi", "zho", "chs", "cht", "zh", "zh-Hans", "zh-Hant"];
// Dir-sub langs (backend tags) that count as Chinese, for a sub added after playback has started.
const DIR_ZH = ["chs", "cht", "sc", "tc", "jpsc", "jptc", "zh", "chi"];
// How long playback waits for the subtitle list beyond PlaybackInfo; later subs are added live.
const SUBS_WAIT_MS = 800;
// Runtime 4 startup tuning for remote files (115 via ge2o): 8 MB / 5 s probe instead of 50 MB / 60 s
// (MKVs with PGS or cover art used to read far into the file before the first frame), and
// progressive loopback segments so AVPlayer starts on the first fragment. Older binaries ignore it.
const STARTUP = { probeBytes: 8 * 1024 * 1024, analyzeMs: 5000, progressive: true };
const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
const EASE = Easing.out(Easing.cubic);
type Sheet = null | "audio" | "subs" | "speed" | "info";
interface DirSub { name: string; path: string; size?: number; match: number; lang: string; format: string }

function clock(s: number) {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

const LANG: Record<string, string> = { chi: "中文", zho: "中文", chs: "简体中文", cht: "繁体中文", sc: "简体中文", tc: "繁体中文", jpsc: "简日双语", jptc: "繁日双语", zh: "中文", jpn: "日语", ja: "日语", eng: "英语", en: "英语", kor: "韩语", ko: "韩语" };

function trackLabel(t: PlayerTrack) {
  const lang = LANG[t.language.toLowerCase()] ?? (t.language ? t.language.toUpperCase() : "");
  const ch = t.channels === 6 ? "5.1" : t.channels === 8 ? "7.1" : t.channels > 2 ? `${t.channels}ch` : "";
  const extra = [t.codec.toUpperCase(), t.isAtmos ? "Atmos" : ch, t.isForced ? "强制" : "", t.isExternal ? "外挂" : "", t.isDefault ? "默认" : ""].filter(Boolean).join(" · ");
  return { title: t.name || lang || `轨道 ${t.id}`, sub: [t.name && lang ? lang : "", extra].filter(Boolean).join(" · ") };
}

export default function PlayerScreen() {
  // Emby item (`id`), or a web stream source (`stream` provider + `ref`, resolved by the backend).
  const params = useLocalSearchParams<{ id?: string; resume?: string; at?: string; stream?: string; ref?: string; title?: string }>();
  const web = params.stream && params.ref ? { provider: params.stream, ref: params.ref } : null;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const subtitleScale = useSettings((s) => s.subtitleScale);
  const [itemId, setItemId] = useState(params.id);
  const [fromStart, setFromStart] = useState(params.resume === "0");
  const item = useQuery(itemId && !web ? `emby:item:${itemId}` : null, () => embyApi.item(itemId!), { staleMs: 5 * 60_000 });
  const [plan, setPlan] = useState<PlaybackPlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [extraSubs, setExtraSubs] = useState<ExternalSub[]>([]);
  const [dirSubs, setDirSubs] = useState<DirSub[] | null>(null);
  const [start, setStart] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [pos, setPos] = useState(0);
  const [dur, setDur] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [paused, setPaused] = useState(false);
  const [rate, setRate] = useState(1);
  const [boost, setBoost] = useState(false);
  const [tracks, setTracks] = useState<{ audio: PlayerTrack[]; subtitles: PlayerTrack[]; activeAudio: number; activeSubtitle: number }>({ audio: [], subtitles: [], activeAudio: -1, activeSubtitle: -1 });
  const [info, setInfo] = useState<PlayerInfo | null>(null);
  const [caps, setCaps] = useState<NativeCaps | null>(null);
  const [controls, setControls] = useState(true);
  const [locked, setLocked] = useState(false);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [scrub, setScrub] = useState<number | null>(null);
  const [gestureHud, setGestureHud] = useState<null | { kind: "brightness" | "volume"; value: number }>(null);
  const [ripple, setRipple] = useState<null | { side: "left" | "right"; n: number }>(null);
  const [pipActive, setPipActive] = useState(false);
  const [next, setNext] = useState<Item | null>(null);
  const [ended, setEnded] = useState(false);
  const [width, setWidth] = useState(800);
  const ref = useRef<PlayerHandle>(null);
  const posRef = useRef(0);
  const pausedRef = useRef(false);
  const started = useRef(false);
  const loadAt = useRef(0);
  const openedAt = useRef(0); // screen open time; play_start reports open→frame as well as plan→frame
  const tl = useRef<PlayTimeline | null>(null); // startup timeline of the current play (lib/playStats)
  const stalls = useRef(0);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panMode = useRef<null | "seek" | "brightness" | "volume">(null);
  const panStart = useRef({ pos: 0, level: 0 });
  const it = item.data;
  // Effects below key on the item id, not the object: the item is refetched when the app comes back
  // to the foreground (e.g. returning from PiP) and a new object must not reload the stream.
  const itRef = useRef(it);
  useEffect(() => {
    itRef.current = it;
  });
  const loadedId = it?.Id;
  useEffect(() => {
    if (loadedId) tl.current?.mark("item");
  }, [loadedId]);
  const artwork = it ? posterOf(it, 600)?.uri : undefined;
  const title = it ? (it.Type === "Episode" ? it.SeriesName ?? it.Name : it.Name) : params.title ?? "";
  const subtitle = it?.Type === "Episode" ? `S${it.ParentIndexNumber ?? "?"}E${it.IndexNumber ?? "?"} · ${it.Name}` : it?.ProductionYear ? String(it.ProductionYear) : "";

  // ---- chrome animation: gradients and bars fade and slide together ----
  const chrome = useSharedValue(1);
  const showChrome = controls || !!error || !!planError || ended;
  useEffect(() => {
    chrome.set(withTiming(showChrome ? 1 : 0, { duration: 260, easing: EASE }));
  }, [showChrome, chrome]);
  const fadeStyle = useAnimatedStyle(() => ({ opacity: chrome.value }));
  const topStyle = useAnimatedStyle(() => ({ transform: [{ translateY: (1 - chrome.value) * -18 }] }));
  const bottomStyle = useAnimatedStyle(() => ({ transform: [{ translateY: (1 - chrome.value) * 18 }] }));
  const centerStyle = useAnimatedStyle(() => ({ transform: [{ scale: 0.92 + chrome.value * 0.08 }] }));
  const playScale = useSharedValue(1);
  const playStyle = useAnimatedStyle(() => ({ transform: [{ scale: playScale.value }] }));

  useEffect(() => {
    openedAt.current = Date.now();
    tl.current = new PlayTimeline({ kind: web ? "web" : "emby", stream: params.stream ?? "" });
    void connection().then((n) => tl.current?.set({ net: n ? (n.cellular ? "cellular" : n.type) : "?" }));
    const sub = device.onEngineLog((e) => tl.current?.engine(e.line));
    void nativeCaps().then(setCaps);
    track("player_open");
    return () => sub?.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the screen on while playing.
  useEffect(() => {
    void keepAwake("player", !paused && !ended);
    return () => void keepAwake("player", false);
  }, [paused, ended]);

  // PlaybackInfo needs only the id, so it runs alongside the Items fetch (taken below by takePlan).
  useEffect(() => {
    if (itemId && !web) prefetchPlan(itemId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId]);

  // A matching dir subtitle that arrived after playback started: add it once playing, unless a
  // subtitle is already on (addSubtitle selects the track it adds).
  const [lateSub, setLateSub] = useState<ExternalSub | null>(null);
  const lateDone = useRef<ExternalSub | null>(null);
  useEffect(() => {
    if (!lateSub || lateDone.current === lateSub || phase !== "playing") return;
    lateDone.current = lateSub;
    if (tracks.activeSubtitle >= 0) return;
    void ref.current?.addSubtitle?.(lateSub).then((id) => log.info("late sub", { id }));
  }, [lateSub, phase, tracks.activeSubtitle]);

  // Resolve the stream (and the subtitle files next to it) once the item is known. The subtitle list
  // (backend → plugin → OpenList, 0.4–2.5 s) starts in parallel with PlaybackInfo and only holds
  // playback back for SUBS_WAIT_MS.
  useEffect(() => {
    const it = itRef.current;
    if (!loadedId || !it) return;
    let cancelled = false;
    const at = params.at ? Number(params.at) : null;
    const from = at ?? (fromStart ? 0 : seconds(it.UserData?.PlaybackPositionTicks));
    const t0 = Date.now();
    const listSubs = async (sourcePath: string): Promise<DirSub[]> => {
      if (!sourcePath) return [];
      try {
        const r = await api<{ subs?: DirSub[] }>(`/v1/subs/list?url=${encodeURIComponent(sourcePath)}`, { timeoutMs: 8000 });
        return r.subs ?? [];
      } catch (e) {
        log.warn("dir subs failed", { err: e instanceof Error ? e.message : e });
        return [];
      }
    };
    const autoOf = (found: DirSub[]) => {
      const { server, token } = getSettings();
      return found.filter((s) => s.match > 0 && s.format !== "sup" && s.format !== "idx").slice(0, 4).map((s) => ({
        uri: `${server}/v1/subs/file?path=${encodeURIComponent(s.path)}`, name: s.name, language: s.lang, headers: { authorization: `Bearer ${token}` },
      }));
    };
    (async () => {
      try {
        const early = it.MediaSources?.[0]?.Path ?? "";
        let subs: Promise<DirSub[]> | null = early ? listSubs(early) : null;
        const p = await takePlan(it.Id, from);
        const ms = Date.now() - t0;
        tl.current?.mark("info");
        tl.current?.set({ type: it.Type ?? "", resume: from > 1, prewarm: prewarmedBytes(it.Id) });
        subs ??= listSubs(p.sourcePath);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const inTime = await Promise.race([subs, new Promise<null>((r) => (timer = setTimeout(() => r(null), SUBS_WAIT_MS)))]);
        clearTimeout(timer);
        if (cancelled) return;
        if (inTime) tl.current?.mark("subs");
        else tl.current?.set({ subsLate: true });
        const found = inTime ?? [];
        const auto = autoOf(found);
        log.info("plan", { item: it.Id, type: it.Type, start: Math.round(from), embySubs: p.externalSubtitles.length, dirSubs: inTime ? found.length : "late", autoSubs: auto.length, infoMs: ms, ms: Date.now() - t0 });
        if (!inTime) {
          void subs.then((late) => {
            if (cancelled) return;
            const auto = autoOf(late);
            log.info("dir subs late", { dirSubs: late.length, autoSubs: auto.length, ms: Date.now() - t0 });
            setDirSubs(late);
            const zh = auto.find((s) => DIR_ZH.includes(s.language));
            if (zh) setLateSub(zh);
          });
        }
        loadAt.current = Date.now();
        started.current = false;
        stalls.current = 0;
        posRef.current = from;
        setDirSubs(inTime ? found : null);
        setLateSub(null);
        setExtraSubs(auto);
        setStart(from);
        tl.current?.mark("plan");
        setPlan(p);
      } catch (e) {
        if (cancelled) return;
        tl.current?.failed(e instanceof Error ? e.message : String(e));
        log.error("plan failed", { item: it.Id, err: e instanceof Error ? e.message : e });
        track("play_plan", { ok: false, err: e instanceof Error ? e.message : String(e) });
        setPlanError(e instanceof Error ? e.message : String(e));
      }
    })();
    if (it.Type === "Episode") void nextEpisode(it).then((n) => !cancelled && setNext(n)).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [loadedId, fromStart, attempt, params.at]);

  // Web sources: links expire, so they are resolved here, right before playing.
  useEffect(() => {
    if (!web) return;
    let cancelled = false;
    const t0 = Date.now();
    (async () => {
      try {
        const r = await api<{ uri: string; headers?: Record<string, string> }>(`/v1/stream/${web.provider}/resolve?ref=${encodeURIComponent(web.ref)}`, { timeoutMs: 45_000 });
        if (cancelled) return;
        log.info("plan", { stream: web.provider, ms: Date.now() - t0 });
        loadAt.current = Date.now();
        started.current = false;
        stalls.current = 0;
        setStart(0);
        tl.current?.mark("plan");
        setPlan({ uri: r.uri, headers: r.headers ?? {}, mediaSourceId: "", playSessionId: "", externalSubtitles: [], sourcePath: "" });
      } catch (e) {
        if (cancelled) return;
        log.error("plan failed", { stream: web.provider, err: e instanceof Error ? e.message : e });
        track("play_plan", { ok: false, stream: web.provider, err: e instanceof Error ? e.message : String(e) });
        setPlanError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.stream, params.ref, attempt]);

  // Progress reports to Emby every 10 s, and a stop report when leaving.
  useEffect(() => {
    if (!plan || !loadedId) return;
    const id = loadedId;
    const t = setInterval(() => {
      if (started.current) void report("progress", { itemId: id, plan, position: posRef.current, paused: pausedRef.current });
    }, 10_000);
    return () => {
      clearInterval(t);
      if (started.current) {
        void report("stopped", { itemId: id, plan, position: posRef.current });
        track("play_stop", { pos: Math.round(posRef.current), stalls: stalls.current });
      }
    };
  }, [plan, loadedId]);

  const kick = useCallback(() => {
    setControls(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (!pausedRef.current) setControls(false);
    }, 4000);
  }, []);

  useEffect(() => {
    hideTimer.current = setTimeout(() => setControls(false), 4000);
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, []);

  const togglePause = () => {
    const v = !paused;
    pausedRef.current = v;
    setPaused(v);
    // Press bounce: dip, then spring back (withSequence keeps it one animation).
    playScale.set(withSequence(withSpring(0.86, { damping: 12, stiffness: 400 }), withSpring(1, { damping: 10, stiffness: 260 })));
    kick();
    if (plan && it) void report("progress", { itemId: it.Id, plan, position: posRef.current, paused: v });
  };

  const seekTo = (s: number) => {
    const target = Math.max(0, Math.min(dur || s, s));
    posRef.current = target;
    setPos(target);
    setEnded(false);
    void ref.current?.seek(target);
  };

  const skip = (delta: number) => {
    seekTo(pos + delta);
    setRipple((r) => ({ side: delta > 0 ? "right" : "left", n: (r?.n ?? 0) + 1 }));
    kick();
  };

  const playNext = () => {
    if (!next) return;
    track("play_next");
    tl.current = new PlayTimeline({ kind: "emby", next: true });
    setPlan(null);
    setNext(null);
    setEnded(false);
    setError(null);
    setPlanError(null);
    setFromStart(true);
    setItemId(next.Id);
  };

  const retry = () => {
    track("play_retry");
    tl.current = new PlayTimeline({ kind: web ? "web" : "emby", retry: true });
    setError(null);
    setPlanError(null);
    setPlan(null);
    setAttempt((a) => a + 1);
  };

  const uploadLog = async () => {
    try {
      const text = await collectLogs();
      const r = await api<{ id: string }>("/v1/logs", { body: { log: text, meta: { version: appVersion, item: itemId, error: error ?? planError, info } }, timeoutMs: 60_000 });
      toast("日志已上传", `编号 ${r.id}`);
    } catch (e) {
      toastError("未能上传日志", e);
    }
  };

  const close = () => {
    tap();
    // With an open small window the video keeps playing after the screen closes.
    if (!pipActive) void ref.current?.stop();
    router.back();
  };

  const togglePiP = () => {
    track("pip_tap", { active: pipActive });
    void ref.current?.togglePiP?.();
  };

  const addDirSub = async (s: DirSub) => {
    const { server, token } = getSettings();
    const id = await ref.current?.addSubtitle?.({ uri: `${server}/v1/subs/file?path=${encodeURIComponent(s.path)}`, name: s.name, language: s.lang, headers: { authorization: `Bearer ${token}` } });
    track("play_sub_dir", { ok: (id ?? -1) >= 0, fmt: s.format });
    setSheet(null);
    if (id !== undefined && id < 0) toast("未能加载这个字幕文件", undefined, undefined, true);
  };

  const importSub = async () => {
    const f = await pickFile(["public.text", "public.data", "*/*"]);
    if (!f) return;
    const id = await ref.current?.addSubtitle?.({ uri: f.uri, name: f.name });
    track("play_sub_import", { ok: (id ?? -1) >= 0 });
    setSheet(null);
    if (id !== undefined && id >= 0) toast("已加载字幕", f.name);
  };

  // ---- gestures (callbacks run on taps / drags, not during render) ----
  /* eslint-disable react-hooks/refs */
  const singleTap = Gesture.Tap().runOnJS(true).maxDuration(250).onEnd(() => {
    if (locked || !controls) kick();
    else setControls(false);
  });
  const doubleTap = Gesture.Tap().numberOfTaps(2).runOnJS(true).onEnd((e) => {
    if (!locked) skip(e.x > width / 2 ? 10 : -10);
  });
  const longPress = Gesture.LongPress().minDuration(450).runOnJS(true)
    .onStart(() => {
      if (locked || paused) return;
      tap();
      setBoost(true);
      track("play_boost");
    })
    .onFinalize(() => setBoost(false));
  const pan = Gesture.Pan().runOnJS(true).minDistance(12)
    .onStart((e) => {
      if (locked) return;
      const horizontal = Math.abs(e.translationX) > Math.abs(e.translationY);
      const mode = horizontal ? "seek" : e.x < width / 2 ? "brightness" : "volume";
      panMode.current = mode;
      panStart.current = { pos, level: 0.5 };
      if (mode !== "seek") {
        void (mode === "brightness" ? device.getBrightness() : device.getVolume()).then((l) => {
          if (l !== null && l !== undefined) panStart.current = { pos, level: l };
        });
      }
    })
    .onUpdate((e) => {
      const mode = panMode.current;
      if (locked || !mode) return;
      if (mode === "seek") {
        const span = Math.max(120, Math.min(dur, 600));
        setScrub(Math.max(0, Math.min(dur, panStart.current.pos + (e.translationX / width) * span)));
        setControls(true);
      } else {
        const v = Math.max(0, Math.min(1, panStart.current.level - e.translationY / 300));
        setGestureHud({ kind: mode, value: v });
        void (mode === "brightness" ? device.setBrightness(v) : device.setVolume(v));
      }
    })
    .onEnd(() => {
      if (panMode.current === "seek" && scrub !== null) {
        track("play_pan_seek");
        seekTo(scrub);
        kick();
      }
      setScrub(null);
      setGestureHud(null);
      panMode.current = null;
    });
  const surfaceGesture = Gesture.Race(pan, longPress, Gesture.Exclusive(doubleTap, singleTap));
  /* eslint-enable react-hooks/refs */

  const nowPlaying = useMemo(() => (title ? { title, subtitle, artwork } : null), [title, subtitle, artwork]);
  const busy = !error && !planError && (!plan || phase === "loading" || phase === "buffering" || phase === "seeking" || phase === "stalled");
  const shownPos = scrub ?? pos;
  const curAudio = tracks.audio.find((t) => t.id === tracks.activeAudio);
  const curSub = tracks.subtitles.find((t) => t.id === tracks.activeSubtitle);
  const loadedNames = new Set(tracks.subtitles.map((t) => t.name));

  if (!playerAvailable) {
    return (
      <View style={{ flex: 1, backgroundColor: "#000", alignItems: "center", justifyContent: "center", padding: 32 }}>
        <Text style={{ color: "#fff", fontSize: 16, textAlign: "center" }}>当前安装的版本没有内置播放器，请在全能签里更新影库。</Text>
        <Pressable onPress={close} style={{ marginTop: 20 }}><Text style={{ color: ACCENT, fontWeight: "700" }}>返回</Text></Pressable>
      </View>
    );
  }

  const L = Math.max(insets.left, 20);
  const R = Math.max(insets.right, 20);

  return (
    <View style={{ flex: 1, backgroundColor: "#000" }} onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}>
      <StatusBar hidden />
      <GestureDetector gesture={surfaceGesture}>
        <View style={{ flex: 1 }}>
          <PlayerView
            ref={ref}
            style={{ flex: 1 }}
            source={plan ? { uri: plan.uri, headers: plan.headers, startPosition: start, externalSubtitles: [...plan.externalSubtitles, ...extraSubs], subtitleLanguages: SUB_LANGS, ...STARTUP } : null}
            paused={paused}
            rate={boost ? 2 : rate}
            subtitleScale={subtitleScale}
            autoPiP
            itemId={web ? undefined : itemId}
            nowPlaying={nowPlaying}
            onPhase={(e) => {
              const p = e.nativeEvent.phase;
              setPhase(p);
              if (p === "playing") tl.current?.playing();
              else if (p === "seeking") tl.current?.seeking();
              log.info("phase", { phase: p, msg: e.nativeEvent.message, reconnecting: e.nativeEvent.reconnecting });
              if (p === "playing" && !started.current && plan && it) {
                started.current = true;
                void report("start", { itemId: it.Id, plan, position: posRef.current });
                track("play_start", { type: it.Type, ms: Date.now() - loadAt.current, fromOpen: Date.now() - openedAt.current, resume: posRef.current > 1 });
              } else if (p === "playing" && !started.current && plan && web) {
                started.current = true;
                track("play_start", { type: "web", stream: web.provider, ms: Date.now() - loadAt.current, fromOpen: Date.now() - openedAt.current });
              }
              if (p === "stalled" || p === "buffering") stalls.current += 1;
            }}
            onStartup={(e) => {
              const { step, ms } = e.nativeEvent;
              tl.current?.native(step, ms);
              log.info("startup", { step, ms });
              if (step === "streamsProbed" || step === "ready" || step === "presenting") track("play_startup", { step, ms, type: it?.Type ?? "web" });
            }}
            onProgress={(e) => {
              posRef.current = e.nativeEvent.position;
              setPos(e.nativeEvent.position);
              setDur(e.nativeEvent.duration);
              setBuffered(e.nativeEvent.buffered);
            }}
            onTracks={(e) => {
              setTracks(e.nativeEvent);
              log.info("tracks", { audio: e.nativeEvent.audio.length, subs: e.nativeEvent.subtitles.length, a: e.nativeEvent.activeAudio, s: e.nativeEvent.activeSubtitle });
            }}
            onInfo={(e) => {
              tl.current?.set({ container: e.nativeEvent.container, codec: e.nativeEvent.codec, route: e.nativeEvent.route ?? "", vdec: e.nativeEvent.videoDecoder });
              setInfo(e.nativeEvent);
              log.info("info", e.nativeEvent);
              if (e.nativeEvent.codec) track("play_info", { format: e.nativeEvent.videoFormat, vdec: e.nativeEvent.videoDecoder, adec: e.nativeEvent.audioDecoder, codec: e.nativeEvent.codec, container: e.nativeEvent.container, route: e.nativeEvent.route });
            }}
            onPiP={(e) => {
              setPipActive(e.nativeEvent.active);
              log.info("pip", e.nativeEvent);
              if (e.nativeEvent.error) toast("未能开启小窗", e.nativeEvent.error, undefined, true);
            }}
            onEnded={() => {
              log.info("ended", { item: itemId });
              track("play_end", { next: !!next });
              setEnded(true);
              setControls(true);
              if (plan && it) void report("stopped", { itemId: it.Id, plan, position: dur });
              started.current = false;
            }}
            onError={(e) => {
              tl.current?.failed(e.nativeEvent.message);
              log.error("playback error", { item: itemId, msg: e.nativeEvent.message, info });
              track("play_error", { msg: e.nativeEvent.message, codec: info?.codec, container: info?.container });
              setError(e.nativeEvent.message);
              setControls(true);
            }}
          />
          {pipActive ? (
            <Animated.View entering={FadeIn.duration(220)} exiting={FadeOut.duration(220)} pointerEvents="box-none" style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center", gap: 12, backgroundColor: "#000" }}>
              <Ionicons name="browsers-outline" size={44} color="rgba(255,255,255,0.55)" />
              <Text style={{ color: "#ddd", fontSize: 15 }}>正在小窗播放</Text>
              <Pressable onPress={() => { tap(); togglePiP(); }} style={{ marginTop: 4, paddingHorizontal: 18, height: 36, borderRadius: 18, backgroundColor: "rgba(255,255,255,0.14)", justifyContent: "center" }}>
                <Text style={{ color: "#fff", fontWeight: "700" }}>在这里播放</Text>
              </Pressable>
            </Animated.View>
          ) : null}
          {/* With the controls up the spinner lives in the play button; otherwise a small one in the middle. */}
          {busy && !showChrome ? (
            <Animated.View entering={FadeIn.duration(200)} exiting={FadeOut.duration(200)} pointerEvents="none" style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center" }}>
              <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: "rgba(0,0,0,0.35)", alignItems: "center", justifyContent: "center" }}>
                <ActivityIndicator color="#fff" />
              </View>
            </Animated.View>
          ) : null}
          {phase === "stalled" ? (
            <Animated.View entering={FadeIn.duration(200)} exiting={FadeOut.duration(200)} pointerEvents="none" style={{ position: "absolute", top: "62%", alignSelf: "center", backgroundColor: "rgba(0,0,0,0.55)", paddingHorizontal: 14, height: 30, borderRadius: 15, justifyContent: "center" }}>
              <Text style={{ color: "#eee", fontSize: 13 }}>网络中断，正在重连</Text>
            </Animated.View>
          ) : null}
          {ripple ? <Ripple key={ripple.n} side={ripple.side} onDone={() => setRipple(null)} /> : null}
          {boost ? (
            <Animated.View entering={FadeIn.duration(160)} exiting={FadeOut.duration(200)} pointerEvents="none" style={{ position: "absolute", top: Math.max(insets.top, 18) + 44, alignSelf: "center", flexDirection: "row", gap: 6, alignItems: "center", backgroundColor: "rgba(0,0,0,0.55)", paddingHorizontal: 14, height: 32, borderRadius: 16 }}>
              <Ionicons name="play-forward" size={14} color="#fff" />
              <Text style={{ color: "#fff", fontWeight: "700" }}>2 倍速播放中</Text>
            </Animated.View>
          ) : null}
          {gestureHud ? (
            <Animated.View entering={FadeIn.duration(140)} exiting={FadeOut.duration(220)} pointerEvents="none" style={{ position: "absolute", top: "40%", alignSelf: "center", flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: "rgba(0,0,0,0.6)", paddingHorizontal: 16, height: 44, borderRadius: 22 }}>
              <Ionicons name={gestureHud.kind === "brightness" ? "sunny" : gestureHud.value < 0.01 ? "volume-mute" : "volume-high"} size={18} color="#fff" />
              <View style={{ width: 140, height: 4, borderRadius: 2, backgroundColor: "rgba(255,255,255,0.25)" }}>
                <View style={{ width: `${gestureHud.value * 100}%`, height: 4, borderRadius: 2, backgroundColor: "#fff" }} />
              </View>
            </Animated.View>
          ) : null}
          {scrub !== null ? (
            <Animated.View entering={FadeIn.duration(120)} exiting={FadeOut.duration(180)} pointerEvents="none" style={{ position: "absolute", top: "38%", alignSelf: "center", alignItems: "center", backgroundColor: "rgba(0,0,0,0.6)", paddingHorizontal: 22, paddingVertical: 10, borderRadius: 16 }}>
              <Text style={{ color: "#fff", fontSize: 26, fontWeight: "800", fontVariant: ["tabular-nums"] }}>{clock(scrub)}</Text>
              <Text style={{ color: "#ccc", fontSize: 13, marginTop: 2 }}>{scrub >= pos ? "+" : "-"}{clock(Math.abs(scrub - pos))} / {clock(dur)}</Text>
            </Animated.View>
          ) : null}
        </View>
      </GestureDetector>

      <Animated.View pointerEvents={showChrome ? "box-none" : "none"} style={[{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }, fadeStyle]}>
        <LinearGradient pointerEvents="none" colors={["rgba(0,0,0,0.75)", "rgba(0,0,0,0.35)", "rgba(0,0,0,0)"]} style={{ position: "absolute", top: 0, left: 0, right: 0, height: 140 }} />
        <LinearGradient pointerEvents="none" colors={["rgba(0,0,0,0)", "rgba(0,0,0,0.45)", "rgba(0,0,0,0.85)"]} style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 170 }} />

        {locked ? (
          <Animated.View style={[{ position: "absolute", left: L, top: "45%" }, centerStyle]}>
            <Round name="lock-closed" label="解锁" onPress={() => { setLocked(false); kick(); track("player_lock", { on: false }); }} />
          </Animated.View>
        ) : (
          <>
            <Animated.View style={[{ position: "absolute", top: Math.max(insets.top, 14), left: L, right: R, flexDirection: "row", alignItems: "center", gap: 18 }, topStyle]}>
              <Btn name="chevron-down" onPress={close} label="关闭" size={26} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: "#fff", fontSize: 17, fontWeight: "700" }} numberOfLines={1}>{title}</Text>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 }}>
                  <Text style={{ color: "#ccc", fontSize: 12, flexShrink: 1 }} numberOfLines={1}>{subtitle}</Text>
                  {info?.videoFormat && info.videoFormat !== "SDR" ? <Badge text={info.videoFormat} /> : null}
                  {curAudio?.isAtmos ? <Badge text="Atmos" /> : null}
                </View>
              </View>
              {has("airplay") ? <AirPlayButton tint="#ffffff" style={{ width: 28, height: 28 }} /> : null}
              {caps?.pip ? <Btn name={pipActive ? "contract-outline" : "browsers-outline"} label="小窗" onPress={togglePiP} /> : null}
              <Btn name="information-circle-outline" label="信息" onPress={() => { kick(); setSheet("info"); }} />
            </Animated.View>

            {!error && !planError && !ended && !pipActive ? (
              <Animated.View pointerEvents="box-none" style={[{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 64 }, centerStyle]}>
                <Btn name="play-back" size={30} label="后退 10 秒" onPress={() => skip(-10)} />
                <Animated.View style={playStyle}>
                  <Pressable accessibilityLabel={paused ? "播放" : "暂停"} onPress={() => { tap(); togglePause(); }} style={{ width: 76, height: 76, borderRadius: 38, backgroundColor: "rgba(0,0,0,0.4)", borderWidth: 1, borderColor: "rgba(255,255,255,0.18)", alignItems: "center", justifyContent: "center" }}>
                    {busy && !paused ? (
                      <Animated.View key="busy" entering={FadeIn.duration(160)} exiting={FadeOut.duration(160)}>
                        <ActivityIndicator color="#fff" size="large" />
                      </Animated.View>
                    ) : (
                      <Animated.View key={paused ? "play" : "pause"} entering={FadeIn.duration(160)} exiting={FadeOut.duration(120)}>
                        <Ionicons name={paused ? "play" : "pause"} size={38} color="#fff" style={{ marginLeft: paused ? 4 : 0 }} />
                      </Animated.View>
                    )}
                  </Pressable>
                </Animated.View>
                <Btn name="play-forward" size={30} label="前进 10 秒" onPress={() => skip(10)} />
              </Animated.View>
            ) : null}

            <Animated.View style={[{ position: "absolute", left: L, top: "45%" }, centerStyle]}>
              <Round name="lock-open-outline" label="锁定" onPress={() => { setLocked(true); setControls(false); track("player_lock", { on: true }); }} />
            </Animated.View>

            <Animated.View style={[{ position: "absolute", bottom: Math.max(insets.bottom, 10), left: L, right: R }, bottomStyle]}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
                <Text style={{ color: "#fff", fontSize: 12, fontVariant: ["tabular-nums"], minWidth: 48 }}>{clock(shownPos)}</Text>
                <SeekBar value={shownPos} duration={dur} buffered={buffered} onScrub={(v) => { kick(); setScrub(v); }} onSeek={(v) => { setScrub(null); seekTo(v); kick(); }} />
                <Text style={{ color: "#fff", fontSize: 12, fontVariant: ["tabular-nums"], minWidth: 48, textAlign: "right" }}>-{clock(Math.max(0, dur - shownPos))}</Text>
              </View>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginTop: 6 }}>
                <Pill icon="musical-notes-outline" text={curAudio ? trackLabel(curAudio).title : "音轨"} onPress={() => { kick(); setSheet("audio"); }} />
                <Pill icon="chatbox-ellipses-outline" text={curSub ? trackLabel(curSub).title : "字幕关"} onPress={() => { kick(); setSheet("subs"); }} />
                <Pill icon="speedometer-outline" text={rate === 1 ? "倍速" : `${rate}x`} onPress={() => { kick(); setSheet("speed"); }} />
                <View style={{ flex: 1 }} />
                {next ? <Pill icon="play-skip-forward" text="下一集" onPress={playNext} /> : null}
              </View>
            </Animated.View>
          </>
        )}

        {error || planError ? (
          <Animated.View entering={FadeIn.duration(220)} style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0, alignItems: "center", justifyContent: "center", padding: 40 }} pointerEvents="box-none">
            <View style={{ backgroundColor: "rgba(20,20,20,0.92)", borderRadius: 18, padding: 22, maxWidth: 520, alignItems: "center", gap: 10 }}>
              <Ionicons name="alert-circle" size={30} color="#F0786E" />
              <Text style={{ color: "#fff", fontSize: 16, fontWeight: "700" }}>未能播放</Text>
              <Text style={{ color: "#ccc", fontSize: 13, textAlign: "center" }} numberOfLines={5}>{error ?? planError}</Text>
              <View style={{ flexDirection: "row", gap: 22, marginTop: 6 }}>
                <Link text="重试" onPress={retry} />
                <Link text="上传日志" onPress={() => void uploadLog()} />
                <Link text="返回" onPress={close} />
              </View>
            </View>
          </Animated.View>
        ) : ended ? (
          <Animated.View entering={FadeIn.duration(240)} style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0, alignItems: "center", justifyContent: "center", gap: 16 }} pointerEvents="box-none">
            {next ? (
              <Pressable onPress={() => { tap(); playNext(); }} style={{ flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: ACCENT, paddingHorizontal: 22, height: 48, borderRadius: 24 }}>
                <Ionicons name="play-skip-forward" size={18} color="#1A1306" />
                <Text style={{ color: "#1A1306", fontWeight: "800", fontSize: 15 }}>下一集 S{next.ParentIndexNumber}E{next.IndexNumber}</Text>
              </Pressable>
            ) : null}
            <View style={{ flexDirection: "row", gap: 22 }}>
              <Link text="重新播放" onPress={() => seekTo(0)} />
              <Link text="返回" onPress={close} />
            </View>
          </Animated.View>
        ) : null}
      </Animated.View>

      {sheet ? (
        <>
          <Animated.View entering={FadeIn.duration(200)} exiting={FadeOut.duration(200)} style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0, backgroundColor: "rgba(0,0,0,0.35)" }}>
            <Pressable style={{ flex: 1 }} onPress={() => setSheet(null)} />
          </Animated.View>
          <Animated.View entering={SlideInRight.duration(280).easing(EASE)} exiting={SlideOutRight.duration(220)} style={{ position: "absolute", top: 0, bottom: 0, right: 0, width: 360, backgroundColor: "rgba(16,16,20,0.97)", paddingTop: Math.max(insets.top, 16), paddingRight: Math.max(insets.right, 14), paddingLeft: 16, borderLeftWidth: 1, borderColor: "rgba(255,255,255,0.08)" }}>
            <ScrollView contentContainerStyle={{ paddingBottom: 30 }} showsVerticalScrollIndicator={false}>
              {sheet === "audio" ? (
                <>
                  <Heading text="音轨" />
                  {tracks.audio.map((t) => (
                    <Choice key={t.id} {...trackLabel(t)} active={t.id === tracks.activeAudio} onPress={() => { void ref.current?.selectAudio(t.id); track("play_audio_track", { codec: t.codec }); setSheet(null); }} />
                  ))}
                  {!tracks.audio.length ? <Text style={{ color: "#999" }}>正在读取音轨</Text> : null}
                </>
              ) : sheet === "subs" ? (
                <>
                  <Heading text="字幕" />
                  <Choice title="关闭字幕" active={tracks.activeSubtitle < 0} onPress={() => { void ref.current?.selectSubtitle(-1); setSheet(null); }} />
                  {tracks.subtitles.map((t) => (
                    <Choice key={t.id} {...trackLabel(t)} active={t.id === tracks.activeSubtitle} onPress={() => { void ref.current?.selectSubtitle(t.id); track("play_sub_track", { codec: t.codec, ext: t.isExternal }); setSheet(null); }} />
                  ))}
                  {dirSubs?.length ? (
                    <>
                      <Heading text="同目录字幕文件" />
                      {dirSubs.filter((s) => !loadedNames.has(s.name)).map((s) => (
                        <Choice key={s.path} title={s.name} sub={[LANG[s.lang] ?? s.lang, s.format.toUpperCase(), s.match === 2 ? "同名" : s.match === 1 ? "同集" : ""].filter(Boolean).join(" · ")} onPress={() => void addDirSub(s)} />
                      ))}
                    </>
                  ) : null}
                  {has("documentPicker") && caps && caps.module >= 3 ? <Choice title="从「文件」导入字幕…" sub="ASS / SRT / VTT / SUP" onPress={() => void importSub()} /> : null}
                  <Heading text="字幕大小" />
                  <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                    {[0.8, 1, 1.2, 1.4].map((s) => <Chip key={s} text={`${Math.round(s * 100)}%`} active={subtitleScale === s} onPress={() => setSettings({ subtitleScale: s })} />)}
                  </View>
                </>
              ) : sheet === "speed" ? (
                <>
                  <Heading text="倍速" />
                  {RATES.map((r) => <Choice key={r} title={`${r}x`} active={rate === r} onPress={() => { setRate(r); track("play_rate", { rate: r }); setSheet(null); }} />)}
                  <Text style={{ color: "#888", fontSize: 12, marginTop: 10 }}>长按画面可临时 2 倍速播放。</Text>
                </>
              ) : (
                <>
                  <Heading text="播放信息" />
                  {[
                    ["画面", info?.videoFormat],
                    ["视频解码", info?.videoDecoder],
                    ["音频", info?.audioDecoder],
                    ["编码", info?.codec?.toUpperCase()],
                    ["封装", info?.container],
                    ["管线", info?.route],
                    ["屏幕", caps && caps.module >= 3 ? [caps.dolbyVision ? "Dolby Vision" : "", caps.hdr10 ? "HDR10" : "", caps.hlg ? "HLG" : ""].filter(Boolean).join(" / ") || "SDR" : ""],
                    ["状态", phase],
                    ["缓冲到", clock(buffered)],
                    ["引擎", caps?.engine ? `AetherEngine ${caps.engine}` : ""],
                  ].map(([k, v]) => (
                    <View key={k} style={{ flexDirection: "row", paddingVertical: 7 }}>
                      <Text style={{ color: "#999", width: 80 }}>{k}</Text>
                      <Text style={{ color: "#eee", flex: 1 }}>{v || "—"}</Text>
                    </View>
                  ))}
                  <Pressable onPress={() => void uploadLog()} style={{ marginTop: 14 }}><Text style={{ color: ACCENT, fontWeight: "700" }}>上传日志</Text></Pressable>
                </>
              )}
            </ScrollView>
          </Animated.View>
        </>
      ) : null}
    </View>
  );
}

function Ripple({ side, onDone }: { side: "left" | "right"; onDone: () => void }) {
  const v = useSharedValue(0);
  useEffect(() => {
    v.set(withTiming(1, { duration: 650, easing: EASE }));
    const t = setTimeout(onDone, 680);
    return () => clearTimeout(t);
  }, [v, onDone]);
  const style = useAnimatedStyle(() => ({ opacity: 1 - v.value, transform: [{ scale: 0.6 + v.value * 0.6 }] }));
  return (
    <Animated.View pointerEvents="none" style={[{ position: "absolute", top: "36%", width: 120, height: 120, borderRadius: 60, backgroundColor: "rgba(255,255,255,0.16)", alignItems: "center", justifyContent: "center" }, side === "left" ? { left: "14%" } : { right: "14%" }, style]}>
      <Ionicons name={side === "left" ? "play-back" : "play-forward"} size={26} color="#fff" />
      <Text style={{ color: "#fff", fontWeight: "800", marginTop: 4 }}>{side === "left" ? "-10 秒" : "+10 秒"}</Text>
    </Animated.View>
  );
}

function Btn({ name, onPress, label, size = 24 }: { name: keyof typeof Ionicons.glyphMap; onPress: () => void; label: string; size?: number }) {
  return (
    <Pressable hitSlop={12} accessibilityLabel={label} onPress={() => { tap(); onPress(); }} style={({ pressed }) => ({ opacity: pressed ? 0.55 : 1, transform: [{ scale: pressed ? 0.92 : 1 }] })}>
      <Ionicons name={name} size={size} color="#fff" />
    </Pressable>
  );
}

function Round({ name, onPress, label }: { name: keyof typeof Ionicons.glyphMap; onPress: () => void; label: string }) {
  return (
    <Pressable hitSlop={10} accessibilityLabel={label} onPress={() => { tap(); onPress(); }} style={({ pressed }) => ({ width: 42, height: 42, borderRadius: 21, backgroundColor: "rgba(0,0,0,0.45)", alignItems: "center", justifyContent: "center", opacity: pressed ? 0.7 : 1 })}>
      <Ionicons name={name} size={19} color="#fff" />
    </Pressable>
  );
}

function Pill({ icon, text, onPress }: { icon: keyof typeof Ionicons.glyphMap; text: string; onPress: () => void }) {
  return (
    <Pressable onPress={() => { tap(); onPress(); }} style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, height: 32, borderRadius: 16, backgroundColor: pressed ? "rgba(255,255,255,0.22)" : "rgba(255,255,255,0.12)", maxWidth: 220 })}>
      <Ionicons name={icon} size={15} color="#fff" />
      <Text style={{ color: "#fff", fontSize: 13, fontWeight: "600" }} numberOfLines={1}>{text}</Text>
    </Pressable>
  );
}

function Badge({ text }: { text: string }) {
  return (
    <View style={{ borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1, borderWidth: 1, borderColor: "rgba(255,255,255,0.5)" }}>
      <Text style={{ color: "#fff", fontSize: 10, fontWeight: "800" }}>{text}</Text>
    </View>
  );
}

function Link({ text, onPress }: { text: string; onPress: () => void }) {
  return (
    <Pressable hitSlop={8} onPress={() => { tap(); onPress(); }}>
      <Text style={{ color: ACCENT, fontWeight: "700", fontSize: 15 }}>{text}</Text>
    </Pressable>
  );
}

function Heading({ text }: { text: string }) {
  return <Text style={{ color: "#fff", fontSize: 15, fontWeight: "800", marginTop: 14, marginBottom: 8 }}>{text}</Text>;
}

function Choice({ title, sub, active, onPress }: { title: string; sub?: string; active?: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={() => { tap(); onPress(); }} style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10, paddingHorizontal: 10, borderRadius: 12, backgroundColor: active ? "rgba(232,176,75,0.18)" : pressed ? "rgba(255,255,255,0.06)" : "transparent" })}>
      <View style={{ flex: 1 }}>
        <Text style={{ color: active ? ACCENT : "#fff", fontSize: 15, fontWeight: active ? "700" : "500" }} numberOfLines={2}>{title}</Text>
        {sub ? <Text style={{ color: "#999", fontSize: 12, marginTop: 1 }} numberOfLines={1}>{sub}</Text> : null}
      </View>
      {active ? <Ionicons name="checkmark" size={18} color={ACCENT} /> : null}
    </Pressable>
  );
}

function Chip({ text, active, onPress }: { text: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={() => { tap(); onPress(); }} style={{ paddingHorizontal: 14, height: 32, borderRadius: 16, justifyContent: "center", backgroundColor: active ? ACCENT : "rgba(255,255,255,0.1)" }}>
      <Text style={{ color: active ? "#1A1306" : "#fff", fontWeight: "700" }}>{text}</Text>
    </Pressable>
  );
}

// Seek bar: drag to scrub (track thickens, thumb grows), release to seek; tap to jump.
function SeekBar({ value, duration, buffered, onScrub, onSeek }: { value: number; duration: number; buffered: number; onScrub: (v: number) => void; onSeek: (v: number) => void }) {
  const [w, setW] = useState(1);
  const active = useSharedValue(0);
  const at = (x: number) => Math.max(0, Math.min(1, x / w)) * (duration || 0);
  const pan = Gesture.Pan().runOnJS(true).minDistance(1)
    .onBegin(() => { active.set(withTiming(1, { duration: 140 })); })
    .onUpdate((e) => onScrub(at(e.x)))
    .onEnd((e) => onSeek(at(e.x)))
    .onFinalize(() => { active.set(withTiming(0, { duration: 200 })); });
  const tapG = Gesture.Tap().runOnJS(true).onEnd((e) => onSeek(at(e.x)));
  const p = duration ? Math.min(1, value / duration) : 0;
  const b = duration ? Math.min(1, buffered / duration) : 0;
  const trackStyle = useAnimatedStyle(() => ({ height: 4 + active.value * 3, borderRadius: 4 }));
  const thumbStyle = useAnimatedStyle(() => ({ transform: [{ scale: 1 + active.value * 0.5 }] }));
  return (
    <GestureDetector gesture={Gesture.Exclusive(pan, tapG)}>
      <View onLayout={(e) => setW(e.nativeEvent.layout.width || 1)} style={{ flex: 1, height: 32, justifyContent: "center" }}>
        <Animated.View style={[{ backgroundColor: "rgba(255,255,255,0.25)", overflow: "hidden" }, trackStyle]}>
          <View style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${b * 100}%`, backgroundColor: "rgba(255,255,255,0.35)" }} />
          <View style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${p * 100}%`, backgroundColor: ACCENT }} />
        </Animated.View>
        <Animated.View style={[{ position: "absolute", left: p * w - 7, width: 14, height: 14, borderRadius: 7, backgroundColor: "#fff" }, thumbStyle]} />
      </View>
    </GestureDetector>
  );
}
