// 系统页的存储卡片和媒体库卡片（数据由后端按需刷新：有人打开且缓存超过 10 分钟才刷新，见 server /v1/stats）。
import { Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ProgressBar, styles, tap } from "./ui";
import type { LibStat, Stats } from "@/lib/api";
import { bytes } from "@/lib/format";
import { colors, radius, shadow } from "@/lib/theme";

const LIB_ICON: Record<string, keyof typeof Ionicons.glyphMap> = { movies: "film", tvshows: "tv", homevideos: "videocam", mixed: "albums" };

export function libMain(l: LibStat): string {
  if (l.series) return `${l.series} 部 · ${l.episodes} 集`;
  if (l.movies) return `${l.movies} 部`;
  return `${l.videos} 个`;
}

export function StorageCard({ s, onPress }: { s?: Stats["storage"]; onPress?: () => void }) {
  const c = s?.c115;
  const used = c && c.total ? (c.used / c.total) * 100 : null;
  return (
    <Pressable disabled={!onPress} onPress={() => { tap(); onPress?.(); }}
      style={({ pressed }) => ({ backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: 14, gap: 8, opacity: pressed ? 0.85 : 1, ...shadow() })}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Ionicons name="cloud" size={16} color={colors.primary} />
        <Text style={[styles.title, { flex: 1 }]}>115 网盘</Text>
        <Text style={styles.faint}>{c ? `剩余 ${bytes(c.remain)}` : "—"}</Text>
      </View>
      <ProgressBar value={used} height={8} color={used !== null && used > 90 ? colors.danger : colors.primary} />
      <Text style={styles.faint}>{c ? `已用 ${bytes(c.used)} / 共 ${bytes(c.total)}（${used?.toFixed(1)}%）` : "还没有数据"}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 4 }}>
        <Ionicons name="server" size={15} color={colors.textSoft} />
        <Text style={[styles.body, { flex: 1 }]}>NAS 下载盘</Text>
        <Text style={styles.faint}>{s?.nas?.free ? `剩余 ${bytes(s.nas.free)}` : "—"}</Text>
      </View>
    </Pressable>
  );
}

export function LibraryGrid({ libs, onPress }: { libs: LibStat[]; onPress?: (l: LibStat) => void }) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
      {libs.map((l) => (
        <Pressable key={l.id} onPress={() => { tap(); onPress?.(l); }}
          style={({ pressed }) => ({ width: "48.4%", backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: 12, opacity: pressed ? 0.85 : 1, ...shadow() })}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Ionicons name={LIB_ICON[l.type] ?? "albums"} size={15} color={colors.primary} />
            <Text style={[styles.title, { flex: 1 }]} numberOfLines={1}>{l.name}</Text>
          </View>
          <Text style={{ fontSize: 20, fontWeight: "800", color: colors.text, marginTop: 8 }} numberOfLines={1}>{libMain(l)}</Text>
          <View style={{ flexDirection: "row", gap: 10, marginTop: 4 }}>
            <Text style={[styles.faint, { color: l.new7d ? colors.success : colors.textFaint }]}>本周 +{l.new7d}</Text>
            {l.noPoster ? <Text style={[styles.faint, { color: colors.warning }]}>缺海报 {l.noPoster}</Text> : null}
          </View>
        </Pressable>
      ))}
    </View>
  );
}
