import { useState } from "react";
import { FlatList, ScrollView, Text, View } from "react-native";
import { Card, Chip, ChipRow, EmptyState, ErrorBox, Loading, PillButton, ProgressBar, Row, Segmented, Sheet, TAB_BAR_SPACE, Tag, confirm, styles, toast, toastError, Pull } from "@/components/ui";
import { api, type OfflineTask, type OlTask, type OpenListTasks, type QbTorrent } from "@/lib/api";
import { ago, bytes, eta, pct, speed } from "@/lib/format";
import { mutate, useQuery } from "@/lib/query";
import { colors } from "@/lib/theme";

type Tab = "115" | "qb" | "openlist";

// 管理 → 下载器: 115 offline, NAS qBittorrent and OpenList tasks.
export function DownloadsPanel() {
  const [tab, setTab] = useState<Tab>("115");
  return (
    <View style={{ flex: 1 }}>
      <Segmented
        value={tab}
        onChange={setTab}
        options={[{ value: "115", label: "115 离线" }, { value: "qb", label: "qBittorrent" }, { value: "openlist", label: "OpenList" }]}
        style={{ marginHorizontal: 16, marginBottom: 10 }}
      />
      {tab === "115" ? <Offline /> : tab === "qb" ? <Qb /> : <OpenList />}
    </View>
  );
}

const C115: Record<number, { text: string; color: () => string }> = {
  0: { text: "等待中", color: () => colors.textSoft },
  1: { text: "下载中", color: () => colors.primary },
  2: { text: "已完成", color: () => colors.success },
  [-1]: { text: "失败", color: () => colors.danger },
};

function Offline() {
  const q = useQuery("offline", () => api<{ tasks: OfflineTask[] }>("/v1/offline", { timeoutMs: 45_000 }), { interval: 15_000 });
  const [filter, setFilter] = useState<"all" | "active" | "done" | "failed">("active");
  const [now] = useState(() => Date.now());
  const all = q.data?.tasks ?? [];
  const list = all.filter((t) => (filter === "all" ? true : filter === "active" ? t.status === 0 || t.status === 1 : filter === "done" ? t.status === 2 : t.status === -1));
  const del = (t: OfflineTask) =>
    confirm("删除 115 离线任务", `${t.name}\n\n只删任务记录，已下到 115 的文件保留。要连文件一起删，请在「入库」里取消对应任务。`, "删除", async () => {
      try {
        await api("/v1/offline/delete", { body: { hashes: [t.hash] } });
        mutate<{ tasks: OfflineTask[] }>("offline", (d) => d && { tasks: d.tasks.filter((x) => x.hash !== t.hash) });
        toast("已删除任务");
      } catch (e) {
        toastError("未能删除", e);
      }
    }, true);
  return (
    <FlatList
      data={list}
      keyExtractor={(t) => t.hash}
      contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: TAB_BAR_SPACE, gap: 10 }}
      refreshControl={<Pull onRefresh={q.refresh} />}
      ListHeaderComponent={
        <>
          <ChipRow style={{ marginHorizontal: -16, marginBottom: 4 }}>
            {(["active", "done", "failed", "all"] as const).map((f) => (
              <Chip key={f} label={{ active: "进行中", done: "已完成", failed: "失败", all: "全部" }[f]} active={filter === f} onPress={() => setFilter(f)}
                count={all.filter((t) => (f === "all" ? true : f === "active" ? t.status === 0 || t.status === 1 : f === "done" ? t.status === 2 : t.status === -1)).length} />
            ))}
          </ChipRow>
          {q.error ? <ErrorBox text={q.error} onRetry={q.refresh} /> : null}
          {q.loading && !q.data ? <Loading text="正在读取 115 离线列表" /> : null}
        </>
      }
      ListEmptyComponent={q.data ? <EmptyState icon="cloud-done-outline" text="没有这类 115 离线任务" /> : undefined}
      renderItem={({ item: t }) => {
        const st = C115[t.status] ?? { text: String(t.status), color: () => colors.textSoft };
        return (
          <Card onLongPress={() => del(t)}>
            <Text style={styles.title} numberOfLines={2}>{t.name}</Text>
            <View style={{ flexDirection: "row", gap: 6, marginTop: 6 }}>
              <Tag text={st.text} color={st.color()} />
              {t.ours ? <Tag text="入库任务" color={colors.primary} /> : null}
            </View>
            {t.status !== 2 ? <View style={{ marginTop: 8 }}><ProgressBar value={t.percent} color={st.color()} /></View> : null}
            <Text style={[styles.faint, { marginTop: 6 }]}>{[pct(t.percent), bytes(t.size), t.rate ? speed(t.rate) : "", `添加于 ${ago(t.added, now)}`].filter(Boolean).join(" · ")}</Text>
            {t.dir ? <Text style={[styles.faint, { marginTop: 2 }]} numberOfLines={1}>{t.dir}</Text> : null}
          </Card>
        );
      }}
      ListFooterComponent={q.data ? <Text style={[styles.faint, { textAlign: "center", marginTop: 12 }]}>长按任务可删除</Text> : undefined}
    />
  );
}

