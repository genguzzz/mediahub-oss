import { useState } from "react";
import { FlatList, Text, View } from "react-native";
import { Card, Chip, ChipRow, EmptyState, ErrorBox, Loading, Pull, Screen, Tag, TopBar, styles } from "@/components/ui";
import { api } from "@/lib/api";
import { ago } from "@/lib/format";
import { useQuery } from "@/lib/query";
import { colors } from "@/lib/theme";

interface Feedback {
  id: string; at: string; status: "open" | "done" | "wontfix"; kinds: string[]; reason: string; note?: string; logId?: string;
  item: { title: string; subtitle?: string; embyId?: string };
  emby: { path?: string; providers?: Record<string, string>; images?: string[]; error?: string } | null;
}

const STATUS = { open: { text: "待处理", color: () => colors.warning }, done: { text: "已处理", color: () => colors.success }, wontfix: { text: "不处理", color: () => colors.textSoft } };

// Reports sent from the long-press sheet (反馈问题), with the status and note they got.
export default function FeedbackScreen() {
  const [filter, setFilter] = useState<"all" | "open" | "done">("all");
  const q = useQuery(`feedback:${filter}`, () => api<{ items: Feedback[] }>(`/v1/feedback?status=${filter}`), { staleMs: 20_000 });
  const [now] = useState(() => Date.now());
  return (
    <Screen>
      <TopBar title="问题反馈" />
      <ChipRow style={{ marginBottom: 8 }}>
        {(["all", "open", "done"] as const).map((f) => <Chip key={f} label={{ all: "全部", open: "待处理", done: "已处理" }[f]} active={filter === f} onPress={() => setFilter(f)} />)}
      </ChipRow>
      <FlatList
        data={q.data?.items ?? []}
        keyExtractor={(f) => f.id}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 60, gap: 10 }}
        refreshControl={<Pull onRefresh={q.refresh} />}
        ListHeaderComponent={<>{q.error ? <ErrorBox text={q.error} onRetry={q.refresh} /> : null}{q.loading && !q.data ? <Loading /> : null}</>}
        ListEmptyComponent={q.data ? <EmptyState icon="flag-outline" text="还没有反馈。长按任意海报，选「反馈问题」。" /> : undefined}
        renderItem={({ item: f }) => {
          const st = STATUS[f.status] ?? STATUS.open;
          return (
            <Card style={{ gap: 6 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text style={[styles.title, { flex: 1 }]} numberOfLines={2}>{f.item.title}</Text>
                <Tag text={st.text} color={st.color()} />
              </View>
              {f.item.subtitle ? <Text style={styles.faint} numberOfLines={1}>{f.item.subtitle}</Text> : null}
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>{f.kinds.map((k) => <Tag key={k} text={k} color={colors.primary} />)}</View>
              {f.reason ? <Text style={styles.body}>{f.reason}</Text> : null}
              {f.note ? <Text style={[styles.body, { color: colors.success }]}>处理说明：{f.note}</Text> : null}
              <Text style={styles.faint}>{[`编号 ${f.id}`, ago(f.at, now), f.logId ? `日志 ${f.logId}` : "", f.emby?.path ? f.emby.path.split("/").slice(3, 5).join("/") : ""].filter(Boolean).join(" · ")}</Text>
            </Card>
          );
        }}
      />
    </Screen>
  );
}
