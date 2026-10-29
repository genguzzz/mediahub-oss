import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Card, ErrorBox, Loading, PillButton, Poster, Pull, Row, Screen, SectionTitle, Tag, TopBar, confirm, styles, tap, toast, toastError } from "@/components/ui";
import { api, img, type SubDetail, type SubEpisode, type Subscription } from "@/lib/api";
import { ago } from "@/lib/format";
import { mutate, useQuery } from "@/lib/query";
import { colors } from "@/lib/theme";

// Episode states from the plugin, in the order a subscription moves through them.
const EP_COLOR: Record<SubEpisode["state"], () => string> = {
  未播: () => colors.textFaint,
  缺: () => colors.danger,
  已提交: () => colors.primary,
  下载中: () => colors.primary,
  卡住: () => colors.warning,
  入库中: () => colors.primary,
  失败: () => colors.danger,
  已取消: () => colors.textSoft,
  已入库: () => colors.success,
};

export default function SubscriptionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const q = useQuery(id ? `sub:${id}` : null, () => api<SubDetail>(`/v1/subscriptions/${id}`, { timeoutMs: 65_000 }), { staleMs: 30_000, interval: 60_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [now] = useState(() => Date.now());
  const d = q.data?.ok ? q.data : null;

  const searchNow = async () => {
    setBusy("search");
    try {
      const r = await api<{ ok: boolean; message: string }>(`/v1/subscriptions/${id}/search`, { body: {} });
      if (r.ok) toast("已开始搜索", "MoviePilot 在后台搜索缺的集");
      else toast("未能搜索", r.message, undefined, true);
    } catch (e) {
      toastError("未能搜索", e);
    } finally {
      setBusy(null);
    }
  };
  const end = () =>
    confirm("结束订阅", "不再搜索这部作品的新集。已入库的不受影响；自动订阅助手之后也不会再把它加回来。", "结束订阅", async () => {
      try {
        await api(`/v1/subscriptions/${id}`, { method: "DELETE" });
        mutate<{ items: Subscription[] }>("subs", (x) => x && { items: x.items.filter((s) => String(s.id) !== id) });
        toast("已结束订阅");
        router.back();
      } catch (e) {
        toastError("未能结束订阅", e);
      }
    }, true);

  const counts = (d?.episodes ?? []).reduce<Record<string, number>>((m, e) => ({ ...m, [e.state]: (m[e.state] ?? 0) + 1 }), {});
  return (
    <Screen>
      <TopBar title={d?.sub.name ?? "订阅"} />
      {q.error ? <ErrorBox text={q.error} onRetry={q.refresh} /> : null}
      {q.data && !q.data.ok ? <ErrorBox text={q.data.error ?? "读取失败"} /> : null}
      {q.loading && !q.data ? <Loading /> : null}
      {d ? (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }} refreshControl={<Pull onRefresh={q.refresh} />}>
          <View style={{ flexDirection: "row", gap: 12 }}>
            <Poster source={img(d.sub.poster)} width={72} />
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={styles.h2}>{d.sub.name}{d.sub.season ? ` · 第 ${d.sub.season} 季` : ""}</Text>
              <Text style={styles.faint}>{[d.sub.year, d.sub.source !== "themoviedb" ? `${d.sub.source} ${d.sub.mediaId}` : "", d.tmdb.id ? `TMDb ${d.tmdb.id} S${d.tmdb.season}${d.tmdb.offset ? ` +${d.tmdb.offset}` : ""}` : ""].filter(Boolean).join(" · ")}</Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                {Object.entries(counts).map(([k, n]) => <Tag key={k} text={`${k} ${n}`} color={EP_COLOR[k as SubEpisode["state"]]?.() ?? colors.textSoft} />)}
              </View>
            </View>
          </View>

          {d.warnings.length ? (
            <Card style={{ marginTop: 12, borderColor: colors.warning }}>
              {d.warnings.map((w) => <Text key={w} style={[styles.body, { color: colors.textSoft }]}>{w}</Text>)}
            </Card>
          ) : null}

          <SectionTitle title="每一集" right={<Text style={styles.faint}>点集数看任务</Text>} />
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {d.episodes.map((e) => {
              const c = EP_COLOR[e.state]();
              return (
                <Pressable key={e.ep} disabled={!e.hash}
                  onPress={() => { tap(); if (e.hash) router.push({ pathname: "/task/[hash]", params: { hash: e.hash } }); }}
                  style={({ pressed }) => ({ width: 68, paddingVertical: 8, borderRadius: 12, alignItems: "center", borderWidth: 1, borderColor: c + "66", backgroundColor: c + "14", opacity: pressed ? 0.7 : 1 })}>
                  <Text style={{ fontSize: 16, fontWeight: "800", color: colors.text, fontVariant: ["tabular-nums"] }}>{e.ep}</Text>
                  <Text style={{ fontSize: 11.5, fontWeight: "600", color: c, marginTop: 2 }}>{e.state}</Text>
                </Pressable>
              );
            })}
          </View>

          <SectionTitle title="订阅" />
          <Card>
            <Row label="状态" value={{ R: "订阅中", N: "新建", P: "待定", S: "已暂停" }[d.sub.state] ?? d.sub.state} />
            <Row label="总集数" value={`${d.sub.total || "?"} 集（TMDb 本季 ${d.tmdb.episodes || "?"} 集，已播 ${d.tmdb.aired}）`} />
            <Row label="MP 记录缺" value={d.sub.lack !== null ? `${d.sub.lack} 集` : ""} />
            <Row label="上次搜索" value={d.sub.lastSearch ? ago(d.sub.lastSearch, now) : "还没搜索过"} />
            <Row label="添加者" value={d.sub.user} />
          </Card>

          <SectionTitle title="操作" />
          <View style={{ gap: 10 }}>
            <PillButton variant="soft" icon="search" label="立即搜索缺的集" loading={busy === "search"} onPress={() => void searchNow()} />
            {d.tmdb.id ? <PillButton variant="soft" icon="albums-outline" label="查看作品" onPress={() => router.push({ pathname: "/media/[type]/[id]", params: { type: "tv", id: String(d.tmdb.id) } })} /> : null}
            <PillButton variant="danger" icon="stop-circle-outline" label="结束订阅" onPress={end} />
          </View>
        </ScrollView>
      ) : null}
    </Screen>
  );
}
