import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Card, ErrorBox, Loading, PillButton, Pull, Screen, SectionTitle, Tag, TopBar, styles, tap, toast, toastError } from "@/components/ui";
import { api, type Health, type HealthCheck, type HealthItem } from "@/lib/api";
import { ago } from "@/lib/format";
import { mutate, useQuery } from "@/lib/query";
import { colors } from "@/lib/theme";

const SEV = { error: () => colors.danger, warn: () => colors.warning, info: () => colors.textSoft };

// 健康检查：后端每 6 小时只读扫描一次（也可以立即检查），这里列出问题，处理由人决定。
export default function HealthScreen() {
  const router = useRouter();
  const q = useQuery("health", () => api<Health>("/v1/health"), { staleMs: 60_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [now] = useState(() => Date.now());
  const h = q.data?.ok ? q.data : null;

  const run = async () => {
    setBusy("run");
    try {
      const r = await api<Health>("/v1/health/run", { body: {}, timeoutMs: 150_000 });
      mutate("health", () => r);
      toast("已检查", r.total ? `发现 ${r.total} 个需要处理的问题` : "没有需要处理的问题");
    } catch (e) {
      toastError("未能检查", e);
    } finally {
      setBusy(null);
    }
  };
  const fix = async (c: HealthCheck, it: HealthItem) => {
    tap();
    setBusy(`${c.key}:${it.id}`);
    try {
      const r = await api<{ ok: boolean; error?: string }>("/v1/health/fix", { body: { key: c.key, id: it.id }, timeoutMs: 65_000 });
      if (!r.ok) throw new Error(r.error || "没有处理成功");
      toast("已处理", it.title);
      mutate<Health>("health", (d) => d && { ...d, checks: d.checks.map((x) => (x.key === c.key ? { ...x, count: x.count - 1, items: x.items.filter((y) => y.id !== it.id) } : x)) });
    } catch (e) {
      toastError("未能处理", e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Screen>
      <TopBar title="健康检查" />
      {q.error ? <ErrorBox text={q.error} onRetry={q.refresh} /> : null}
      {q.loading && !q.data ? <Loading /> : null}
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }} refreshControl={<Pull onRefresh={q.refresh} />}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={[styles.faint, { flex: 1 }]}>{h ? `上次检查 ${ago(h.at, now)}；每 6 小时自动检查一次，只报告不处理` : "还没有检查结果"}</Text>
          <PillButton small variant="soft" icon="pulse-outline" label="立即检查" loading={busy === "run"} onPress={() => void run()} />
        </View>
        {h?.errors.length ? <ErrorBox text={`部分检查没完成：${h.errors.join("；").slice(0, 200)}`} /> : null}
        {h && !h.checks.some((c) => c.count) ? <Card style={{ marginTop: 14 }}><Text style={styles.body}>没有发现问题</Text></Card> : null}
        {(h?.checks ?? []).filter((c) => c.count).map((c) => (
          <View key={c.key}>
            <SectionTitle title={c.title} right={<Tag text={String(c.count)} color={SEV[c.severity]()} solid />} />
            {c.hint ? <Text style={[styles.faint, { marginBottom: 8 }]}>{c.hint}</Text> : null}
            <Card style={{ gap: 12 }}>
              {c.items.map((it) => (
                <View key={it.id} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.body} numberOfLines={2}>{it.title}</Text>
                    {it.detail ? <Text style={styles.faint} numberOfLines={2}>{it.detail}</Text> : null}
                  </View>
                  {c.key === "hentai_ids" ? <PillButton small variant="soft" label="识别" loading={busy === `${c.key}:${it.id}`} onPress={() => void fix(c, it)} /> : null}
                  {c.key === "unconfirmed" ? <PillButton small variant="soft" label="核对" loading={busy === `${c.key}:${it.id}`} onPress={() => void fix(c, it)} /> : null}
                  {it.task ? <PillButton small variant="ghost" label="任务" onPress={() => router.push({ pathname: "/task/[hash]", params: { hash: it.task! } })} /> : null}
                  {it.emby ? <PillButton small variant="ghost" label="详情" onPress={() => router.push({ pathname: "/emby/[id]", params: { id: it.emby! } })} /> : null}
                </View>
              ))}
              {c.count > c.items.length ? <Text style={styles.faint}>还有 {c.count - c.items.length} 个未列出</Text> : null}
            </Card>
          </View>
        ))}
      </ScrollView>
    </Screen>
  );
}
