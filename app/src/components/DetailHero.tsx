// Immersive top of a detail page (Emby item and 发现 TMDb work share it): full-bleed backdrop that fades into the
// page, poster + title block overlapping its lower edge, and a floating back button.
import type { ReactNode } from "react";
import { Pressable, useWindowDimensions, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Img } from "./media";
import { tap } from "./ui";
import { colors, radius } from "@/lib/theme";

type Src = Parameters<typeof Img>[0]["source"];

export function useHeroHeight(): number {
  const { width } = useWindowDimensions();
  return Math.round(width * 0.62);
}

/** Backdrop band; render it first inside the ScrollView. */
export function HeroBackdrop({ source }: { source: Src }) {
  const heroH = useHeroHeight();
  return (
    <View style={{ height: heroH }}>
      <Img source={source} style={{ position: "absolute", top: 0, left: 0, right: 0, height: heroH }} icon="image-outline" />
      {/* Fade the hero into the page background. */}
      {Array.from({ length: 16 }, (_, i) => (
        <View key={i} style={{ position: "absolute", left: 0, right: 0, top: heroH * (0.45 + i * 0.035), height: heroH * 0.035 + 1, backgroundColor: `${colors.fade}${((i + 1) / 16) ** 1.6})` }} />
      ))}
      <View style={{ position: "absolute", left: 0, right: 0, top: heroH * 0.99, height: heroH * 0.02, backgroundColor: colors.bg }} />
    </View>
  );
}

/** Poster on the left, `children` (title, meta, ratings) on the right, pulled up over the backdrop. */
export function HeroHeader({ poster, children }: { poster: Src; children: ReactNode }) {
  const heroH = useHeroHeight();
  return (
    <View style={{ paddingHorizontal: 18, marginTop: -heroH * 0.32 }}>
      <View style={{ flexDirection: "row", gap: 14, alignItems: "flex-end" }}>
        <View style={{ borderRadius: radius.md, overflow: "hidden", borderWidth: 1, borderColor: colors.border }}>
          <Img source={poster} style={{ width: 104, height: 156 }} />
        </View>
        <View style={{ flex: 1, paddingBottom: 4 }}>{children}</View>
      </View>
    </View>
  );
}

/** Floating back button; render it after the ScrollView. */
export function HeroBack() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  return (
    <View style={{ position: "absolute", top: insets.top + 6, left: 12 }}>
      <Pressable hitSlop={10} accessibilityLabel="返回" onPress={() => { tap(); router.back(); }} style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: "rgba(0,0,0,0.45)", alignItems: "center", justifyContent: "center" }}>
        <Ionicons name="chevron-back" size={22} color="#fff" />
      </Pressable>
    </View>
  );
}
