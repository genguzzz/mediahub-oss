import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import Animated, { FadeIn, FadeOut, LinearTransition } from "react-native-reanimated";
import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Card, CopyText, ErrorBox, Loading, PillButton, Poster, ProgressBar, Row, Screen, SectionTitle, Sheet, TopBar, confirm, styles, tap, toast, toastError } from "@/components/ui";
import { api, img, pipelineQuery, type MediaBrief, type Step, type TaskEvent } from "@/lib/api";
import { ago, bytes, clock, dur, eta, pct, speed } from "@/lib/format";
import { useQuery } from "@/lib/query";
import { colors } from "@/lib/theme";

const STEP_HINT: Record<string, string> = {
  submit: "磁力已交给插件，按 TMDb 识别结果算好 115 目录",
  download: "115 离线下载；提交失败、6 小时 0% 或任务丢失时改用 NAS qBittorrent 缓冲，下完一个文件传一个到 115",
  strm: "只处理本任务的种子目录（排除特典），生成 OpenList 签名直链 strm、拷外挂字幕、替换旧版本",
  scrape: "通知 Emby 扫描，确认条目有 TMDb ID 和海报；没中文字幕的动画会在后台从 sub_share 补字幕",
  finish: "Emby 已刮削，可以播放",
};

export default function TaskScreen() {
  const { hash } = useLocalSearchParams<{ hash: string }>();
  const router = useRouter();
  const q = useQuery("pipeline", pipelineQuery, { interval: 8_000, staleMs: 4_000 });
  const t = q.data?.tasks.find((x) => x.hash === hash);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState<string | null>(null);
  const [retarget, setRetarget] = useState(false);
  const running = !!t && t.steps.some((s) => s.state === "active");
  // Event log: refetched with the task while something is still running.
  const ev = useQuery(hash ? `task:ev:${hash}` : null, () => api<{ events: TaskEvent[] }>(`/v1/pipeline/${hash}/events`), { interval: running ? 10_000 : undefined, staleMs: 5_000 });
  const events = ev.data?.events ?? [];
  // Live clock for the running step's duration.
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);

  const act = async (label: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(label);
    try {
      await fn();
      toast(done);
      setTimeout(() => void q.refresh(), 2500);
    } catch (e) {
      toastError(`未能${label}`, e);
    } finally {
      setBusy(null);
    }
  };
  const retry = (mode: "strm" | "buffer" | "offline", label: string) =>
    act(label, () => api(`/v1/pipeline/${hash}/retry`, { body: { mode } }), `已${label}，后台推进中`);

  const openInLibrary = async () => {
    if (!t?.tmdbid) return;
    try {
      const lib = await api<{ library?: { found: boolean; id?: string } | null }>(`/v1/media/${t.type}/${t.tmdbid}`);
      if (lib.library?.found && lib.library.id) router.push({ pathname: "/emby/[id]", params: { id: lib.library.id } });
      else toast("媒体库里还没有这个条目", "Emby 可能还在扫描", undefined, true);
    } catch (e) {
      toastError("未能打开", e);
    }
  };

  return (
    <Screen>
      <TopBar title={t?.title ?? "任务"} />
      {q.error ? <ErrorBox text={q.error} onRetry={q.refresh} /> : null}
      {!t && q.loading ? <Loading /> : null}
      {!t && q.data ? <ErrorBox text="最近的任务里没有它（可能太早了）" /> : null}
      {t ? (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
          <Text style={styles.h2}>{t.title}{t.type === "tv" && t.season ? ` · 第 ${t.season} 季` : ""}</Text>
          <Text style={[styles.body, { marginTop: 4, color: t.failed ? colors.danger : colors.primary, fontWeight: "600" }]}>{t.stage}</Text>
          {t.status === "downloading" || t.status === "buffer" ? (
            <View style={{ marginTop: 12, gap: 4 }}>
              <ProgressBar value={t.percent} height={8} />
              <Text style={styles.faint}>{[pct(t.percent), t.size ? bytes(t.size) : "", t.rate ? speed(t.rate) : "", eta(t.eta)].filter(Boolean).join(" · ")}</Text>
            </View>
          ) : null}

          <Summary steps={t.steps} now={now} />

          <SectionTitle title="进度" right={<Text style={styles.faint}>点步骤看日志</Text>} />
          <Card>
            {t.steps.map((s, i) => (
              <StepRow
                key={s.key}
                s={s}
                now={now}
                last={i === t.steps.length - 1}
                open={open === s.key}
                events={events.filter((e) => e.group === s.key)}
                onPress={() => { tap(); setOpen(open === s.key ? null : s.key); }}
              />
            ))}
          </Card>

          {t.buffer ? (
            <>
              <SectionTitle title="NAS 缓冲" />
              <Card>
                <Row label="原因" value={t.buffer.reason} />
                <Row label="开始" value={ago(t.buffer.since, now)} />
                <Row label="已传 115" value={`${t.buffer.uploaded} 个文件`} />
                {t.buffer.uploading.length ? <Row label="上传中" value={t.buffer.uploading.join("\n")} /> : null}
              </Card>
            </>
          ) : null}

          <SectionTitle title="详情" />
          <Card>
            <Row label="种子" value={t.name} />
            <Row label="115 目录" value={t.dir} />
            <Row label="提交" value={`${clock(t.added, now)}（${ago(t.added, now)}）`} />
            <Row label="入库" value={t.done ? `${clock(t.done, now)}（${ago(t.done, now)}）` : ""} />
            <Row label="Emby 确认" value={t.emby && t.emby > 0 ? `${clock(t.emby, now)}（${ago(t.emby, now)}）` : t.emby && t.emby < 0 ? "3 小时内没刮削上" : "等待中"} />
            <Row label="strm" value={t.strm ? `${t.strm} 个` : ""} />
            <Row label="hash" value={t.hash} onPress={async () => { await Clipboard.setStringAsync(t.hash); toast("已复制 hash"); }} />
          </Card>

          <SectionTitle
            title="完整日志"
            right={events.length ? (
              <Pressable onPress={async () => { await Clipboard.setStringAsync(events.map((e) => `${clock(e.at, now)} [${e.step}] ${e.msg}`).join("\n")); toast("已复制日志"); }}>
                <Text style={{ color: colors.primary, fontWeight: "600" }}>复制</Text>
              </Pressable>
            ) : undefined}
          />
          <Card>
            {ev.loading && !ev.data ? <Loading /> : null}
            {ev.error ? <Text style={[styles.faint, { color: colors.danger }]}>{ev.error}</Text> : null}
            {ev.data && !events.length ? <Text style={styles.faint}>还没有日志</Text> : null}
            {events.map((e, i) => <EventLine key={i} e={e} now={now} showStep />)}
          </Card>

          <SectionTitle title="操作" />
          <View style={{ gap: 10 }}>
            {t.tmdbid ? <PillButton variant="soft" icon="albums-outline" label="在媒体库中查看" onPress={openInLibrary} /> : null}
            {["done", "uploaded", "superseded", "needs-id"].includes(t.status) ? (
              <PillButton variant="soft" icon="swap-horizontal" label="认错作品了？改为另一部" onPress={() => setRetarget(true)} />
            ) : null}
            <PillButton variant="soft" icon="refresh" label="重新生成 strm 并刮削" loading={busy === "重试入库"} onPress={() => retry("strm", "重试入库")} />
            {t.status === "downloading" ? <PillButton variant="soft" icon="server-outline" label="改用 NAS 缓冲下载" loading={busy === "改用缓冲"} onPress={() => retry("buffer", "改用缓冲")} /> : null}
            {t.failed || t.status === "buffer" ? <PillButton variant="soft" icon="cloud-upload-outline" label="重新提交 115 离线" loading={busy === "重新提交"} onPress={() => retry("offline", "重新提交")} /> : null}
            <PillButton
              variant="danger"
              icon="trash-outline"
              label="取消任务"
              loading={busy === "取消"}
              onPress={() => confirm("取消任务", "会删除 115 离线任务和已下到 115 的文件；缓冲中的连 qB 种子和本地文件一起删。已生成的 strm 不动。", "取消任务", () => void act("取消", () => api(`/v1/pipeline/${hash}/cancel`, { body: {} }), "已取消"), true)}
            />
          </View>
        </ScrollView>
      ) : null}
      {t ? (
        <RetargetSheet
          visible={retarget}
          hash={t.hash}
          title={t.title}
          type={t.type}
          onClose={() => setRetarget(false)}
          onDone={() => { setRetarget(false); void q.refresh(); void ev.refresh(); }}
        />
      ) : null}
    </Screen>
  );
}

