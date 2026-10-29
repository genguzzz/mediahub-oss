// App settings, persisted as one JSON blob in the keychain (the token is a secret).
import { useSyncExternalStore } from "react";
import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import type { StyleId } from "./theme";
import { DEFAULT_SERVER } from "./instance";
import { logger } from "./log";

const log = logger("settings");
const KEY = "mediahub.settings";

export interface Settings {
  server: string;        // backend base URL, no trailing slash
  token: string;         // APP_TOKEN from the server .env
  showAdult: boolean;    // AV / 里番 libraries, sources and search modes
  notify: boolean;       // local notifications when a task finishes or fails
  theme: "system" | "light" | "dark";
  style: StyleId;        // colour style, see theme.ts STYLES
  layout: "grid" | "list"; // poster lists: two-column waterfall or large-poster list
  subtitleScale: number; // player subtitle size multiplier
  sources: string[] | null; // sources pre-selected for 按来源搜索 (null = built-in default)
  emby: EmbyAccount;
  castTv: { name: string; location: string } | null; // last DLNA renderer used for casting
}

// Direct Emby connection (the phone talks to Emby itself; the backend only hands out the account).
export interface EmbyAccount {
  server: string;   // e.g. https://emby.example.com:8920
  username: string;
  token: string;    // AccessToken from AuthenticateByName
  userId: string;
  deviceId: string;
}

export { DEFAULT_SERVER };

// The web build (used for previews) has no keychain; it keeps settings in localStorage.
const store = Platform.OS === "web"
  ? { get: async (k: string) => globalThis.localStorage?.getItem(k) ?? null, set: async (k: string, v: string) => globalThis.localStorage?.setItem(k, v) }
  : { get: (k: string) => SecureStore.getItemAsync(k), set: (k: string, v: string) => SecureStore.setItemAsync(k, v) };

const randomId = () => `mh-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;

let state: Settings = {
  server: DEFAULT_SERVER, token: "", showAdult: false, notify: true, theme: "system", style: "cinema", layout: "grid", subtitleScale: 1, sources: null, castTv: null,
  emby: { server: "", username: "", token: "", userId: "", deviceId: randomId() },
};
let loaded = false;
const listeners = new Set<() => void>();

export function getSettings(): Settings {
  return state;
}

export async function loadSettings(): Promise<Settings> {
  try {
    const raw = await store.get(KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<Settings>;
      state = { ...state, ...saved, emby: { ...state.emby, ...(saved.emby ?? {}) } };
    }
  } catch (e) {
    log.warn("load failed", e);
  }
  loaded = true;
  listeners.forEach((l) => l());
  return state;
}

export function setSettings(patch: Partial<Settings>) {
  state = { ...state, ...patch };
  if (patch.server !== undefined) state.server = state.server.trim().replace(/\/+$/, "");
  listeners.forEach((l) => l());
  void store.set(KEY, JSON.stringify(state)).catch((e) => log.warn("save failed", e));
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useSettings<T>(pick: (s: Settings) => T): T {
  return useSyncExternalStore(subscribe, () => pick(state));
}

export function useSettingsLoaded(): boolean {
  return useSyncExternalStore(subscribe, () => loaded);
}
