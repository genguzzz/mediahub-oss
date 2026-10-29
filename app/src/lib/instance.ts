// Per-instance defaults baked in at build time (app.config.ts `extra`, from APP_SERVER /
// APP_EMBY_SERVER). The user can still change both in Settings.
import Constants from "expo-constants";

const extra = (Constants.expoConfig?.extra ?? {}) as { server?: string; embyServer?: string };

export const DEFAULT_SERVER: string = extra.server || "https://media.example.com";
export const DEFAULT_EMBY_SERVER: string = extra.embyServer || "https://emby.example.com:8920";