const LEVEL_COLOR = { info: colors.textSoft, notice: colors.primary, warn: colors.warning, error: colors.danger };
const STEP_NAME: Record<string, string> = { submit: "提交", offline: "115", buffer: "缓冲", strm: "strm", subs: "字幕", emby: "Emby", manual: "手动" };

// Total time and the slowest step, so a stuck task is obvious at a glance.
function Summary({ steps, now }: { steps: Step[]; now: number }) {
  const first = steps[0]?.start;
  const fin = steps[steps.length - 1];
  const end = fin?.state === "done" ? fin.end : null;
  if (!first) return null;
  const total = (end ?? now / 1000) - first;
  const spans = steps.slice(1, 4).map((s) => ({ s, d: s.start ? (s.end ?? (s.state === "active" ? now / 1000 : NaN)) - s.start : NaN })).filter((x) => Number.isFinite(x.d));
  const slow = spans.sort((a, b) => b.d - a.d)[0];
  return (
    <View style={{ flexDirection: "row", gap: 10, marginTop: 14 }}>
      <View style={{ flex: 1, padding: 12, borderRadius: 14, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border }}>
        <Text style={styles.faint}>{end ? "总用时" : "已进行"}</Text>
        <Text style={{ fontSize: 20, fontWeight: "800", color: colors.text, marginTop: 2 }}>{dur(total)}</Text>
      </View>
      {slow ? (
        <View style={{ flex: 1, padding: 12, borderRadius: 14, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border }}>
          <Text style={styles.faint}>最慢的一步</Text>
          <Text style={{ fontSize: 15, fontWeight: "700", color: colors.text, marginTop: 4 }} numberOfLines={1}>{slow.s.label} · {dur(slow.d)}</Text>
        </View>
      ) : null}
    </View>
  );
}

