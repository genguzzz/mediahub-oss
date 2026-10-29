// Player side panel for casting to a DLNA TV: pick a renderer, send the current film, then remote-control it.
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { cast, discover, describe, fromAddress, type CastStatus, type Renderer } from "@/lib/dlna";
import { logger } from "@/lib/log";
import { getSettings, setSettings } from "@/lib/settings";
import { track } from "@/lib/track";

const log = logger("cast");
const ACCENT = "#E8B04B";
const STATE: Record<string, string> = { PLAYING: "播放中", PAUSED_PLAYBACK: "已暂停", STOPPED: "已停止", TRANSITIONING: "加载中…", NO_MEDIA_PRESENT: "未载入" };
const clock = (s: number) => {
  const n = Math.max(0, Math.round(s));
  const h = Math.floor(n / 3600);
  return `${h ? `${h}:` : ""}${String(Math.floor((n % 3600) / 60)).padStart(h ? 2 : 1, "0")}:${String(n % 60).padStart(2, "0")}`;
};

export interface CastPanelProps {
  uri: string | null;
  title: string;
  position: number;
  canScan: boolean;
  onStart: () => void;     // local playback should pause: the TV took over
  onStop: (at: number) => void; // casting ended; resume locally from this position
}

export function CastPanel({ uri, title, position, canScan, onStart, onStop }: CastPanelProps) {
  const [devices, setDevices] = useState<Renderer[]>([]);
  const [target, setTarget] = useState<Renderer | null>(null);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [casting, setCasting] = useState(false);
  const [status, setStatus] = useState<CastStatus | null>(null);
  const [volume, setVolume] = useState<number | null>(null);
  const [addr, setAddr] = useState("");
  const [error, setError] = useState("");
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const pick = useCallback((r: Renderer) => {
    setTarget(r);
    setSettings({ castTv: { name: r.name, location: r.location } });
  }, []);

  const scan = useCallback(async () => {
    setScanning(true);
    setError("");
    try {
      const found = await discover();
      if (!alive.current) return;
      if (found === null) setError("当前版本不支持自动搜索，请手动输入电视地址");
      else {
        setDevices(found);
        if (!found.length) setError("没有找到电视：确认手机和电视在同一 Wi-Fi，且已允许「本地网络」权限");
        else if (!target) pick(found[0]);
      }
    } finally {
      if (alive.current) setScanning(false);
    }
  }, [pick, target]);

  useEffect(() => {
    const saved = getSettings().castTv;
    (async () => {
      if (saved) {
        const r = await describe(saved.location);
        if (r && alive.current) { setDevices([r]); setTarget(r); return; }
      }
      if (canScan) void scan();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!casting || !target) return;
    const t = setInterval(() => void cast.status(target).then((s) => alive.current && setStatus(s)).catch(() => {}), 2000);
    return () => clearInterval(t);
  }, [casting, target]);

  const run = async (what: string, fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      log.warn("cast failed", { what, err: m });
      setError(`${what}失败：${m}`);
    }
  };

  const start = async () => {
    if (!target || !uri) return;
    setBusy(true);
    await run("投屏", async () => {
      await cast.load(target, uri, title, position);
      track("cast_start", { tv: target.name });
      setCasting(true);
      onStart();
      setVolume(await cast.volume(target).catch(() => null));
      setStatus(await cast.status(target).catch(() => null));
    });
    setBusy(false);
  };

  const stop = async () => {
    if (!target) return;
    const at = status?.position ?? 0;
    await run("停止", () => cast.stop(target));
    setCasting(false);
    onStop(at);
  };

  const addManual = async () => {
    setBusy(true);
    const r = await fromAddress(addr);
    setBusy(false);
    if (!r) return setError("连不上这个地址，或它不是 DLNA 电视（格式：192.168.1.50:16990）");
    setDevices((d) => [r, ...d.filter((x) => x.location !== r.location)]);
    pick(r);
    setAddr("");
  };

  const playing = status?.state === "PLAYING";
  return (
    <View>
      <Text style={{ color: "#fff", fontSize: 17, fontWeight: "700", marginBottom: 10 }}>投屏</Text>

      {casting && target ? (
        <>
          <Text style={{ color: ACCENT, fontWeight: "700" }}>正在投到 {target.name}</Text>
          <Text style={{ color: "#aaa", marginTop: 4 }}>{STATE[status?.state ?? ""] ?? status?.state ?? "…"}　{status ? `${clock(status.position)} / ${clock(status.duration)}` : ""}</Text>
          <View style={{ flexDirection: "row", gap: 10, marginTop: 14 }}>
            <Ctl icon="play-back" onPress={() => void run("后退", () => cast.seek(target, Math.max(0, (status?.position ?? 0) - 10)))} />
            <Ctl icon={playing ? "pause" : "play"} onPress={() => void run("操作", () => (playing ? cast.pause(target) : cast.play(target)))} />
            <Ctl icon="play-forward" onPress={() => void run("快进", () => cast.seek(target, (status?.position ?? 0) + 10))} />
          </View>
          {volume !== null ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginTop: 12 }}>
              <Ctl icon="volume-low" onPress={() => void run("音量", async () => { const v = Math.max(0, volume - 5); await cast.setVolume(target, v); setVolume(v); })} />
              <Text style={{ color: "#fff", width: 44, textAlign: "center" }}>{volume}</Text>
              <Ctl icon="volume-high" onPress={() => void run("音量", async () => { const v = Math.min(100, volume + 5); await cast.setVolume(target, v); setVolume(v); })} />
            </View>
          ) : null}
          <Pressable onPress={() => void stop()} style={{ marginTop: 16, paddingVertical: 12, borderRadius: 12, backgroundColor: "rgba(255,255,255,0.1)", alignItems: "center" }}>
            <Text style={{ color: "#fff", fontWeight: "700" }}>停止投屏，回到手机继续看</Text>
          </Pressable>
        </>
      ) : (
        <>
          {devices.map((d) => (
            <Pressable key={d.location} onPress={() => pick(d)} style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 11 }}>
              <Ionicons name="tv-outline" size={20} color={target?.location === d.location ? ACCENT : "#bbb"} />
              <Text style={{ flex: 1, color: target?.location === d.location ? ACCENT : "#fff", fontSize: 15 }} numberOfLines={2}>{d.name}</Text>
              {target?.location === d.location ? <Ionicons name="checkmark" size={18} color={ACCENT} /> : null}
            </Pressable>
          ))}
          {scanning ? <View style={{ flexDirection: "row", gap: 8, paddingVertical: 8 }}><ActivityIndicator color={ACCENT} /><Text style={{ color: "#aaa" }}>正在搜索局域网内的电视…</Text></View> : null}
          {canScan && !scanning ? (
            <Pressable onPress={() => void scan()} style={{ paddingVertical: 8 }}>
              <Text style={{ color: ACCENT }}>重新搜索</Text>
            </Pressable>
          ) : null}
          <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
            <TextInput
              value={addr}
              onChangeText={setAddr}
              placeholder="手动输入 IP:端口"
              placeholderTextColor="#777"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="numbers-and-punctuation"
              style={{ flex: 1, color: "#fff", borderWidth: 1, borderColor: "rgba(255,255,255,0.18)", borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 }}
            />
            <Pressable onPress={() => void addManual()} style={{ paddingHorizontal: 14, justifyContent: "center", borderRadius: 10, backgroundColor: "rgba(255,255,255,0.1)" }}>
              <Text style={{ color: "#fff" }}>添加</Text>
            </Pressable>
          </View>
          <Pressable
            disabled={!target || !uri || busy}
            onPress={() => void start()}
            style={{ marginTop: 16, paddingVertical: 13, borderRadius: 12, backgroundColor: !target || !uri ? "rgba(232,176,75,0.35)" : ACCENT, alignItems: "center" }}
          >
            {busy ? <ActivityIndicator color="#000" /> : <Text style={{ color: "#000", fontWeight: "800" }}>{target ? `投到 ${target.name}` : "先选择一台电视"}</Text>}
          </Pressable>
          <Text style={{ color: "#888", fontSize: 12, marginTop: 10, lineHeight: 17 }}>电视会自己从 Emby 拉取影片（走 115 直链），手机只做遥控。首次使用需允许「本地网络」权限。</Text>
        </>
      )}
      {error ? <Text style={{ color: "#ff8a80", marginTop: 10, lineHeight: 18 }}>{error}</Text> : null}
    </View>
  );
}

function Ctl({ icon, onPress }: { icon: keyof typeof Ionicons.glyphMap; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: "rgba(255,255,255,0.1)", alignItems: "center", justifyContent: "center" }}>
      <Ionicons name={icon} size={22} color="#fff" />
    </Pressable>
  );
}
