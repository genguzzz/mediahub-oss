// Shared bits for 入库 tasks: the title line (work · season · episodes) and the two delete actions
// offered both on the list's long-press sheet and on the task screen.
import type { SheetAction } from "@/components/ActionSheet";
import { api, type Task } from "./api";

export function epText(eps?: number[]): string {
  if (!eps?.length) return "";
  const e = [...eps].sort((a, b) => a - b);
  if (e.length === 1) return `第 ${e[0]} 集`;
  return e[e.length - 1] - e[0] === e.length - 1 ? `第 ${e[0]}-${e[e.length - 1]} 集` : `第 ${e.join("、")} 集`;
}

export function taskTitle(t: Task): string {
  if (t.type !== "tv") return t.title;
  return [t.title, t.season ? `第 ${t.season} 季` : "", epText(t.episodes)].filter(Boolean).join(" · ");
}

async function del(hash: string, files: boolean) {
  const r = await api<{ ok: boolean; error?: string; removed?: string[] }>(`/v1/pipeline/${hash}/delete`, { body: { files }, timeoutMs: 130_000 });
  if (!r.ok) throw new Error(r.error || "删除失败");
  return r;
}

export function taskDeleteActions(t: Task, after: (msg: string) => void): SheetAction[] {
  const active = ["downloading", "buffer", "uploaded", "scraping"].includes(t.status);
  const stop = active ? "会先停止下载，" : "";
  return [
    {
      label: "删除任务", icon: "remove-circle-outline", note: "只删记录，115 和媒体库里的文件保留",
      confirm: { title: "删除任务", message: `${stop}只删这条任务记录和日志，115 上的文件和已生成的 strm 都保留。`, ok: "删除" },
      run: async () => { await del(t.hash, false); after("已删除任务"); },
    },
    {
      label: "删除任务和文件", icon: "trash-outline", destructive: true, note: "连 115 上的文件、strm 和字幕一起删",
      confirm: { title: "删除任务和文件", message: `${stop}这个任务下到 115 的文件、生成的 strm 和字幕、NAS 缓冲都会删掉，无法恢复。`, ok: "全部删除" },
      run: async () => { const r = await del(t.hash, true); after(`已删除任务和 ${r.removed?.length ?? 0} 项文件`); },
    },
  ];
}
