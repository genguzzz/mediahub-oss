// Deleting from the Emby library (管理 tab, item page). Always two steps: the backend's dry run says
// exactly what goes (library folders/files, 115 files), the user confirms that list, then the real
// delete runs. `files` decides whether the 115 originals behind the strm go too.
import { confirm, toast, toastError } from "@/components/ui";
import { api } from "./api";
import { logger } from "./log";
import { invalidate } from "./query";
import { track } from "./track";

const log = logger("libdelete");

interface Plan {
  ok: boolean;
  error?: string;
  item: { id: string; name: string; type: string };
  videos: number;
  libDirs: string[];
  libFiles: string[];
  remotes: string[];
  skipped: string[];
  errors?: string[];
}

const TYPE: Record<string, string> = { Movie: "电影", Series: "剧集", Season: "季", Episode: "单集", Video: "视频" };
const short = (p: string) => p.split("/").slice(-2).join("/");

export async function deleteFromLibrary(item: { id: string; name: string }, files: boolean, onDone?: () => void) {
  let plan: Plan;
  try {
    plan = await api<Plan>(`/v1/emby/item/${item.id}/delete`, { body: { files, dryRun: true }, timeoutMs: 120_000 });
    if (!plan.ok) throw new Error(plan.error || "未能生成删除计划");
  } catch (e) {
    toastError("未能删除", e);
    return;
  }
  const lib = [...plan.libDirs.map((d) => `目录 ${short(d)}`), ...plan.libFiles.filter((f) => f.endsWith(".strm")).map((f) => short(f))];
  const lines = [
    `${TYPE[plan.item.type] ?? plan.item.type}「${plan.item.name}」，${plan.videos} 个视频`,
    "",
    `媒体库：${lib.length ? "" : "（无文件）"}`,
    ...lib.slice(0, 6).map((l) => `· ${l}`),
    lib.length > 6 ? `…另 ${lib.length - 6} 项` : "",
    files ? `\n115 原文件 ${plan.remotes.length} 个：` : "\n115 原文件保留。",
    ...(files ? plan.remotes.slice(0, 5).map((r) => `· ${short(r)}`) : []),
    files && plan.remotes.length > 5 ? `…另 ${plan.remotes.length - 5} 个` : "",
    plan.skipped.length ? `\n${plan.skipped.length} 个不在 /115/Emby 下，不会删除` : "",
  ].filter((l) => l !== "");
  confirm(files ? "删除并删 115 原文件" : "从媒体库删除", lines.join("\n"), files ? "全部删除" : "删除", async () => {
    const t0 = Date.now();
    try {
      const r = await api<Plan>(`/v1/emby/item/${item.id}/delete`, { body: { files, dryRun: false }, timeoutMs: 180_000 });
      log.info("deleted", { id: item.id, type: plan.item.type, files, remotes: r.remotes?.length ?? 0, errors: r.errors?.length ?? 0, ms: Date.now() - t0 });
      track("library_delete", { type: plan.item.type, files, ok: r.ok, remotes: r.remotes?.length ?? 0 });
      invalidate("emby:");
      if (!r.ok) toast("部分未能删除", (r.errors ?? []).slice(0, 3).join("\n"), undefined, true);
      else toast("已删除", files ? `媒体库和 115 上的 ${r.remotes.length} 个文件` : "媒体库条目已删除，115 原文件保留");
      onDone?.();
    } catch (e) {
      toastError("未能删除", e);
    }
  }, true);
}
