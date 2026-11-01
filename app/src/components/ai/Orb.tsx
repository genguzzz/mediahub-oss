// The AI orb (web AiOrb.vue / .big-orb / .mini-orb): a rotating aurora ring around a dark glass core.
// The web ring is a conic gradient; SVG has none, so the disc is drawn as thin pie slices whose colours
// step through the same stops. `aura` adds the web's blurred glow: the same colours as soft radial
// blobs around the ring, rotating with it and breathing.
import { memo, useEffect, useState, type ReactNode } from "react";
import { Animated, Easing, View, type ViewProps } from "react-native";
import Svg, { Circle, Defs, G, Path, RadialGradient, Stop } from "react-native-svg";

const STOPS = ["#bcff2f", "#2fe0ff", "#9b7df0", "#ff5fa2", "#f5c542", "#bcff2f"];
const RED = ["#ca3f64", "#ff7a59", "#ca3f64"];
const SLICES = 72;

function mix(a: string, b: string, t: number) {
  const p = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  const c = [0, 1, 2].map((i) => Math.round(p(a, i) + (p(b, i) - p(a, i)) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
function colorAt(stops: string[], f: number) {
  const x = f * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  return mix(stops[i], stops[i + 1], x - i);
}

/** A conic-gradient disc (from 12 o'clock, clockwise). */
const Conic = memo(function Conic({ size, stops }: { size: number; stops: string[] }) {
  const r = size / 2;
  const slices = Array.from({ length: SLICES }, (_, i) => {
    const a0 = (i / SLICES) * 2 * Math.PI - Math.PI / 2;
    const a1 = ((i + 1.15) / SLICES) * 2 * Math.PI - Math.PI / 2; // slight overlap hides seams
    const d = `M${r},${r} L${r + r * Math.cos(a0)},${r + r * Math.sin(a0)} A${r},${r} 0 0 1 ${r + r * Math.cos(a1)},${r + r * Math.sin(a1)} Z`;
    return <Path key={i} d={d} fill={colorAt(stops, (i + 0.5) / SLICES)} />;
  });
  return <Svg width={size} height={size}>{slices}</Svg>;
});

/** Soft coloured blobs standing in for the web's blur(14px) of the conic ring. */
const Aura = memo(function Aura({ size, stops }: { size: number; stops: string[] }) {
  const c = size / 2;
  const n = stops.length - 1;
  return (
    <Svg width={size} height={size}>
      <Defs>
        {stops.slice(0, n).map((s, i) => (
          <RadialGradient key={i} id={`au${i}${s}`} cx="50%" cy="50%" r="50%">
            <Stop offset="0" stopColor={s} stopOpacity={0.85} />
            <Stop offset="1" stopColor={s} stopOpacity={0} />
          </RadialGradient>
        ))}
      </Defs>
      <G>
        {stops.slice(0, n).map((s, i) => {
          const a = ((i + 0.5) / n) * 2 * Math.PI - Math.PI / 2;
          const d = size * 0.2;
          return <Circle key={i} cx={c + d * Math.cos(a)} cy={c + d * Math.sin(a)} r={size * 0.36} fill={`url(#au${i}${s})`} />;
        })}
      </G>
    </Svg>
  );
});

/** The dark glass core: a top-left highlight over a dark radial fill (web .core). */
const Core = memo(function Core({ size }: { size: number }) {
  return (
    <Svg width={size} height={size}>
      <Defs>
        <RadialGradient id="coreFill" cx="50%" cy="60%" r="72%">
          <Stop offset="0" stopColor="#1a1f17" />
          <Stop offset="1" stopColor="#050505" />
        </RadialGradient>
        <RadialGradient id="coreHi" cx="32%" cy="28%" r="42%">
          <Stop offset="0" stopColor="#ffffff" stopOpacity={0.22} />
          <Stop offset="1" stopColor="#ffffff" stopOpacity={0} />
        </RadialGradient>
        <RadialGradient id="coreRim" cx="50%" cy="50%" r="50%">
          <Stop offset="0.7" stopColor="#bcff2f" stopOpacity={0} />
          <Stop offset="1" stopColor="#bcff2f" stopOpacity={0.16} />
        </RadialGradient>
      </Defs>
      <Circle cx={size / 2} cy={size / 2} r={size / 2} fill="url(#coreFill)" />
      <Circle cx={size / 2} cy={size / 2} r={size / 2} fill="url(#coreRim)" />
      <Circle cx={size / 2} cy={size / 2} r={size / 2} fill="url(#coreHi)" />
    </Svg>
  );
});

export function Orb({ size, ring = 3, period = 6000, scale = 1, glow = 0.35, aura, danger, children, ...rest }: { size: number; ring?: number; period?: number; scale?: number; glow?: number; aura?: boolean; danger?: boolean; children?: ReactNode } & ViewProps) {
  const [spin] = useState(() => new Animated.Value(0));
  const [breath] = useState(() => new Animated.Value(0));
  useEffect(() => {
    spin.setValue(0);
    const l = Animated.loop(Animated.timing(spin, { toValue: 1, duration: period, easing: Easing.linear, useNativeDriver: true }));
    l.start();
    return () => l.stop();
  }, [spin, period]);
  useEffect(() => {
    if (!aura) return;
    const l = Animated.loop(Animated.sequence([
      Animated.timing(breath, { toValue: 1, duration: 1600, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      Animated.timing(breath, { toValue: 0, duration: 1600, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
    ]));
    l.start();
    return () => l.stop();
  }, [aura, breath]);
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  const stops = danger ? RED : STOPS;
  const auraSize = size + 34; // web: inset -6px + blur(14px)
  // breathing (web @keyframes breathe: opacity .3→.62, scale .94→1.08); a fixed bright glow while recording
  const auraOpacity = glow >= 0.6 ? Math.min(1, glow) : breath.interpolate({ inputRange: [0, 1], outputRange: [0.3, 0.62] });
  const auraScale = glow >= 0.6 ? 1 + (glow - 0.6) : breath.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1.08] });
  return (
    <View {...rest} style={[{ width: size, height: size, alignItems: "center", justifyContent: "center", transform: [{ scale }] }, rest.style]}>
      {aura ? (
        <Animated.View pointerEvents="none" style={{ position: "absolute", width: auraSize, height: auraSize, opacity: auraOpacity, transform: [{ scale: auraScale }] }}>
          <Animated.View style={{ width: auraSize, height: auraSize, transform: [{ rotate }] }}>
            <Aura size={auraSize} stops={stops} />
          </Animated.View>
        </Animated.View>
      ) : null}
      <Animated.View style={{ position: "absolute", width: size, height: size, borderRadius: size / 2, overflow: aura ? "hidden" : "visible", transform: [{ rotate }], shadowColor: danger ? "#ca3f64" : "#bcff2f", shadowOpacity: aura ? 0 : glow, shadowRadius: size / 4, shadowOffset: { width: 0, height: 0 } }}>
        <Conic size={size} stops={stops} />
      </Animated.View>
      {ring * 2 < size ? (
        <View style={{ position: "absolute", width: size - ring * 2, height: size - ring * 2, borderRadius: size, overflow: "hidden" }}>
          <Core size={size - ring * 2} />
        </View>
      ) : null}
      {children ? <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center" }}>{children}</View> : null}
    </View>
  );
}
