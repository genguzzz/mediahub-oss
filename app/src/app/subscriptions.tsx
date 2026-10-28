import { useState } from "react";
import { FlatList, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Card, Chip, ChipRow, EmptyState, ErrorBox, Loading, PillButton, Poster, Screen, Tag, TopBar, confirm, styles, toast, toastError, Pull } from "@/components/ui";
import { api, img, type Subscription } from "@/lib/api";
import { ago } from "@/lib/format";
import { mutate, useQuery } from "@/lib/query";
import { colors } from "@/lib/theme";

const STATE: Record<string, { text: string; color: () => string }> = {
  N: { text: "新建", color: () => colors.textSoft },
  R: { text: "订阅中", color: () => colors.primary },
  P: { text: "待定", color: () => colors.warning },
  S: { text: "已暂停", color: () => colors.textFaint },
};

export default function SubscriptionsScreen() {
  const router = useRouter();
  const q = useQuery("subs", () => api<{ items: Subscription[] }>("/v1/subscriptions"), { staleMs: 30_000 });
  const [filter, setFilter] = useState<"all" | "lack" | "tv" | "movie">("all");
  const [now] = useState(() => Date.now());
  const list = (q.data?.items ?? []).filter((s) => (filter === "all" ? true : filter === "lack" ? (s.lack ?? 0) > 0 : s.type === filter));

  const searchNow = async (s: Subscription) => {
    try {
      const r = await api<{ ok: boolean; message: string }>(`/v1/subscriptions/${s.id}/search`, { body: {} });
      if (r.ok) toast("已开始搜索", "MoviePilot 在后台搜索缺的集，找到会自动下载入库");
      else toast("未能搜索", r.message, undefined, true);
    } catch (e) {
      toastError("未能搜索", e);
    }
  };
  const remove = (s: Subscription) =>
    confirm("取消订阅", `${s.title}${s.season ? ` 第 ${s.season} 季` : ""}`, "取消订阅", async () => {
      try {
        await api(`/v1/subscriptions/${s.id}`, { method: "DELETE" });
        mutate<{ items: Subscription[] }>("subs", (d) => d && { items: d.items.filter((x) => x.id !== s.id) });
        toast("已取消订阅");
      } catch (e) {
        toastError("未能取消订阅", e);
      }
    }, true);

  return (
    <Screen>
      <TopBar title="订阅" />
      <ChipRow style={{ marginBottom: 8 }}>
        {(["all", "lack", "tv", "movie"] as const).map((f) => (
          <Chip key={f} label={{ all: "全部", lack: "缺集", tv: "剧集", movie: "电影" }[f]} active={filter === f} onPress={() => setFilter(f)} />
        ))}
      </ChipRow>
      <FlatList
        data={list}
        keyExtractor={(s) => String(s.id)}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 60, gap: 10 }}
        refreshControl={<Pull onRefresh={q.refresh} />}
        ListHeaderComponent={<>{q.error ? <ErrorBox text={q.error} onRetry={q.refresh} /> : null}{q.loading && !q.data ? <Loading /> : null}</>}
        ListEmptyComponent={q.data ? <EmptyState icon="bookmarks-outline" text="没有订阅。在作品详情里可以按季订阅。" /> : undefined}
        renderItem={({ item: s }) => {
          const st = STATE[s.state] ?? { text: s.state || "—", color: () => colors.textSoft };
          return (
            <Card onPress={s.tmdbid ? () => router.push({ pathname: "/media/[type]/[id]", params: { type: s.type, id: String(s.tmdbid) } }) : undefined} style={{ flexDirection: "row", gap: 12 }}>
              <Poster source={img(s.poster)} width={52} />
              <View style={{ flex: 1, gap: 4 }}>
                <Text style={styles.title} numberOfLines={2}>{s.title}{s.season ? ` · 第 ${s.season} 季` : ""}</Text>
                <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
                  <Tag text={st.text} color={st.color()} />
                  {s.total ? <Tag text={`缺 ${s.lack ?? 0} / 共 ${s.total} 集`} color={(s.lack ?? 0) > 0 ? colors.warning : colors.success} /> : null}
                  {s.source && s.source !== "themoviedb" ? <Tag text={s.source} color={colors.textSoft} /> : null}
                </View>
                <Text style={styles.faint}>{s.by ? `${s.by} · ` : ""}{s.lastSearch ? `上次搜索 ${ago(s.lastSearch, now)}` : "还没搜索过"}</Text>
                <View style={{ flexDirection: "row", gap: 8, marginTop: 4 }}>
                  <PillButton small variant="soft" icon="search" label="立即搜索" onPress={() => searchNow(s)} />
                  <PillButton small variant="ghost" icon="trash-outline" label="取消" onPress={() => remove(s)} />
                </View>
              </View>
            </Card>
          );
        }}
      />
    </Screen>
  );
}