function EventLine({ e, now, showStep }: { e: TaskEvent; now: number; showStep?: boolean }) {
  return (
    <View style={{ flexDirection: "row", gap: 8, paddingVertical: 4 }}>
      <Text style={{ fontSize: 12, color: colors.textFaint, width: showStep ? 78 : 44, fontVariant: ["tabular-nums"] }}>{clock(e.at, now)}</Text>
      {showStep ? <Text style={{ fontSize: 12, color: colors.textFaint, width: 34 }}>{STEP_NAME[e.step] ?? e.step}</Text> : null}
      <CopyText style={{ flex: 1, fontSize: 12.5, lineHeight: 18, color: LEVEL_COLOR[e.level] ?? colors.textSoft }}>{e.msg}</CopyText>
    </View>
  );
}

function StepRow({ s, last, now, open, events, onPress }: { s: Step; last: boolean; now: number; open: boolean; events: TaskEvent[]; onPress: () => void }) {
  const color = { done: colors.success, active: colors.primary, pending: colors.textFaint, error: colors.danger, skipped: colors.textFaint }[s.state];
  const icon = { done: "checkmark-circle", active: "ellipse", pending: "ellipse-outline", error: "close-circle", skipped: "remove-circle-outline" }[s.state] as keyof typeof Ionicons.glyphMap;
  const span = s.start ? (s.end ?? (s.state === "active" ? now / 1000 : null)) : null;
  const d = s.start && span ? span - s.start : null;
  const instant = s.key === "submit" || s.key === "finish";
  const time = s.start ? (instant ? clock(s.start, now) : `${clock(s.start, now)}${s.end ? ` → ${clock(s.end, now)}` : " 起"}`) : "";
  return (
    <Animated.View layout={LinearTransition.duration(220)}>
      <Pressable onPress={onPress} style={({ pressed }) => ({ flexDirection: "row", gap: 12, opacity: pressed ? 0.75 : 1 })}>
        <View style={{ alignItems: "center" }}>
          <Ionicons name={icon} size={20} color={color} />
          {!last ? <View style={{ width: 2, flex: 1, minHeight: 18, backgroundColor: s.state === "done" ? colors.success : colors.border }} /> : null}
        </View>
        <View style={{ flex: 1, paddingBottom: last ? 0 : 14 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Text style={{ fontSize: 15, fontWeight: "600", color: s.state === "pending" || s.state === "skipped" ? colors.textSoft : colors.text }}>{s.label}</Text>
            {s.warn ? <Ionicons name="warning" size={13} color={colors.warning} /> : null}
            <View style={{ flex: 1 }} />
            {d !== null && !instant ? (
              <View style={{ paddingHorizontal: 7, height: 20, borderRadius: 10, justifyContent: "center", backgroundColor: (s.state === "active" ? colors.primary : colors.textSoft) + "1f" }}>
                <Text style={{ fontSize: 11.5, fontWeight: "700", color: s.state === "active" ? colors.primary : colors.textSoft, fontVariant: ["tabular-nums"] }}>{dur(d)}</Text>
              </View>
            ) : null}
            <Ionicons name={open ? "chevron-up" : "chevron-down"} size={14} color={colors.textFaint} />
          </View>
          {time ? <Text style={{ fontSize: 12, color: colors.textFaint, marginTop: 2, fontVariant: ["tabular-nums"] }}>{time}{s.events ? ` · ${s.events} 条日志` : ""}</Text> : null}
          {!open ? (
            <Text style={[styles.faint, { marginTop: 2, lineHeight: 17 }]} numberOfLines={2}>{s.last || STEP_HINT[s.key]}</Text>
          ) : (
            <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(120)} style={{ marginTop: 6, padding: 10, borderRadius: 10, backgroundColor: colors.cardMuted }}>
              <Text style={[styles.faint, { marginBottom: 4 }]}>{STEP_HINT[s.key]}</Text>
              {events.length ? events.map((e, i) => <EventLine key={i} e={e} now={now} />) : <Text style={styles.faint}>这一步没有日志</Text>}
            </Animated.View>
          )}
        </View>
      </Pressable>
    </Animated.View>
  );
}

// Move a task that landed under the wrong work: search TMDb, dry-run to show the move, then do it.
function RetargetSheet({ visible, hash, title, type, onClose, onDone }: { visible: boolean; hash: string; title: string; type: "movie" | "tv"; onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState(title.replace(/[《》「」]/g, " ").trim());
  const [term, setTerm] = useState(text);
  const q = useQuery(visible && term ? `media:search:${term}` : null, () => api<{ items: MediaBrief[] }>(`/v1/media/search?q=${encodeURIComponent(term)}`), { staleMs: 60_000 });
  const [busy, setBusy] = useState<number | null>(null);
  const pick = async (m: MediaBrief) => {
    const id = m.tmdbid;
    if (!id) return;
    setBusy(id);
    try {
      const body = { tmdbid: id, type: m.type, dryRun: true };
      const plan = await api<{ ok: boolean; error?: string; from?: string; dir?: string }>(`/v1/pipeline/${hash}/retarget`, { body });
      if (!plan.ok) throw new Error(plan.error || "不能改");
      setBusy(null);
      confirm("改为另一部作品", `把这个任务的文件从\n${plan.from}\n移到\n${plan.dir}\n\n会删掉指向它的旧 strm，再重新生成并通知 Emby。`, "移动", async () => {
        setBusy(id);
        try {
          const r = await api<{ ok: boolean; error?: string }>(`/v1/pipeline/${hash}/retarget`, { body: { ...body, dryRun: false }, timeoutMs: 130_000 });
          if (!r.ok) throw new Error(r.error || "移动失败");
          toast("已移动", "后台重新生成 strm 中");
          onDone();
        } catch (e) {
          toastError("未能移动", e);
        } finally {
          setBusy(null);
        }
      });
    } catch (e) {
      setBusy(null);
      toastError("未能改作品", e);
    }
  };
  const items = (q.data?.items ?? []).filter((m) => m.type === type);
  return (
    <Sheet visible={visible} onClose={onClose} title="改为另一部作品" scroll>
      <TextInput
        value={text}
        onChangeText={setText}
        onSubmitEditing={() => setTerm(text.trim())}
        returnKeyType="search"
        placeholder="搜索正确的作品"
        placeholderTextColor={colors.textFaint}
        style={{ height: 44, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.cardMuted, paddingHorizontal: 12, fontSize: 15, color: colors.text }}
      />
      {q.loading && !q.data ? <Loading /> : null}
      {q.error ? <Text style={[styles.faint, { color: colors.danger, marginTop: 8 }]}>{q.error}</Text> : null}
      {items.map((m) => (
        <Pressable key={m.tmdbid} onPress={() => void pick(m)} style={({ pressed }) => ({ flexDirection: "row", gap: 12, paddingVertical: 10, opacity: pressed || busy === m.tmdbid ? 0.6 : 1 })}>
          <Poster source={img(m.poster)} width={44} />
          <View style={{ flex: 1, justifyContent: "center" }}>
            <Text style={styles.title} numberOfLines={2}>{m.title}</Text>
            <Text style={styles.faint}>{[m.year, `TMDb ${m.tmdbid}`].filter(Boolean).join(" · ")}</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.textFaint} style={{ alignSelf: "center" }} />
        </Pressable>
      ))}
    </Sheet>
  );
}
