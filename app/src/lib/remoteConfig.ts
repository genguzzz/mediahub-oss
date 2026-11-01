// Remote config (server/src/appConfig.ts): settings the server can override without an app release. The last
// config is kept on disk so it applies from the first frame; the server sends `x-config-version` with every
// answer (api.ts → noteConfigVersion) and the app refetches /v1/config only when that changes. DEFAULTS mirror
// the server's schema and apply until the first fetch or when the server is unreachable.
import { useSyncExternalStore } from "react";
import { Platform } from "react-native";
import { File, Paths } from "expo-file-system";
import { logger } from "./log";

const log = logger("config");

export interface AppConfig {
  cacheMaxAgeSec: number | null;
  defaultSources: string[];
  aiOrb: boolean;
  hiddenDiscoverSections: string[];
}

const DEFAULTS: AppConfig = {
  cacheMaxAgeSec: null,
  defaultSources: ["nyaa", "animetosho", "mikan", "dmhy", "prowlarr"],
  aiOrb: true,
  hiddenDiscoverSections: [],
};

const store = Platform.OS === "web" ? null : new File(Paths.document, "remote-config.json");
let state: { version: number; values: AppConfig } = (() => {
  try {
    if (store?.exists) {
      const s = JSON.parse(store.textSync()) as { version: number; values: Partial<AppConfig> };
      return { version: s.version, values: { ...DEFAULTS, ...s.values } };
    }
  } catch {
    // a corrupt file is no config
  }
  return { version: 0, values: DEFAULTS };
})();

const listeners = new Set<() => void>();
let fetching: Promise<void> | null = null;

async function refresh() {
  fetching ??= (async () => {
    try {
      const { api } = await import("./api");
      const r = await api<{ version: number; values: Partial<AppConfig> }>("/v1/config");
      state = { version: r.version, values: { ...DEFAULTS, ...r.values } };
      listeners.forEach((l) => l());
      try {
        if (store && !store.exists) store.create({ intermediates: true });
        store?.write(JSON.stringify(state));
      } catch {
        // memory only
      }
      log.info("config", { version: r.version });
    } catch (e) {
      log.warn("config fetch failed", e);
    } finally {
      fetching = null;
    }
  })();
  return fetching;
}

/** Called with every API answer's x-config-version: a different version fetches the config. */
export function noteConfigVersion(header: string | null) {
  const v = Number(header);
  if (v && v !== state.version && !fetching) void refresh();
}

export function getConfig(): AppConfig {
  return state.values;
}

export function useConfig(): AppConfig {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state.values,
  );
}
