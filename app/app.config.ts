import type { ExpoConfig } from "expo/config";

import pkg from "./package.json";

// The release version comes from package.json (bumped by scripts/release.sh);
// CI sets BUILD_NUMBER (GitHub run number) as the build number.
const build = process.env.BUILD_NUMBER ?? "0";

// OTA updates only reach binaries with the same runtime version. Bump this whenever
// native code changes (new/upgraded native module, plugin, permission, Expo SDK),
// then cut a new IPA with scripts/release.sh.
// 3: capability pack so later features ship by OTA (gradient, glass, svg, keep-awake, network,
//    sqlite, Face ID, document picker, sharing, quick actions, localization, crypto, speech
//    recognition) + player: PiP, background audio, Now Playing, AirPlay, add-subtitle, brightness/volume.
// 2: AetherEngine player (modules/mediahub-player + plugins/with-aether-engine), iOS 18 floor,
//    screen orientation. 1: first build (router, image, secure-store, notifications, background task).
export const RUNTIME_VERSION = "4";

const config: ExpoConfig = {
  name: "影库",
  slug: "mediahub",
  scheme: "mediahub",
  version: pkg.version,
  runtimeVersion: RUNTIME_VERSION,
  updates: {
    url: "https://media.example.com/updates/manifest",
    checkAutomatically: "ON_LOAD",
    fallbackToCacheTimeout: 0,
  },
  // The player rotates to landscape itself (expo-screen-orientation); everything else is portrait.
  orientation: "default",
  icon: "./assets/icon.png",
  userInterfaceStyle: "automatic",
  backgroundColor: "#0F0E1C",
  ios: {
    bundleIdentifier: "com.example.mediahub",
    buildNumber: build,
    supportsTablet: false,
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
      CFBundleDisplayName: "影库",
      // Keep audio going when the screen locks or the app leaves the foreground mid-film.
      UIBackgroundModes: ["audio", "fetch", "processing"],
    },
  },
  android: { package: "com.example.mediahub", versionCode: Number(build) || 1 },
  web: { favicon: "./assets/favicon.png" },
  plugins: [
    "expo-router",
    "expo-updates",
    "expo-secure-store",
    // Local notifications only (入库完成/失败): no APNs entitlement, so 全能签 re-signing works.
    ["expo-notifications", { enableRemoteNotifications: false }],
    "expo-background-task",
    "expo-web-browser",
    "expo-screen-orientation",
    "expo-sqlite",
    ["expo-local-authentication", { faceIDPermission: "影库用面容 ID 保护成人内容和设置。" }],
    ["expo-speech-recognition", { speechRecognitionPermission: "影库用语音识别把你说的片名填进搜索框。", microphonePermission: "影库需要麦克风来听你说的片名。" }],
    // AetherEngine needs iOS 18 (Swift package floor).
    ["expo-build-properties", { ios: { deploymentTarget: "18.0" } }],
    "./plugins/with-aether-engine",
  ],
  experiments: { typedRoutes: true },
};

export default config;
