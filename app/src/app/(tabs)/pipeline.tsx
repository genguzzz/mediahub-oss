import { useEffect, useMemo, useState } from "react";
import { FlatList, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { ActionSheet, type SheetAction } from "@/components/ActionSheet";
import { Card, Chip, ChipRow, EmptyState, ErrorBox, IconButton, Loading, ProgressBar, Steps, TAB_BAR_SPACE, TabHeader, Tag, confirm, styles, tap, toast, toastError, Pull } from "@/components/ui";
import { api, pipelineQuery, type AdultRow, type EmbyActivity, type Task } from "@/lib/api";
import { ago, bytes, eta, pct, speed } from "@/lib/format";
import { diffPipeline } from "@/lib/notify";
import { mutate, useQuery } from "@/lib/query";
import { track } from "@/lib/track";
import { useSettings } from "@/lib/settings";
import { colors } from "@/lib/theme";

type Filter = "active" | "all" | "failed";
type Kind = "all" | "media" | "av" | "hentai";
const ms = (t: number | string | null | undefined) => (typeof t === "number" ? (t > 1e12 ? t : t * 1000) : t ? Date.parse(t.includes("T") || t.includes("Z") ? t : t.replace(" ", "T") + "+08:00") || 0 : 0);

export default function PipelineTab() {
  const router = useRouter();
  const showAdult = useSettings((s) => s.showAdult);
  const q = useQuery("pipeline", pipelineQuery, { interval: 10_000, staleMs: 5_000 });
  const emby = useQuery("emby:activity", () => api<EmbyActivity>("/v1/emby/activity"), { interval: 20_000 });
  const [filter, setFilter] = useState<Filter>("active");
  const [kind, setKind] = useState<Kind>("all");
  const [now, setNow] = useState(() => Date.now());
  const [sheet, setSheet] = useState<{ title: string; message?: string; actions: SheetAction[] } | null>(null);

  useEffect(() => {
    if (q.data) void diffPipeline(q.data, false);
  }, [q.data]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const rows = useMemo(() => {
    const tasks = q.data?.tasks ?? [];
    const pick = (t: Task) =>
      filter === "all" ? true : filter === "failed" ? t.failed : ["downloading", "buffer", "uploaded", "scraping"].includes(t.status) || (t.status === "done" && !t.emby);
    const adult = (q.data?.adult ?? []).filter((a) => (filter === "all" ? true : filter === "failed" ? a.failed : !a.done || Date.now() - ms(a.at) < 6 * 3600_000));
    const out: (Task | AdultRow)[] = [];
    // 影视 / AV / 里番 are tasks of the same pipeline; adult ones only with 成人内容 on
    const cat = (t: Task) => t.category ?? "media";
    out.push(...tasks.filter(pick).filter((t) => (cat(t) === "media" ? kind !== "av" && kind !== "hentai" : showAdult && (kind === "all" || kind === cat(t)))));
    if (showAdult && kind !== "media") out.push(...adult);
    const at = (x: Task | AdultRow) => ms(x.kind === "media" ? x.added : x.at);
    return out.sort((a, b) => at(b) - at(a));
  }, [q.data, filter, kind, showAdult]);

  const running = emby.data?.running ?? [];
  const counts = useMemo(() => {
    const t = q.data?.tasks ?? [];
    return {
      active: t.filter((x) => ["downloading", "buffer", "uploaded", "scraping"].includes(x.status) || (x.status === "done" && !x.emby)).length,
      failed: t.filter((x) => x.failed).length,
    };
  }, [q.data]);

  const runNow = async () => {
    try {
      await api("/v1/pipeline/run", { method: "POST", body: {} });
      toast("已开始推进", "插件会立即检查 115 进度、生成 strm 并确认刮削");
      setTimeout(() => void q.refresh(), 4000);
    } catch (e) {
      toastError("未能推进", e);
    }
  };

  const done = (msg: string) => {
    toast(msg);
    setTimeout(() => void q.refresh(), 1500);
  };

  // AV rows: what can be done depends on where the work is.
  const avActions = (a: AdultRow) => {
    track("av_row_actions", { step: a.step ?? "?" });
    const cancel = (files: boolean) => async () => {
      const r = await api<{ ok: boolean; error?: string; files?: string[]; warn?: string }>("/v1/av/cancel", { body: { key: a.key, files } });
      if (!r.ok) throw new Error(r.error || "未能取消");
      mutate<typeof q.data>("pipeline", (d) => (d ? { ...d, adult: d.adult.filter((x) => x.key !== a.key) } : d));
      done(files && r.files?.length ? `已取消并删除 ${r.files.length} 项 115 文件` : r.warn ? `已移除，但${r.warn}` : "已移除");
    };
    const actions: SheetAction[] = [];
    if (a.step !== "done") actions.push({ label: "立即处理", icon: "play-forward-outline", note: "现在就检查 115、生成 strm、提交刮削并整理，不等 5 分钟一轮", run: async () => { await api("/v1/pipeline/run", { method: "POST", body: {} }); done("已开始处理"); } });
    if (a.step === "scrape") actions.push({ label: "重新刮削", icon: "refresh", note: "重新交给 MDC 刮削并入库", run: async () => { await api("/v1/av/retry", { body: a.strm ? { name: a.strm } : {} }); done("已重新提交刮削"); } });
    if (a.step === "offline") {
      actions.push({ label: "取消离线任务", icon: "close-circle-outline", note: "删除 115 离线任务，已下的文件保留", run: cancel(false) });
      actions.push({ label: "取消并删除已下文件", icon: "trash-outline", destructive: true, note: "连 115 下载目录里的文件一起删",
        confirm: { title: "取消并删除", message: `删除 ${a.code} 的 115 离线任务和已下载的文件。`, ok: "删除" }, run: cancel(true) });
    } else if (a.step === "scrape") {
      actions.push({ label: "移除这条记录", icon: "remove-circle-outline", note: "删收件箱 strm，115 原片保留", run: cancel(false) });
      actions.push({ label: "删除记录和 115 原片", icon: "trash-outline", destructive: true,
        confirm: { title: "删除 115 原片", message: `删除 ${a.code} 的 strm 和 115 上的原片：
${a.key}`, ok: "删除" }, run: cancel(true) });
    } else if (a.step === "done") {
      actions.push({ label: "从列表移除", icon: "eye-off-outline", note: "只移除这条记录；删库里的作品请到 管理 → 媒体库", run: cancel(false) });
    }
    setSheet({ title: a.code, message: [a.stage, a.error, a.name !== a.code ? a.name : ""].filter(Boolean).join("\n"), actions });
  };

  // Media tasks: cancel while moving, remove the record once ended.
  const taskActions = (t: Task) => {
    const active = ["downloading", "buffer", "uploaded"].includes(t.status) && !(t.status === "uploaded" && t.emby);
    const actions: SheetAction[] = [{ label: "查看详情", icon: "information-circle-outline", run: () => router.push({ pathname: "/task/[hash]", params: { hash: t.hash } }) }];
    if (t.status === "downloading") {
      actions.push({ label: "改用 NAS 缓冲", icon: "server-outline", note: t.stalled ? "115 离线下载不动" : "用 NAS 上的 qBittorrent 下载，下完一个文件传一个到 115",
        run: async () => { await api(`/v1/pipeline/${t.hash}/retry`, { body: { mode: "buffer" } }); done("已改用 NAS 缓冲"); } });
    }
    if ((t.tmdbid || (t.category && t.category !== "media")) && (active || t.failed)) {
      actions.push({ label: "换一个资源", icon: "swap-horizontal", note: "在任务详情里挑选",
        run: () => router.push({ pathname: "/task/[hash]", params: { hash: t.hash, reselect: "1" } }) });
    }
    if (active) {
      actions.push({ label: "取消任务", icon: "close-circle-outline", destructive: true,
        confirm: { title: "取消任务", message: "会删除 115 离线任务和已下到 115 的文件；缓冲中的连 qB 种子和本地文件一起删。已生成的 strm 不动。", ok: "取消任务" },
        run: async () => { await api(`/v1/pipeline/${t.hash}/cancel`, { body: {} }); done("已取消"); } });
    } else {
      actions.push({ label: "从列表移除", icon: "eye-off-outline", note: "只删这条任务记录，不动文件和媒体库",
        run: async () => {
          await api("/v1/pipeline/remove", { body: { hashes: [t.hash] } });
          mutate<typeof q.data>("pipeline", (d) => (d ? { ...d, tasks: d.tasks.filter((x) => x.hash !== t.hash) } : d));
          done("已移除");
        } });
    }
    setSheet({ title: t.title, message: [t.stage, t.name || t.dir].filter(Boolean).join("\n"), actions });
  };

  const ended = (q.data?.tasks ?? []).filter((t) => t.status === "cancelled" || (t.status === "done" && (t.emby ?? 0) > 0));
  const clearEnded = () =>
    confirm("清除已结束的记录", `从列表移除 ${ended.length} 条已完成或已取消的任务记录。文件和媒体库不受影响。`, "清除", async () => {
      try {
        const r = await api<{ removed: string[] }>("/v1/pipeline/remove", { body: { hashes: ended.map((t) => t.hash).slice(0, 200) } });
        done(`已移除 ${r.removed.length} 条`);
      } catch (e) {
        toastError("未能清除", e);
      }
    });

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <TabHeader title="入库" sub="提交 → 115 离线 / NAS 缓冲 → 生成 strm → Emby 刮削 → 完成" right={<IconButton name="play-forward-outline" label="立即推进" onPress={runNow} />} />
      <ChipRow style={{ marginBottom: 8 }}>
        <Chip label="进行中" count={counts.active} active={filter === "active"} onPress={() => setFilter("active")} />
        <Chip label="失败" count={counts.failed} active={filter === "failed"} onPress={() => setFilter("failed")} />
        <Chip label="全部" active={filter === "all"} onPress={() => setFilter("all")} />
        {showAdult ? (
          <>
            <Chip label="影视" icon="film-outline" active={kind === "media"} onPress={() => setKind(kind === "media" ? "all" : "media")} />
            <Chip label="AV" icon="flame-outline" active={kind === "av"} onPress={() => setKind(kind === "av" ? "all" : "av")} />
            <Chip label="里番" icon="sparkles-outline" active={kind === "hentai"} onPress={() => setKind(kind === "hentai" ? "all" : "hentai")} />
          </>
        ) : null}
        {filter === "all" && ended.length ? <Chip label="清除已结束" icon="trash-outline" onPress={clearEnded} /> : null}
      </ChipRow>
      <FlatList
        data={rows}
        keyExtractor={(t) => ("hash" in t && t.kind === "media" ? t.hash : `av:${(t as AdultRow).key ?? `${(t as AdultRow).code}:${(t as AdultRow).stage}`}`)}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: TAB_BAR_SPACE }}
        refreshControl={<Pull onRefresh={() => { void q.refresh(); void emby.refresh(); }} />}
        ListHeaderComponent={
          <>
            {q.error ? <ErrorBox text={q.error} onRetry={q.refresh} /> : null}
            {running.map((r) => (
              <Card key={r.id} muted style={{ marginBottom: 10 }} onPress={() => router.push("/library")}>
                <Text style={styles.title}>Emby 正在{r.name === "Scan media library" ? "扫描媒体库" : `运行：${r.name}`}</Text>
                <View style={{ marginTop: 8 }}><ProgressBar value={r.progress} /></View>
                <Text style={[styles.faint, { marginTop: 4 }]}>{pct(r.progress)}</Text>
              </Card>
            ))}
            {q.loading && !q.data ? <Loading text="正在读取任务和 115 进度" /> : null}
          </>
        }
        ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
        ListEmptyComponent={q.data ? <EmptyState icon="checkmark-done-outline" text={filter === "failed" ? "没有失败的任务" : filter === "active" ? "没有进行中的任务。新的下载会出现在这里。" : "还没有任务"} /> : undefined}
        renderItem={({ item }) =>
          item.kind === "media" ? (
            <TaskCard t={item} now={now} onPress={() => router.push({ pathname: "/task/[hash]", params: { hash: item.hash } })} onLongPress={() => taskActions(item)} />
          ) : (
            <AdultCard a={item} now={now} onPress={item.key ? () => avActions(item) : undefined} />
          )
        }
      />
      <ActionSheet visible={!!sheet} onClose={() => setSheet(null)} title={sheet?.title ?? ""} message={sheet?.message} actions={sheet?.actions ?? []} />
    </View>
  );
}

