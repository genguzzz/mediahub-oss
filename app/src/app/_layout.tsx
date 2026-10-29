import { useEffect } from "react";
import { ActivityIndicator, AppState, Platform, useColorScheme, View } from "react-native";
import { Stack, usePathname, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as Device from "expo-device";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { PosterSheetHost } from "@/components/PosterSheet";
import { FullWindowOverlay } from "react-native-screens";
import { ToastHost, toast } from "@/components/ui";
import { appVersion } from "@/lib/api";
import { flush, installGlobalHandlers, logger, pruneLogs, sessionId } from "@/lib/log";
import { installNotificationHandler, onNotificationTap, registerBackgroundCheck } from "@/lib/notify";
import { loadSettings, useSettings, useSettingsLoaded } from "@/lib/settings";
import { applyTheme, colors, type Scheme } from "@/lib/theme";
import { installTracking, track } from "@/lib/track";
import { logRunningUpdate, restartToApply, startForegroundChecks, useUpdates } from "@/lib/updates";
import { device } from "../../modules/mediahub-player";

const log = logger("app");
installGlobalHandlers();
installTracking();
log.info("launch", { session: sessionId, version: appVersion, os: `${Platform.OS} ${Platform.Version}`, device: `${Device.manufacturer ?? ""} ${Device.modelName ?? ""}`.trim() });
logRunningUpdate();
startForegroundChecks();
installNotificationHandler();
void loadSettings().then(() => {
  track("app_open", { version: appVersion, os: `${Platform.OS} ${Platform.Version}` });
  pruneLogs();
  void registerBackgroundCheck();
});

export default function RootLayout() {
  const loaded = useSettingsLoaded();
  const themePref = useSettings((s) => s.theme);
  const style = useSettings((s) => s.style);
  const system = useColorScheme();
  const pathname = usePathname();
  const router = useRouter();
  const scheme: Scheme = themePref === "light" || themePref === "dark" ? themePref : system === "dark" ? "dark" : "light";
  // Palette must be in place before any child renders; the key below remounts on change.
  applyTheme(style, scheme);

  useEffect(() => {
    log.info("route", { pathname });
    // Screen views; ids in paths are collapsed so events stay countable.
    track("screen", { path: pathname.replace(/\/[A-Za-z0-9_-]{6,}$/, "/:id").replace(/\/\d+$/, "/:id") });
  }, [pathname]);

  useEffect(() => onNotificationTap((route) => router.push(route as never)), [router]);

  // A small window that outlived its player screen was restored: reopen the player where it was.
  useEffect(() => {
    const sub = device.onPiPRestore((e) => {
      log.info("pip restore", { item: e.itemId, at: Math.round(e.position) });
      router.push({ pathname: "/player", params: { id: e.itemId, at: String(Math.max(0, e.position - 2)) } });
    });
    return () => sub?.remove();
  }, [router]);

  // OTA: once an update has downloaded, offer the restart (it also applies on the next cold start).
  const { isUpdatePending } = useUpdates();
  useEffect(() => {
    if (isUpdatePending) toast("新版本已就绪", "重启后生效", { label: "立即重启", onPress: () => void restartToApply() });
  }, [isUpdatePending]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      if (s !== "active") void flush();
    });
    return () => sub.remove();
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider key={`${style}:${scheme}`}>
        <StatusBar style={scheme === "dark" ? "light" : "dark"} />
        {loaded ? (
          <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg }, fullScreenGestureEnabled: false, orientation: "portrait_up" }}>
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="settings" options={{ presentation: "modal" }} />
            <Stack.Screen name="player" options={{ presentation: "fullScreenModal", animation: "fade", gestureEnabled: false, orientation: "landscape" }} />
          </Stack>
        ) : (
          <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: "center", justifyContent: "center" }}>
            <ActivityIndicator color={colors.primary} />
          </View>
        )}
        {loaded ? <PosterSheetHost /> : null}
        {/* iOS: toasts live in their own window above native sheets/modals (入库 sheet, settings), otherwise errors hide under them */}
        {loaded ? (Platform.OS === "ios" ? <FullWindowOverlay><ToastHost /></FullWindowOverlay> : <ToastHost />) : null}
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
