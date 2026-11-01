// The conversation's ruler (like ChatGPT's): one tick per message that was delivered into the chat —
// the owner's questions, ⚡ signal wake-ups, trade outcomes. The ticks are packed tightly together: at rest
// only the (at most 10) around where you are reading; while a finger is on the rail, all of them (still
// packed). Tap or drag to jump; while dragging, the nearest message is previewed with its time.
import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { haptic } from "@/lib/device";
import { clockStamp } from "@/lib/format";
import { colors, fs } from "@/components/ai/look";

export type RailKind = "user";
export interface RailMark { key: string; y: number; kind: RailKind; label: string; ts?: number }

const KIND: Record<RailKind, { color: string; icon: string }> = {
  user: { color: colors.primary, icon: "" },
};
const REST_MAX = 10; // ticks shown while idle
const PITCH = 6; // distance between neighbouring ticks
const STEP = 14; // finger travel (px) per message at a slow drag: damped, one switch at a time
const MAX_GAIN = 3; // a fast drag moves up to this much further per px (≈ the ticks' own pitch)
const MIN_HIT = 96; // the touch area is never shorter than this, so a rail of two ticks is still easy to hit
const HIT = 4; // touch area = the ticks' own block plus this much above and below

export function ChatRail({ marks, contentH, viewH, scrollY, onJump }: {
  marks: RailMark[]; contentH: number; viewH: number; scrollY: Animated.Value; onJump: (y: number) => void;
}) {
  const [railH, setRailH] = useState(0);
  const [active, setActive] = useState<number | null>(null); // index into marks while the finger is down
  const [full, setFull] = useState(false); // dragging: show every tick
  const [cur, setCur] = useState(0); // the mark the viewport is at
  const n = marks.length;

  useEffect(() => {
    const id = scrollY.addListener(({ value }) => {
      let c = 0;
      marks.forEach((m, i) => { if (m.y <= value + viewH * 0.3) c = i; });
      setCur((p) => (p === c ? p : c));
    });
    return () => scrollY.removeListener(id);
  }, [scrollY, marks, viewH]);

  // the visible slice: all marks while dragging, else ≤ REST_MAX around the current one
  const [lo, hi] = useMemo(() => {
    if (full || n <= REST_MAX) return [0, n];
    const a = Math.max(0, Math.min(n - REST_MAX, cur - Math.floor(REST_MAX / 2)));
    return [a, a + REST_MAX];
  }, [full, n, cur]);
  const count = hi - lo;
  const pitch = Math.min(PITCH, Math.max(2, (railH - 20) / Math.max(1, count)));
  const top = (railH - count * pitch) / 2;
  const yOf = (i: number) => top + (i - lo + 0.5) * pitch;
  const hitH = Math.max(count * pitch + 2 * HIT, MIN_HIT);
  const hitTop = Math.max(0, top + (count * pitch) / 2 - hitH / 2);
  const indexAt = (fy0: number) => { const fy = fy0 + hitTop; return Math.max(lo, Math.min(hi - 1, lo + Math.floor((fy - top) / pitch))); };

  const cursor = useRef({ from: 0, at: 0, acc: 0, y: 0, t: 0 }); // drag start index, index now, travelled messages (fractional), last finger y / time
  const show = (i: number) => {
    cursor.current.at = i;
    if (i !== active) { void haptic("select"); setActive(i); }
  };
  const jump = () => {
    const i = cursor.current.at;
    setActive(null);
    setFull(false);
    if (marks[i]) onJump(Math.max(0, marks[i].y - 8));
  };
  const begin = (fy: number) => { const i = indexAt(fy); Object.assign(cursor.current, { from: i, acc: 0, y: 0, t: 0 }); show(i); };
  const tap = Gesture.Tap().runOnJS(true).onEnd((e) => { begin(e.y); jump(); });
  const pan = Gesture.Pan().runOnJS(true).activeOffsetY([-4, 4]).failOffsetX([-30, 30])
    .onBegin((e) => begin(e.y)).onStart(() => setFull(true))
    .onUpdate((e) => {
      const c = cursor.current, now = Date.now();
      const dy = e.translationY - c.y;
      const v = c.t ? Math.abs(dy) / Math.max(1, now - c.t) : 0; // px per ms
      c.y = e.translationY; c.t = now;
      c.acc = Math.max(-c.from, Math.min(n - 1 - c.from, c.acc + (dy * Math.min(MAX_GAIN, 1 + v * 1.5)) / STEP));
      show(c.from + Math.round(c.acc));
    })
    .onEnd(() => jump()).onFinalize(() => { setActive(null); setFull(false); });
  if (n < 2 || contentH <= viewH + 40) return null;

  const a = active != null ? marks[active] : null;
  const shown = active ?? cur;
  return (
    <>
      <View pointerEvents="none" onLayout={(e) => setRailH(e.nativeEvent.layout.height)} style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 1 }} />
      <GestureDetector gesture={Gesture.Exclusive(pan, tap)}>
        <View style={{ position: "absolute", left: 0, top: hitTop, height: hitH, width: 22, zIndex: 5 }}>
          {marks.slice(lo, hi).map((m, j) => {
            const i = lo + j;
            const on = i === shown;
            return (
              <View key={m.key} pointerEvents="none" style={{ position: "absolute", left: 3, top: yOf(i) - 1 - hitTop, width: on ? 14 : 8, height: 2, borderRadius: 1, backgroundColor: KIND[m.kind].color, opacity: on ? 1 : active == null ? 0.55 : 0.4 }} />
            );
          })}
        </View>
      </GestureDetector>
      {a ? (
        <View pointerEvents="none" style={{ position: "absolute", left: 24, right: 40, top: Math.max(0, Math.min(railH - 60, yOf(active!) - 22)), zIndex: 6, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 10, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.raised, shadowColor: "#000", shadowOpacity: 0.5, shadowRadius: 10 }}>
          {a.ts ? <Text style={{ fontSize: fs.xs, color: colors.textFaint, marginBottom: 2 }}>{clockStamp(a.ts, true)}</Text> : null}
          <Text numberOfLines={2} style={{ fontSize: fs.sm, lineHeight: 18, color: colors.text }}>
            <Text style={{ color: KIND[a.kind].color }}>{KIND[a.kind].icon}</Text>
            {a.label}
          </Text>
        </View>
      ) : null}
    </>
  );
}

/** One line of a message for the rail's preview. */
export function railLabel(text: string) {
  return text.replace(/\s+/g, " ").trim().slice(0, 80) || "（空）";
}
