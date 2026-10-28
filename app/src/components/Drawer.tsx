// Left drawer with everything that isn't a tab: libraries, subscriptions, history, settings.
// Opens from the menu button in TabHeader or a swipe from the left edge of a tab screen.
import { useEffect, useState, type ReactNode } from "react";
import { Animated, Pressable, ScrollView, Text, useWindowDimensions, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter, type Href } from "expo-router";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery } from "@/lib/query";
import { embyApi } from "@/lib/emby";
import { useSettings } from "@/lib/settings";
import { colors } from "@/lib/theme";
import { closeDrawer, openDrawer, useDrawerOpen } from "./drawerState";
import { tap } from "./ui";

const ADULT = new Set(["AV", "里番"]);
const LIB_ICON: Record<string, keyof typeof Ionicons.glyphMap> = { movies: "film-outline", tvshows: "tv-outline", homevideos: "videocam-outline", music: "musical-notes-outline" };

export function DrawerHost() {
  const isOpen = useDrawerOpen();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const showAdult = useSettings((s) => s.showAdult);
  const user = useSettings((s) => s.emby.username);
  const panel = Math.min(320, width * 0.82);
  const [x] = useState(() => new Animated.Value(-panel));
  const views = useQuery(isOpen ? "emby:views" : null, () => embyApi.views(), { staleMs: 10 * 60_000 });

  useEffect(() => {
    Animated.spring(x, { toValue: isOpen ? 0 : -panel, useNativeDriver: true, friction: 10, tension: 70 }).start();
  }, [isOpen, panel, x]);

  const go = (href: Href) => {
    tap();
    closeDrawer();
    setTimeout(() => router.push(href), 160);
  };

  const libs = (views.data?.Items ?? []).filter((v) => showAdult || !ADULT.has(v.Name));
  // Always mounted (off-screen when closed) so the slide-out can animate; touches pass through when closed.
  return (
    <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, zIndex: 100 }} pointerEvents={isOpen ? "box-none" : "none"}>
      <Animated.View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.backdrop, opacity: x.interpolate({ inputRange: [-panel, 0], outputRange: [0, 1] }) }}>
        <Pressable style={{ flex: 1 }} onPress={closeDrawer} />
      </Animated.View>
      <Animated.View style={{ position: "absolute", top: 0, bottom: 0, left: 0, width: panel, backgroundColor: colors.sheet, borderRightWidth: 1, borderColor: colors.border, transform: [{ translateX: x }] }}>
        <ScrollView contentContainerStyle={{ paddingTop: insets.top + 18, paddingBottom: insets.bottom + 24, paddingHorizontal: 14 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 8, marginBottom: 18 }}>
            <View style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" }}>
              <Ionicons name="play" size={22} color={colors.onPrimary} style={{ marginLeft: 3 }} />
            </View>
            <View>
              <Text style={{ fontSize: 20, fontWeight: "800", color: colors.text }}>影库</Text>
              <Text style={{ fontSize: 12, color: colors.textFaint }}>{user ? `Emby · ${user}` : "Emby 未登录"}</Text>
            </View>
          </View>

          <Section title="媒体库">
            {libs.map((v) => (
              <Item key={v.Id} icon={LIB_ICON[v.CollectionType ?? ""] ?? "albums-outline"} label={v.Name} onPress={() => go({ pathname: "/library/[id]", params: { id: v.Id, name: v.Name } })} />
            ))}
            <Item icon="heart-outline" label="收藏" onPress={() => go({ pathname: "/library/[id]", params: { id: "favorites", name: "收藏" } })} />
          </Section>
          <Section title="入库与订阅">
            <Item icon="bookmarks-outline" label="订阅" onPress={() => go("/subscriptions")} />
            <Item icon="time-outline" label="下载记录" onPress={() => go("/history")} />
            <Item icon="globe-outline" label="索引源" onPress={() => go("/indexers")} />
            <Item icon="pulse-outline" label="概览" onPress={() => go("/overview")} />
          </Section>
          <Section title="应用">
            <Item icon="color-palette-outline" label="外观" onPress={() => go({ pathname: "/settings", params: { section: "look" } })} />
            <Item icon="settings-outline" label="设置" onPress={() => go("/settings")} />
          </Section>
        </ScrollView>
      </Animated.View>
    </View>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={{ marginBottom: 14 }}>
      <Text style={{ fontSize: 12, fontWeight: "700", color: colors.textFaint, paddingHorizontal: 10, marginBottom: 4, letterSpacing: 1 }}>{title}</Text>
      {children}
    </View>
  );
}

function Item({ icon, label, onPress }: { icon: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 10, height: 46, borderRadius: 12, backgroundColor: pressed ? colors.cardMuted : "transparent" })}>
      <Ionicons name={icon} size={20} color={colors.textSoft} />
      <Text style={{ fontSize: 15, color: colors.text, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}

// Swipe from the left edge of a tab screen to open the drawer.
export function DrawerEdge() {
  const pan = Gesture.Pan()
    .activeOffsetX(16)
    .failOffsetY([-20, 20])
    .runOnJS(true)
    .onEnd((e) => {
      if (e.translationX > 50 || e.velocityX > 500) openDrawer();
    });
  return (
    <GestureDetector gesture={pan}>
      <View style={{ position: "absolute", left: 0, top: 100, bottom: 120, width: 28, zIndex: 50 }} />
    </GestureDetector>
  );
}