const QB_STATE: Record<string, string> = {
  downloading: "下载中", stalledDL: "等待做种者", metaDL: "获取元数据", forcedDL: "强制下载", queuedDL: "排队",
  uploading: "做种", stalledUP: "做种（空闲）", queuedUP: "排队做种", forcedUP: "强制做种",
  pausedDL: "已暂停", stoppedDL: "已暂停", pausedUP: "已完成", stoppedUP: "已完成",
  checkingDL: "校验中", checkingUP: "校验中", checkingResumeData: "校验中", moving: "移动中", missingFiles: "文件丢失", error: "出错",
};

function Qb() {
  const [filter, setFilter] = useState<"all" | "downloading" | "completed" | "paused" | "errored">("all");
  const q = useQuery(`qb:${filter}`, () => api<{ torrents: QbTorrent[]; transfer: { dl_info_speed?: number; up_info_speed?: number } }>(`/v1/qb?filter=${filter}`), { interval: 5_000, staleMs: 3_000 });
  const [open, setOpen] = useState<QbTorrent | null>(null);
  const [now] = useState(() => Date.now());
  return (
    <>
      <FlatList
        data={q.data?.torrents ?? []}
        keyExtractor={(t) => t.hash}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: TAB_BAR_SPACE, gap: 10 }}
        refreshControl={<Pull onRefresh={q.refresh} />}
        ListHeaderComponent={
          <>
            <Text style={[styles.faint, { marginBottom: 6 }]}>NAS qBittorrent · 下行 {speed(q.data?.transfer.dl_info_speed)} · 上行 {speed(q.data?.transfer.up_info_speed)} · 入库缓冲用分类 mp115buffer</Text>
            <ChipRow style={{ marginHorizontal: -16, marginBottom: 4 }}>
              {(["all", "downloading", "completed", "paused", "errored"] as const).map((f) => (
                <Chip key={f} label={{ all: "全部", downloading: "下载中", completed: "已完成", paused: "已暂停", errored: "出错" }[f]} active={filter === f} onPress={() => setFilter(f)} />
              ))}
            </ChipRow>
            {q.error ? <ErrorBox text={q.error} onRetry={q.refresh} /> : null}
            {q.loading && !q.data ? <Loading /> : null}
          </>
        }
        ListEmptyComponent={q.data ? <EmptyState icon="cloud-download-outline" text="没有任务" /> : undefined}
        renderItem={({ item: t }) => (
          <Card onPress={() => setOpen(t)}>
            <Text style={styles.title} numberOfLines={2}>{t.name}</Text>
            <View style={{ flexDirection: "row", gap: 6, marginTop: 6 }}>
              <Tag text={QB_STATE[t.state] ?? t.state} color={t.state === "error" || t.state === "missingFiles" ? colors.danger : t.progress >= 1 ? colors.success : colors.primary} />
              {t.category ? <Tag text={t.category} color={colors.textSoft} /> : null}
            </View>
            {t.progress < 1 ? <View style={{ marginTop: 8 }}><ProgressBar value={t.progress * 100} /></View> : null}
            <Text style={[styles.faint, { marginTop: 6 }]}>
              {[pct(t.progress * 100), bytes(t.total_size || t.size), t.dlspeed ? `↓ ${speed(t.dlspeed)}` : "", t.upspeed ? `↑ ${speed(t.upspeed)}` : "", eta(t.eta), `${t.num_seeds} 做种`, ago(t.added_on, now)].filter(Boolean).join(" · ")}
            </Text>
          </Card>
        )}
      />
      <QbSheet t={open} onClose={() => setOpen(null)} onChanged={() => setTimeout(() => void q.refresh(), 1200)} />
    </>
  );
}

