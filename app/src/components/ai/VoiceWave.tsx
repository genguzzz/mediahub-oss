// Live voice waveform (hold-to-talk capsule, composer mic): bars mirrored around the centre whose
// heights follow the input level on every meter poll (~50 ms), tallest in the middle, each with its
// own jitter so speech reads as a wave. Silence leaves them at a low floor: all motion is the voice.
// Heights animate as scaleY on the native thread (Murmur's record screen does the same).
import { useEffect, useState } from "react";
import { Animated, Easing, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { colors } from "@/components/ai/look";

export function VoiceWave({ level, bars = 27, height = 40, barWidth = 3.5, gap = 3, danger, active = true }: {
  level: number; bars?: number; height?: number; barWidth?: number; gap?: number; danger?: boolean; active?: boolean;
}) {
  const [vals] = useState(() => Array.from({ length: bars }, () => new Animated.Value(0.08)));
  // bell-shaped envelope: centre bars swing most, edges a little
  const [env] = useState(() => Array.from({ length: bars }, (_, i) => {
    const x = (i - (bars - 1) / 2) / ((bars - 1) / 2);
    return 0.3 + 0.7 * Math.exp(-x * x * 2.2);
  }));
  useEffect(() => {
    const t = Date.now() / 140;
    vals.forEach((v, i) => {
      const jitter = 0.6 + 0.4 * Math.abs(Math.sin(t + i * 1.7));
      const to = active ? Math.max(0.08, Math.min(1, level * env[i] * jitter * 1.15)) : 0.08;
      Animated.timing(v, { toValue: to, duration: 70, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
    });
  }, [level, active, vals, env]);

  const from = danger ? colors.down : colors.primary;
  const to = danger ? "#ff7a59" : "#2fe0ff";
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap, height }}>
      {vals.map((v, i) => (
        <Animated.View key={i} style={{ width: barWidth, height, borderRadius: barWidth, overflow: "hidden", transform: [{ scaleY: v }] }}>
          <LinearGradient colors={[to, from, to]} style={{ flex: 1 }} />
        </Animated.View>
      ))}
    </View>
  );
}