function TaskCard({ t, now, onPress, onLongPress }: { t: Task; now: number; onPress: () => void; onLongPress: () => void }) {
  const moving = t.status === "downloading" || t.status === "buffer";
  const color = t.failed ? colors.danger : t.status === "done" && (t.emby ?? 0) > 0 ? colors.success : colors.primary;
  return (
    <Card onPress={onPress} onLongPress={() => { tap(); onLongPress(); }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={[styles.title, { flex: 1 }]} numberOfLines={1}>{t.title}{t.type === "tv" && t.season ? ` · 第 ${t.season} 季` : ""}</Text>
        <Tag text={t.category === "av" ? "AV" : t.category === "hentai" ? "里番" : "影视"} color={t.category && t.category !== "media" ? colors.warning : colors.primary} />
        <Text style={styles.faint}>{ago(t.added, now)}</Text>
      </View>
      <Text style={[styles.faint, { marginTop: 3 }]} numberOfLines={1}>{t.name || t.dir}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8 }}>
        <Tag text={t.stage} color={color} />
        {t.stalled && moving ? <Tag text="下载不动" color={colors.warning} solid /> : null}
        {t.buffer ? <Tag text="NAS 缓冲" color={colors.warning} /> : null}
        {t.strm ? <Tag text={`${t.strm} 个 strm`} color={colors.textSoft} /> : null}
      </View>
      {moving ? (
        <View style={{ marginTop: 10, gap: 4 }}>
          <ProgressBar value={t.percent} />
          <Text style={styles.faint}>{[pct(t.percent), t.size ? bytes(t.size) : "", t.rate ? speed(t.rate) : "", eta(t.eta)].filter(Boolean).join(" · ")}</Text>
        </View>
      ) : null}
      <View style={{ marginTop: 12 }}>
        <Steps steps={t.steps} />
      </View>
    </Card>
  );
}

function AdultCard({ a, now, onPress }: { a: AdultRow; now: number; onPress?: () => void }) {
  return (
    <Card onPress={onPress}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={[styles.title, { flex: 1 }]}>{a.code}</Text>
        <Tag text="AV" color={colors.warning} />
        <Text style={styles.faint}>{ago(a.at, now)}</Text>
      </View>
      <View style={{ flexDirection: "row", gap: 6, marginTop: 6 }}>
        <Tag text={a.stage} color={a.failed ? colors.danger : a.done ? colors.success : colors.primary} />
        {a.name && a.name !== a.code ? <Text style={[styles.faint, { flex: 1 }]} numberOfLines={1}>{a.name}</Text> : null}
      </View>
      {a.steps ? <View style={{ marginTop: 10 }}><Steps steps={a.steps} /></View> : null}
      {a.percent !== undefined && a.percent !== null && !a.done ? <View style={{ marginTop: 8 }}><ProgressBar value={a.percent} /></View> : null}
      {a.error ? <Text style={[styles.faint, { marginTop: 4, color: colors.danger }]}>{a.error}</Text> : null}
    </Card>
  );
}