function QbSheet({ t, onClose, onChanged }: { t: QbTorrent | null; onClose: () => void; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  if (!t) return null;
  const paused = /^(paused|stopped)/.test(t.state);
  const run = async (action: "pause" | "resume" | "delete" | "recheck" | "reannounce", label: string, deleteFiles = false) => {
    setBusy(action);
    try {
      const r = await api<{ ok: boolean }>("/v1/qb/action", { body: { hashes: [t.hash], action, deleteFiles } });
      if (!r.ok) throw new Error("qBittorrent 拒绝了操作");
      toast(label);
      onChanged();
      onClose();
    } catch (e) {
      toastError("操作失败", e);
    } finally {
      setBusy(null);
    }
  };
  return (
    <Sheet visible={!!t} onClose={onClose} scroll>
      <Text selectable style={{ fontSize: 15, fontWeight: "600", color: colors.text, lineHeight: 21 }}>{t.name}</Text>
      <View style={{ marginTop: 8 }}>
        <Row label="状态" value={QB_STATE[t.state] ?? t.state} />
        <Row label="进度" value={`${pct(t.progress * 100)} / ${bytes(t.total_size || t.size)}`} />
        <Row label="分类" value={t.category} />
        <Row label="保存到" value={t.save_path} selectable />
        <Row label="分享率" value={t.ratio?.toFixed(2)} />
        <Row label="hash" value={t.hash} selectable />
      </View>
      <View style={{ gap: 10, marginTop: 14 }}>
        <PillButton icon={paused ? "play" : "pause"} label={paused ? "继续" : "暂停"} loading={busy === "pause" || busy === "resume"} onPress={() => run(paused ? "resume" : "pause", paused ? "已继续" : "已暂停")} />
        <View style={{ flexDirection: "row", gap: 10 }}>
          <PillButton small variant="soft" icon="checkmark-done-outline" label="重新校验" style={{ flex: 1 }} loading={busy === "recheck"} onPress={() => run("recheck", "已开始校验")} />
          <PillButton small variant="soft" icon="megaphone-outline" label="重新汇报" style={{ flex: 1 }} loading={busy === "reannounce"} onPress={() => run("reannounce", "已重新汇报")} />
        </View>
        <PillButton variant="soft" icon="remove-circle-outline" label="删除任务（保留文件）" loading={busy === "delete"} onPress={() => confirm("删除任务", "文件保留在 NAS 上。", "删除", () => void run("delete", "已删除任务"), true)} />
        <PillButton variant="danger" icon="trash-outline" label="删除任务和文件" onPress={() => confirm("删除任务和文件", "NAS 上已下载的文件会一起删除，无法恢复。", "删除", () => void run("delete", "已删除任务和文件", true), true)} />
      </View>
    </Sheet>
  );
}

const OL_KIND: Record<string, string> = { copy: "复制（NAS 缓冲 → 115 等）", upload: "上传", offline_download: "离线下载", offline_download_transfer: "离线下载转存" };

function OpenList() {
  const q = useQuery("openlist", () => api<OpenListTasks>("/v1/openlist", { timeoutMs: 45_000 }), { interval: 10_000 });
  const [showDone, setShowDone] = useState(false);
  const kinds = (["copy", "upload", "offline_download", "offline_download_transfer"] as const).filter((k) => q.data?.[k]);
  return (
    <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: TAB_BAR_SPACE }} refreshControl={<Pull onRefresh={q.refresh} />}>
      <Text style={[styles.faint, { marginBottom: 6 }]}>NAS OpenList 的后台任务。入库流水线用它把 NAS 缓冲的文件复制到 115。</Text>
      <ChipRow style={{ marginHorizontal: -16, marginBottom: 6 }}>
        <Chip label="未完成" active={!showDone} onPress={() => setShowDone(false)} />
        <Chip label="最近完成" active={showDone} onPress={() => setShowDone(true)} />
      </ChipRow>
      {q.error ? <ErrorBox text={q.error} onRetry={q.refresh} /> : null}
      {q.loading && !q.data ? <Loading /> : null}
      {q.data && kinds.every((k) => !(showDone ? q.data?.[k].done : q.data?.[k].undone)?.length) ? <EmptyState icon="swap-horizontal-outline" text={showDone ? "最近没有完成的任务" : "没有进行中的任务"} /> : null}
      {kinds.map((k) => {
        const list: OlTask[] = (showDone ? q.data?.[k].done : q.data?.[k].undone) ?? [];
        if (!list.length) return null;
        return (
          <View key={k} style={{ marginTop: 10, gap: 8 }}>
            <Text style={[styles.title, { color: colors.textSoft }]}>{OL_KIND[k]}</Text>
            {[...list].reverse().map((t) => (
              <Card key={t.id}>
                <Text style={{ fontSize: 13, color: colors.text, lineHeight: 18 }} numberOfLines={4}>{t.name}</Text>
                <View style={{ flexDirection: "row", gap: 6, marginTop: 6 }}>
                  <Tag text={t.error ? "出错" : t.status || String(t.state)} color={t.error ? colors.danger : showDone ? colors.success : colors.primary} />
                  {t.total ? <Tag text={bytes(t.total)} color={colors.textSoft} /> : null}
                </View>
                {!showDone ? <View style={{ marginTop: 8 }}><ProgressBar value={t.progress} /></View> : null}
                {t.error ? <Text style={[styles.faint, { marginTop: 4, color: colors.danger }]} numberOfLines={3}>{t.error}</Text> : null}
              </Card>
            ))}
          </View>
        );
      })}
    </ScrollView>
  );
}
