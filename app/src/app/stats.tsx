import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Card, ErrorBox, Loading, PillButton, Pull, Row, Screen, SectionTitle, Tag, TopBar, styles, toast, toastError } from "@/components/ui";
import { LibraryGrid, StorageCard, libMain } from "@/components/SystemCards";
import { api, statsQuery, type Stats } from "@/lib/api";
import { ago, bytes, clock } from "@/lib/format";
import { mutate, useQuery } from "@/lib/query";
import { useSettings } from "@/lib/settings";
import { colors } from "@/lib/theme";

const KIND = { media: "影视", av: "AV", hentai: "里番" } as Record<string, string>;
const GROUP = { active: "进行中", done: "已入库", failed: "失败", ended: "已取消/被替换" } as Record<string, string>;

type Day = Stats & { day: string };

// 系统统计明细：存储、每个媒体库的数字、入库任务按类型和状态、每天的快照（后端按需刷新，最短间隔 10 分钟）。
export default function StatsScreen() {
  const router = useRouter();
  const q = useQuery("stats", () => statsQuery(), { staleMs: 60_000 });
  const days = useQuery("stats:days", () => api<{ days: Day[] }>("/v1/stats/days"), { staleMs: 600_000 });
  const showAdult = useSettings((s) => s.showAdult);
  const [busy, setBusy] = useState(false);
  const [now] = useState(() => Date.now());
  const s = q.data?.ok ? q.data : null;
  const libs = (s?.libraries ?? []).filter((l) => showAdult || !l.adult);
  const total = libs.reduce((m, l) => ({ works: m.works + l.movies + l.series, eps: m.eps + l.episodes, week: m.week + l.new7d, noPoster: m.noPoster + l.noPoster }), { works: 0, eps: 0, week: 0, noPoster: 0 });

  const refresh = async () => {
    setBusy(true);
    try {
      const r = await statsQuery(true);
      mutate("stats", () => r);
      if (r.nextRefresh && r.nextRefresh * 1000 > Date.now() && !r.refreshing) toast("数据还很新", `两次刷新至少间隔 10 分钟，${clock(r.nextRefresh, Date.now())} 后可以再刷新`);
    } catch (e) {
      toastError("未能刷新统计", e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <TopBar title="存储与媒体库" />
      {q.error ? <ErrorBox text={q.error} onRetry={q.refresh} /> : null}
      {q.loading && !q.data ? <Loading /> : null}
      {q.data && !q.data.ok ? <ErrorBox text={q.data.error ?? "统计还没准备好"} onRetry={refresh} /> : null}
      {s ? (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }} refreshControl={<Pull onRefresh={q.refresh} />}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={[styles.faint, { flex: 1 }]}>更新于 {ago(s.at, now)}{s.refreshing ? "，正在后台刷新" : "；打开时超过 10 分钟会自动刷新"}</Text>
            <PillButton small variant="soft" icon="refresh" label="立即刷新" loading={busy} onPress={() => void refresh()} />
          </View>
          {s.errors.length ? <ErrorBox text={`部分数据没取到：${s.errors.join("；").slice(0, 200)}`} /> : null}

          <SectionTitle title="存储" />
          <StorageCard s={s.storage} />

          <SectionTitle title="媒体库" />
          <Card style={{ flexDirection: "row", justifyContent: "space-around", marginBottom: 10 }}>
            <Big n={total.works} label="部作品" />
            <Big n={total.eps} label="集" />
            <Big n={total.week} label="本周新增" color={colors.success} />
            <Big n={total.noPoster} label="缺海报" color={total.noPoster ? colors.warning : undefined} />
          </Card>
          <LibraryGrid libs={libs} onPress={() => router.push("/")} />

          <SectionTitle title="每个库" />
          <Card>
            {libs.map((l) => (
              <Row key={l.id} label={l.name} value={[libMain(l), `本周 +${l.new7d}`, l.noPoster ? `缺海报 ${l.noPoster}` : ""].filter(Boolean).join(" · ")} />
            ))}
          </Card>

          <SectionTitle title="入库任务" right={<Text style={styles.faint}>近 7 天入库 {s.ingest.done7d ?? 0} 个</Text>} />
          <Card style={{ gap: 10 }}>
            {Object.entries(s.ingest.byKind ?? {}).filter(([k]) => showAdult || k === "media").map(([k, g]) => (
              <View key={k} style={{ gap: 6 }}>
                <Text style={styles.title}>{KIND[k] ?? k}</Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                  {Object.entries(g).map(([st, n]) => (
                    <Tag key={st} text={`${GROUP[st] ?? st} ${n}`} color={st === "failed" ? colors.danger : st === "active" ? colors.primary : st === "done" ? colors.success : colors.textSoft} />
                  ))}
                </View>
              </View>
            ))}
            <Text style={styles.faint}>已拉黑的资源 {s.ingest.blacklisted ?? 0} 个（下不动、没有可入库视频或被手动换掉的）</Text>
          </Card>

          {days.data?.days.length ? (
            <>
              <SectionTitle title="每日快照" />
              <Card>
                {[...days.data.days].reverse().slice(0, 30).map((d) => {
                  const w = (d.libraries as Stats["libraries"]).filter((l) => showAdult || !l.adult).reduce((m, l) => m + l.movies + l.series, 0);
                  return <Row key={d.day} label={d.day.slice(5)} value={[`${w} 部`, d.storage.c115 ? `115 已用 ${bytes(d.storage.c115.used)}` : ""].filter(Boolean).join(" · ")} />;
                })}
              </Card>
            </>
          ) : null}
        </ScrollView>
      ) : null}
    </Screen>
  );
}

function Big({ n, label, color }: { n: number; label: string; color?: string }) {
  return (
    <View style={{ alignItems: "center" }}>
      <Text style={{ fontSize: 20, fontWeight: "800", color: color ?? colors.text }}>{n}</Text>
      <Text style={styles.faint}>{label}</Text>
    </View>
  );
}
