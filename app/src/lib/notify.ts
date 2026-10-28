// Local notifications for ingest results. The backend has no push (self-signed builds carry
// no APNs entitlement), so the app diffs the pipeline itself: on every foreground load and
// from a background task iOS runs every ~15 minutes or more.
import { Platform } from "react-native";
import * as BackgroundTask from "expo-background-task";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import * as TaskManager from "expo-task-manager";
import { api, type Pipeline } from "./api";
import { logger } from "./log";
import { getSettings, loadSettings } from "./settings";

const log = logger("notify");
const TASK = "mediahub-pipeline-check";
const SEEN_KEY = "mediahub.pipeline.seen";

export function installNotificationHandler() {
  if (Platform.OS === "web") return;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
  });
}

export async function ensureNotifyPermission(): Promise<boolean> {
  if (Platform.OS === "web") return false;
  const cur = await Notifications.getPermissionsAsync();
  if (cur.granted) return true;
  if (!cur.canAskAgain) return false;
  return (await Notifications.requestPermissionsAsync()).granted;
}

// Terminal state of a task as a short key: "ok", "fail" or "" (still running).
function outcome(t: Pipeline["tasks"][number]): string {
  if (t.failed) return "fail";
  if (t.status === "done" && (t.emby ?? 0) > 0) return "ok";
  return "";
}

// Compares with what was seen last time and returns what newly finished. First run only records.
export async function diffPipeline(p: Pipeline, notifyNow: boolean): Promise<number> {
  let seen: Record<string, string> | null = null;
  try {
    const raw = await SecureStore.getItemAsync(SEEN_KEY);
    seen = raw ? (JSON.parse(raw) as Record<string, string>) : null;
  } catch {
    seen = null;
  }
  const next: Record<string, string> = {};
  const fresh: { title: string; body: string }[] = [];
  for (const t of p.tasks) {
    const o = outcome(t);
    next[t.hash] = o;
    if (seen && o && seen[t.hash] !== o && seen[t.hash] !== undefined) {
      const name = `${t.title}${t.season && t.type === "tv" ? ` 第 ${t.season} 季` : ""}`;
      fresh.push(o === "ok" ? { title: `已入库：${name}`, body: `Emby 已刮削，${t.strm} 个文件` } : { title: `入库失败：${name}`, body: t.stage });
    }
  }
  for (const a of p.adult) {
    const k = `av:${a.code}`;
    const o = a.done ? "ok" : a.failed ? "fail" : "";
    next[k] = o;
    if (seen && o && seen[k] !== o && seen[k] !== undefined) fresh.push({ title: o === "ok" ? `已入库：${a.code}` : `刮削失败：${a.code}`, body: a.stage });
  }
  await SecureStore.setItemAsync(SEEN_KEY, JSON.stringify(next)).catch(() => {});
  if (notifyNow && getSettings().notify && fresh.length) {
    const items = fresh.length > 3 ? [{ title: `${fresh.length} 个任务有了结果`, body: fresh.map((f) => f.title).join("；").slice(0, 180) }] : fresh;
    for (const f of items) {
      await Notifications.scheduleNotificationAsync({ content: { title: f.title, body: f.body, data: { route: "/pipeline" } }, trigger: null }).catch((e) => log.warn("notify failed", e));
    }
  }
  return fresh.length;
}

if (Platform.OS !== "web") TaskManager.defineTask(TASK, async () => {
  try {
    const s = await loadSettings();
    if (!s.token || !s.notify) return BackgroundTask.BackgroundTaskResult.Success;
    const p = await api<Pipeline>("/v1/pipeline?limit=60", { timeoutMs: 25_000 });
    const n = await diffPipeline(p, true);
    log.info("background check", { tasks: p.tasks.length, fresh: n });
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch (e) {
    log.warn("background check failed", e);
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

export async function registerBackgroundCheck(): Promise<void> {
  if (Platform.OS === "web") return;
  try {
    const status = await BackgroundTask.getStatusAsync();
    if (status !== BackgroundTask.BackgroundTaskStatus.Available) return log.info("background unavailable", { status });
    if (!(await TaskManager.isTaskRegisteredAsync(TASK))) await BackgroundTask.registerTaskAsync(TASK, { minimumInterval: 15 });
  } catch (e) {
    log.warn("background register failed", e);
  }
}

export function onNotificationTap(go: (route: string) => void): () => void {
  if (Platform.OS === "web") return () => {};
  const sub = Notifications.addNotificationResponseReceivedListener((r) => {
    const route = (r.notification.request.content.data as { route?: string } | undefined)?.route;
    if (route) go(route);
  });
  return () => sub.remove();
}
