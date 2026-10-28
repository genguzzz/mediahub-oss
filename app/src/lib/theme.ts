import { Platform } from "react-native";

export type Scheme = "light" | "dark";
export type StyleId = "cinema" | "seasalt" | "crimson";

type Palette = {
  bg: string;
  card: string;
  cardMuted: string;
  border: string;
  text: string;
  textSoft: string;
  textFaint: string;
  primary: string;
  primarySoft: string;
  onPrimary: string;
  success: string;
  warning: string;
  danger: string;
  white: string;
  sheet: string;
  backdrop: string;
  overlay: string;
  // Hero gradients fade into this (the page background with alpha).
  fade: string;
};

const common = { white: "#FFFFFF", overlay: "rgba(0,0,0,0.55)" };

// Three looks, each with a light and a dark variant. 影院 is the default: warm gold on near-black,
// like a dimmed cinema; 海盐 is cool and airy; 绯红 is a streaming-service red on graphite.
export const STYLES: Record<StyleId, { name: string; note: string; light: Palette; dark: Palette }> = {
  cinema: {
    name: "影院",
    note: "暖金色，适合夜间",
    dark: {
      ...common, bg: "#0B0B0D", card: "#16161B", cardMuted: "#1E1E25", border: "#2A2A33", text: "#F4F1EA", textSoft: "#ABA698",
      textFaint: "#6E6A61", primary: "#E8B04B", primarySoft: "#3A2E17", onPrimary: "#1A1306", success: "#5BC08A", warning: "#E8B04B",
      danger: "#EF6A5B", sheet: "#16161B", backdrop: "rgba(0,0,0,0.6)", fade: "rgba(11,11,13,",
    },
    light: {
      ...common, bg: "#F6F3EC", card: "#FFFFFF", cardMuted: "#EEE9DE", border: "#E3DCCD", text: "#1B1813", textSoft: "#6B6455",
      textFaint: "#A39C8C", primary: "#A8761A", primarySoft: "#F3E6C8", onPrimary: "#FFFFFF", success: "#2E8B57", warning: "#B7791F",
      danger: "#C8483A", sheet: "#FFFFFF", backdrop: "rgba(27,24,19,0.4)", fade: "rgba(246,243,236,",
    },
  },
  seasalt: {
    name: "海盐",
    note: "清爽蓝绿，适合白天",
    light: {
      ...common, bg: "#F3F7F9", card: "#FFFFFF", cardMuted: "#E8EFF3", border: "#DCE6EC", text: "#0F1E26", textSoft: "#4F6573",
      textFaint: "#8EA2AE", primary: "#0E8AB0", primarySoft: "#D6EEF6", onPrimary: "#FFFFFF", success: "#1F9D6B", warning: "#C98A1B",
      danger: "#D4554A", sheet: "#FFFFFF", backdrop: "rgba(15,30,38,0.4)", fade: "rgba(243,247,249,",
    },
    dark: {
      ...common, bg: "#0B1419", card: "#122129", cardMuted: "#172A33", border: "#22363F", text: "#E6F1F5", textSoft: "#93AAB5",
      textFaint: "#5D7480", primary: "#3DC2E6", primarySoft: "#12384A", onPrimary: "#04212C", success: "#4CC38A", warning: "#E0A93B",
      danger: "#F0786E", sheet: "#122129", backdrop: "rgba(0,0,0,0.6)", fade: "rgba(11,20,25,",
    },
  },
  crimson: {
    name: "绯红",
    note: "石墨黑配红色，流媒体风格",
    dark: {
      ...common, bg: "#0D0D0D", card: "#181818", cardMuted: "#222222", border: "#2C2C2C", text: "#F5F5F5", textSoft: "#B3B3B3",
      textFaint: "#737373", primary: "#E50914", primarySoft: "#3A1012", onPrimary: "#FFFFFF", success: "#46D369", warning: "#F5B70A",
      danger: "#FF5A5F", sheet: "#181818", backdrop: "rgba(0,0,0,0.65)", fade: "rgba(13,13,13,",
    },
    light: {
      ...common, bg: "#F7F7F7", card: "#FFFFFF", cardMuted: "#EFEFEF", border: "#E2E2E2", text: "#141414", textSoft: "#5E5E5E",
      textFaint: "#9A9A9A", primary: "#D40813", primarySoft: "#FBE0E1", onPrimary: "#FFFFFF", success: "#1E9E50", warning: "#C98A1B",
      danger: "#D40813", sheet: "#FFFFFF", backdrop: "rgba(20,20,20,0.4)", fade: "rgba(247,247,247,",
    },
  },
};

// Mutable palette: the root layout applies the active style before rendering and remounts the
// tree when it changes, so components read `colors.x` during render (never at module scope).
export const colors: Palette = { ...STYLES.cinema.dark };
export let scheme: Scheme = "dark";

export function applyTheme(style: StyleId, s: Scheme) {
  scheme = s;
  Object.assign(colors, (STYLES[style] ?? STYLES.cinema)[s]);
}

export const radius = { sm: 8, md: 14, lg: 20, pill: 999 };

export function shadow() {
  if (scheme === "dark") return {};
  return Platform.select({
    ios: { shadowColor: "#000", shadowOpacity: 0.08, shadowRadius: 12, shadowOffset: { width: 0, height: 4 } },
    android: { elevation: 2 },
    default: {},
  });
}
