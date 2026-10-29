// 反馈问题: pick what is wrong with an item, add a reason, optionally attach the recent app log.
// The server stores it with a snapshot of the Emby record (path, ids, images, streams) for later analysis.
import { useState } from "react";
import { Switch, Text, TextInput, View } from "react-native";
import { Chip, PillButton, styles, tap, toast, toastError } from "./ui";
import { api, appVersion } from "@/lib/api";
import { collectLogs } from "@/lib/log";
import { track } from "@/lib/track";
import { colors, radius } from "@/lib/theme";

export const FEEDBACK_KINDS = ["刮削信息错误", "认错作品", "海报图片未加载", "分季集号错", "资源画质问题", "字幕问题", "音轨问题", "播放失败", "重复条目", "缺集", "其他"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export interface FeedbackItem { embyId?: string; title: string; subtitle?: string; key?: string }

export function FeedbackForm({ item, onDone, onCancel }: { item: FeedbackItem; onDone: () => void; onCancel?: () => void }) {
  const [kinds, setKinds] = useState<FeedbackKind[]>([]);
  const [reason, setReason] = useState("");
  const [withLog, setWithLog] = useState(true);
  const [busy, setBusy] = useState(false);
  const toggle = (k: FeedbackKind) => { tap(); setKinds((x) => (x.includes(k) ? x.filter((y) => y !== k) : [...x, k])); };

  const submit = async () => {
    if (!kinds.length) return toast("请选择问题类型", undefined, undefined, true);
    setBusy(true);
    try {
      let logId: string | undefined;
      if (withLog) {
        const log = await collectLogs(1, 800_000);
        logId = (await api<{ id: string }>("/v1/logs", { body: { log, meta: { version: appVersion, feedback: true, item: item.embyId ?? item.title } }, timeoutMs: 60_000 })).id;
      }
      const r = await api<{ ok: boolean; id: string }>("/v1/feedback", { body: { kinds, reason: reason.trim(), item, logId, version: appVersion }, timeoutMs: 45_000 });
      track("feedback", { kinds: kinds.join(","), emby: item.embyId ? 1 : 0, log: logId ? 1 : 0 });
      toast("已提交反馈", `编号 ${r.id}，可在 设置 → 问题反馈 查看处理状态`);
      onDone();
    } catch (e) {
      toastError("未能提交反馈", e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ gap: 12 }}>
      <Text style={styles.faint}>选择问题类型（可多选）</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {FEEDBACK_KINDS.map((k) => <Chip key={k} label={k} active={kinds.includes(k)} onPress={() => toggle(k)} />)}
      </View>
      <TextInput
        value={reason}
        onChangeText={setReason}
        placeholder="补充说明（例如：海报是另一部、第 3 集其实是第 4 集、字幕不同步）"
        placeholderTextColor={colors.textFaint}
        multiline
        maxLength={2000}
        style={{ minHeight: 96, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.cardMuted, padding: 12, fontSize: 15, color: colors.text, textAlignVertical: "top" }}
      />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Text style={[styles.body, { flex: 1 }]}>附上最近的 App 日志</Text>
        <Switch value={withLog} onValueChange={setWithLog} />
      </View>
      <View style={{ flexDirection: "row", gap: 8 }}>
        {onCancel ? <PillButton variant="soft" label="返回" onPress={onCancel} style={{ flex: 1 }} /> : null}
        <PillButton icon="send" label="提交反馈" loading={busy} onPress={() => void submit()} style={{ flex: 2 }} />
      </View>
    </View>
  );
}
