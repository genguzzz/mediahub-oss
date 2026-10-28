// OTA updates (expo-updates against our own server, your server /updates).
// The native client checks on every launch and applies a downloaded update on
// the next cold start; we also check when the app returns to the foreground and
// let the user restart right away from a banner.
import { AppState } from "react-native";
import * as Updates from "expo-updates";
import { logger } from "./log";

const log = logger("updates");

export const updatesEnabled = Updates.isEnabled;

// Short label for logs, request headers and Settings, e.g. "embedded" or "ota:3f2a9c1b".
export function runningLabel(): string {
  if (!Updates.isEnabled) return "dev";
  if (Updates.isEmbeddedLaunch || !Updates.updateId) return "embedded";
  return `ota:${Updates.updateId.slice(0, 8)}`;
}

export function logRunningUpdate() {
  log.info("running", {
    enabled: Updates.isEnabled,
    label: runningLabel(),
    updateId: Updates.updateId,
    embedded: Updates.isEmbeddedLaunch,
    createdAt: Updates.createdAt?.toISOString() ?? null,
    runtimeVersion: Updates.runtimeVersion,
  });
}

let lastCheck = 0;

// Check + download. Returns true when an update is downloaded and waiting for a restart.
export async function checkAndFetch(reason: string): Promise<boolean> {
  if (!Updates.isEnabled) return false;
  lastCheck = Date.now();
  try {
    const check = await Updates.checkForUpdateAsync();
    log.info("check", { reason, available: check.isAvailable });
    if (!check.isAvailable) return false;
    const res = await Updates.fetchUpdateAsync();
    log.info("fetched", { reason, isNew: res.isNew });
    return res.isNew;
  } catch (e) {
    log.warn("check/fetch failed", { reason, err: e });
    return false;
  }
}

export async function restartToApply() {
  log.info("reloading to apply update");
  try {
    await Updates.reloadAsync();
  } catch (e) {
    log.error("reload failed", e);
  }
}

// Foreground checks, at most every 10 minutes.
export function startForegroundChecks() {
  if (!Updates.isEnabled) return;
  AppState.addEventListener("change", (s) => {
    if (s === "active" && Date.now() - lastCheck > 10 * 60_000) void checkAndFetch("foreground");
  });
}

export const useUpdates = Updates.useUpdates;
