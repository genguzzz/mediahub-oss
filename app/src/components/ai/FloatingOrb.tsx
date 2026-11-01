// The global assistant orb: floats centred above the tab bar on every screen. Tap opens the chat sheet
// (a work / person / task page becomes its context); press and hold talks — a capsule with a live
// waveform shows above it, slide up to cancel, slide left for a new chat, release to send.
import { useEffect, useState } from "react";
import { Animated, Easing, Text, View } from "react-native";
import { router, usePathname } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Orb } from "@/components/ai/Orb";
import { toast } from "@/components/ui";
import { newChat, send, setContext, useAiSelect } from "@/lib/ai";
import { colors, fs, tnum } from "@/components/ai/look";
import { VoiceWave } from "@/components/ai/VoiceWave";
import { useHoldToTalk } from "@/lib/voice";
import { useConfig } from "@/lib/remoteConfig";

const SIZE = 54; // web .orb
const NEW_DX = 96; // centre of the 新对话 bubble, left of the orb centre (the zone starts at 70 px, lib/voice.ts)
const TAB_ROUTES = new Set(["/", "/discover", "/pipeline", "/overview", "/manage"]);
const HIDDEN = [/^\/ai/, /^\/player/, /^\/settings/, /^\/diagnostics/];

/** The page the orb was tapped on, as context the assistant can look up with its tools. */
function contextOf(pathname: string): string | null {
  let m: RegExpExecArray | null;
  if ((m = /^\/media\/(movie|tv)\/(\d+)/.exec(pathname))) return `作品页（type=${m[1]}, tmdbid=${m[2]}）`;
  if ((m = /^\/tmdb\/person\/(\d+)/.exec(pathname))) return `人物页（personId=${m[1]}）`;
  if ((m = /^\/task\/([0-9a-f]{40})/.exec(pathname))) return `入库任务（hash=${m[1]}）`;
  if ((m = /^\/emby\/(\w+)/.exec(pathname))) return `媒体库条目（embyId=${m[1]}）`;
  if ((m = /^\/catalog\/([\w-]+)\/item\/([^/]+)/.exec(pathname))) return `成人目录作品（provider=${m[1]}, id=${decodeURIComponent(m[2])}）`;
  return null;
}

function open(pathname: string) {
  const c = contextOf(pathname);
  if (c) setContext(c);
  router.push("/ai");
}

/** The orb, unless the remote config turns it off (aiOrb). */
export function FloatingOrb() {
  const { aiOrb } = useConfig();
  return aiOrb ? <Orbit /> : null;
}

