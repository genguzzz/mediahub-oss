import { View } from "react-native";
import { NativeTabs } from "expo-router/native-tabs";
import { DrawerEdge, DrawerHost } from "@/components/Drawer";
import { useQuery } from "@/lib/query";
import { api, type Overview } from "@/lib/api";
import { colors } from "@/lib/theme";

// Five daily screens on the system tab bar (Liquid Glass on iOS 26+); everything else lives in
// the left drawer. The 入库 badge counts tasks still moving through the pipeline.
export default function TabsLayout() {
  const { data } = useQuery("overview", () => api<Overview>("/v1/overview", { timeoutMs: 45_000 }), { interval: 60_000, staleMs: 30_000 });
  const busy = (data?.pipeline?.downloading ?? 0) + (data?.pipeline?.waiting ?? 0);
  const badge = busy ? (busy > 99 ? "99+" : String(busy)) : "";
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <NativeTabs tintColor={colors.primary} minimizeBehavior="onScrollDown">
        <NativeTabs.Trigger name="index">
          <NativeTabs.Trigger.Icon sf={{ default: "play.rectangle.on.rectangle", selected: "play.rectangle.on.rectangle.fill" }} md="video_library" />
          <NativeTabs.Trigger.Label>媒体库</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="discover">
          <NativeTabs.Trigger.Icon sf={{ default: "sparkle.magnifyingglass", selected: "sparkle.magnifyingglass" }} md="explore" />
          <NativeTabs.Trigger.Label>发现</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
        {/* badgeValue is always passed: dropping the prop leaves iOS showing the last value. */}
        <NativeTabs.Trigger name="pipeline" unstable_nativeProps={{ badgeValue: badge }}>
          <NativeTabs.Trigger.Icon sf={{ default: "arrow.down.circle", selected: "arrow.down.circle.fill" }} md="downloading" />
          <NativeTabs.Trigger.Label>入库</NativeTabs.Trigger.Label>
          {badge ? <NativeTabs.Trigger.Badge>{badge}</NativeTabs.Trigger.Badge> : null}
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="manage">
          <NativeTabs.Trigger.Icon sf={{ default: "slider.horizontal.3", selected: "slider.horizontal.3" }} md="tune" />
          <NativeTabs.Trigger.Label>管理</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="overview">
          <NativeTabs.Trigger.Icon sf={{ default: "gauge.with.dots.needle.33percent", selected: "gauge.with.dots.needle.67percent" }} md="monitoring" />
          <NativeTabs.Trigger.Label>概览</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
      </NativeTabs>
      <DrawerEdge />
      <DrawerHost />
    </View>
  );
}