function Orbit() {
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const running = useAiSelect((a) => a.running);
  const unread = useAiSelect((a) => a.unread);
  const talk = useHoldToTalk({
    newChat: true,
    onTap: () => open(pathname),
    onText: (t, fresh) => {
      if (fresh) newChat(); // released in the 新对话 zone: start a fresh conversation (the coin page still sets context)
      open(pathname);
      void send(t, false, true);
    },
    onError: (msg) => toast("语音没发出去", msg, undefined, true),
  });
  const rec = talk.phase === "rec";
  const busy = talk.phase === "busy";
  const hidden = HIDDEN.some((r) => r.test(pathname));

  // The orb keeps one absolute anchor and moves by translateY, springing between "above the tab bar"
  // and "near the bottom" as the bar comes and goes (web: transition on the wrapper).
  const base = insets.bottom + 18;
  const onTab = TAB_ROUTES.has(pathname);
  // tab pages: centred above the tab bar; other pages (lists, detail, search results): the bottom-right
  // corner, a little smaller, so it doesn't sit on the middle of the content
  const lift = onTab ? 49 - 4 : 0; // tab bar ≈ 49 pt
  const [y] = useState(() => new Animated.Value(-lift));
  const [show] = useState(() => new Animated.Value(hidden ? 0 : 1));
  useEffect(() => {
    Animated.spring(y, { toValue: -lift, useNativeDriver: true, damping: 18, stiffness: 180, mass: 0.9 }).start();
  }, [lift, y]);
  useEffect(() => {
    Animated.timing(show, { toValue: hidden ? 0 : 1, duration: hidden ? 160 : 240, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [hidden, show]);

  // press feedback (web: transform .28s cubic-bezier(.3,1.6,.5,1)); follows the voice level while recording
  const target = rec ? 1.22 + talk.level * 0.18 : talk.phase === "arming" ? 0.92 : 1;
  const [scale] = useState(() => new Animated.Value(1));
  useEffect(() => {
    if (rec) Animated.timing(scale, { toValue: target, duration: 80, useNativeDriver: true }).start();
    else Animated.spring(scale, { toValue: target, useNativeDriver: true, damping: 9, stiffness: 260 }).start();
  }, [rec, target, scale]);

  const [ripple] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (!rec) return;
    ripple.setValue(0);
    const l = Animated.loop(Animated.timing(ripple, { toValue: 1, duration: 1600, easing: Easing.out(Easing.quad), useNativeDriver: true }));
    l.start();
    return () => l.stop();
  }, [rec, ripple]);

  const capsuleBottom = base + lift + SIZE + 40;
  const showScale = show.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] });

  return (
    <>
      {rec || busy ? (
        <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, bottom: capsuleBottom, alignItems: "center", zIndex: 40 }}>
          <View style={{ minWidth: 240, paddingHorizontal: 22, paddingTop: 12, paddingBottom: 12, borderRadius: 22, alignItems: "center", gap: 8, backgroundColor: "rgba(16,18,14,0.94)", borderWidth: 1, borderColor: talk.cancelZone ? "rgba(202,63,100,0.55)" : talk.newZone ? "rgba(188,255,47,0.6)" : "rgba(188,255,47,0.25)", shadowColor: talk.cancelZone ? "#ca3f64" : "#bcff2f", shadowOpacity: 0.18, shadowRadius: 24, shadowOffset: { width: 0, height: 6 } }}>
            {rec ? (
              <>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                  <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: talk.cancelZone ? colors.down : "#ff4d5e" }} />
                  <Text style={[{ fontSize: fs.sm, color: colors.textSoft, minWidth: 30 }, tnum]}>{`${Math.floor(talk.secs / 60)}:${String(talk.secs % 60).padStart(2, "0")}`}</Text>
                </View>
                <VoiceWave level={talk.level} danger={talk.cancelZone} height={40} />
                <Text style={{ fontSize: fs.sm, color: talk.cancelZone ? "#ff8aa5" : talk.newZone ? colors.primary : colors.textSoft }}>
                  {talk.cancelZone ? "松开取消" : talk.newZone ? "松开发送到新对话" : "松开发送 · 上滑取消 · 左滑新对话"}
                </Text>
              </>
            ) : (
              <Text style={{ fontSize: fs.sm, color: colors.textSoft }}>识别中…</Text>
            )}
          </View>
        </View>
      ) : null}

      <Animated.View pointerEvents={hidden ? "none" : "box-none"} style={{ position: "absolute", left: 0, right: 0, bottom: base, alignItems: onTab ? "center" : "flex-end", paddingRight: onTab ? 0 : 14, zIndex: 41, opacity: show, transform: [{ translateY: y }, { scale: onTab ? showScale : Animated.multiply(showScale, 0.86) }] }}>
        <View {...talk.handlers} accessibilityRole="button" accessibilityLabel="AI 助手：点按打开，长按说话" style={{ width: SIZE, height: SIZE, alignItems: "center", justifyContent: "center" }}>
          {rec
            ? [Animated.modulo(ripple, 1), Animated.modulo(Animated.add(ripple, 0.5), 1)].map((p, i) => (
                // web .ripple r1/r2: scale 1→2.1, fade .9→0, the second half a cycle behind
                <Animated.View key={i} pointerEvents="none" style={{ position: "absolute", width: SIZE, height: SIZE, borderRadius: SIZE, borderWidth: 2, borderColor: talk.cancelZone ? "rgba(202,63,100,0.6)" : "rgba(188,255,47,0.55)",
                  opacity: p.interpolate({ inputRange: [0, 1], outputRange: [0.9, 0] }),
                  transform: [{ scale: p.interpolate({ inputRange: [0, 1], outputRange: [1, 2.1] }) }] }} />
              ))
            : null}
          <Animated.View style={{ transform: [{ scale }] }}>
            <Orb size={SIZE} ring={3} aura period={rec ? 1400 : running || busy ? 1800 : 6000} glow={rec ? 0.55 + talk.level * 0.45 : 0.4} danger={talk.cancelZone}>
              <Ionicons name={rec ? "mic" : "sparkles"} size={22} color="#f4ffe0" style={{ textShadowColor: "rgba(188,255,47,0.55)", textShadowRadius: 6, textShadowOffset: { width: 0, height: 0 } }} />
            </Orb>
          </Animated.View>
          {rec ? <NewChatBubble on={talk.newZone} /> : null}
          {running ? <Satellite /> : null}
          {unread && !running ? <View pointerEvents="none" style={{ position: "absolute", top: 2, right: 2, width: 11, height: 11, borderRadius: 6, backgroundColor: colors.warn, borderWidth: 2, borderColor: "#000" }} /> : null}
        </View>
      </Animated.View>
    </>
  );
}

/** The 新对话 target left of the orb while recording (slide the finger onto it and let go): lit and
 *  grown when the finger is in its zone. */
function NewChatBubble({ on }: { on: boolean }) {
  return (
    <View pointerEvents="none" style={{ position: "absolute", left: SIZE / 2 - NEW_DX - 30, top: SIZE / 2 - 30, width: 60, alignItems: "center", gap: 4 }}>
      <View style={{ width: 52, height: 52, borderRadius: 26, alignItems: "center", justifyContent: "center", borderWidth: 1.5,
        borderColor: on ? colors.primary : "rgba(255,255,255,0.18)", backgroundColor: on ? colors.primary : "rgba(16,18,14,0.92)", transform: [{ scale: on ? 1.15 : 1 }] }}>
        <Ionicons name="add" size={24} color={on ? "#000" : colors.textSoft} />
      </View>
      <Text style={{ fontSize: fs.xs, fontWeight: on ? "700" : "400", color: on ? colors.primary : colors.textSoft }}>新对话</Text>
    </View>
  );
}

/** A dot circling the orb while an answer is being written. */
function Satellite() {
  const [spin] = useState(() => new Animated.Value(0));
  useEffect(() => {
    const l = Animated.loop(Animated.timing(spin, { toValue: 1, duration: 1600, easing: Easing.linear, useNativeDriver: true }));
    l.start();
    return () => l.stop();
  }, [spin]);
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  return (
    <Animated.View pointerEvents="none" style={{ position: "absolute", width: SIZE + 10, height: SIZE + 10, transform: [{ rotate }] }}>
      <View style={{ position: "absolute", top: -1, left: (SIZE + 10) / 2 - 4, width: 8, height: 8, borderRadius: 4, backgroundColor: colors.primary, shadowColor: colors.primary, shadowOpacity: 0.9, shadowRadius: 6, shadowOffset: { width: 0, height: 0 } }} />
    </Animated.View>
  );
}
