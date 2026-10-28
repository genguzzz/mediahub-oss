import { useMemo, useState } from "react";
import { FlatList, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SourceMeta } from "@/components/sources";
import { Card, Chip, ChipRow, EmptyState, ErrorBox, Loading, PillButton, Pull, Screen, Tag, TopBar, confirm, styles, toast, toastError } from "@/components/ui";
import { api, type CatalogItem } from "@/lib/api";
import { load, useQuery } from "@/lib/query";
import { colors, radius } from "@/lib/theme";
import { track } from "@/lib/track";

const FILTERS = ["全部", "中文", "动漫", "电影", "剧集", "综合"] as const;

// Every torrent indexer Prowlarr knows, with language/content/description from its definitions.
// Public ones are added in one tap (Prowlarr tests the site first); the rest need an account and are
// added in Prowlarr's web UI.
export default function IndexerCatalog() {
  const q = useQuery("prowlarr:catalog", () => api<{ ok: boolean; error?: string; items: CatalogItem[] }>("/v1/prowlarr/catalog", { timeoutMs: 95_000 }), { staleMs: 30 * 60_000 });
  const [text, setText] = useState("");
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("全部");
  const [showPrivate, setShowPrivate] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const list = useMemo(() => {
    const t = text.trim().toLowerCase();
    return (q.data?.items ?? []).filter((i) =>
      (showPrivate || i.addable || i.addedId) &&
      (filter === "全部" || i.tags.includes(filter)) &&
      (!t || i.name.toLowerCase().includes(t) || i.desc.toLowerCase().includes(t)));
  }, [q.data, text, filter, showPrivate]);

  const add = (i: CatalogItem) =>
    confirm("添加到 Prowlarr", `添加「${i.name}」并启用？Prowlarr 会先测试能不能连上这个站。\n\n启用后 MoviePilot 智能搜索也会查它，会增加 NAS 负担。`, "添加", async () => {
      setBusy(i.definition);
      try {
        const r = await api<{ ok: boolean; error?: string }>("/v1/prowlarr", { body: { action: "add", definition: i.definition }, timeoutMs: 95_000 });
        if (!r.ok) throw new Error(r.error || "添加失败");
        track("indexer.action", { action: "add", name: i.name });
        toast("已添加", i.name);
        await Promise.all([q.refresh(), load("sources", () => api("/v1/sources"))]);
      } catch (e) {
        toastError("未能添加", e);
      } finally {
        setBusy(null);
      }
    });

  return (
    <Screen>
      <TopBar title="添加索引器" />
      <View style={{ marginHorizontal: 16, marginBottom: 8, flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: colors.card, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 12, height: 42 }}>
        <Ionicons name="search" size={16} color={colors.textFaint} />
        <TextInput value={text} onChangeText={setText} placeholder="按名字或简介找" placeholderTextColor={colors.textFaint} autoCorrect={false} autoCapitalize="none" clearButtonMode="while-editing" style={{ flex: 1, fontSize: 15, color: colors.text }} />
      </View>
      <ChipRow style={{ marginBottom: 8 }}>
        {FILTERS.map((f) => <Chip key={f} label={f} active={filter === f} onPress={() => setFilter(f)} />)}
        <Chip label="显示需要账号的" active={showPrivate} onPress={() => setShowPrivate(!showPrivate)} />
      </ChipRow>
      <FlatList
        data={list}
        keyExtractor={(i) => i.definition}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 60, gap: 8 }}
        refreshControl={<Pull onRefresh={q.refresh} />}
        ListHeaderComponent={
          <>
            {q.error || q.data?.error ? <ErrorBox text={q.error || q.data?.error || ""} onRetry={q.refresh} /> : null}
            {q.loading && !q.data ? <Loading text="正在读取 Prowlarr 的索引器定义" /> : null}
            {q.data ? <Text style={[styles.faint, { marginBottom: 4 }]}>{list.length} 个 · 公开站可一键添加，需要账号的请在 Prowlarr 网页添加</Text> : null}
          </>
        }
        ListEmptyComponent={q.data ? <EmptyState icon="search-outline" text="没有符合条件的索引器" /> : undefined}
        renderItem={({ item: i }) => (
          <Card style={{ opacity: i.addable || i.addedId ? 1 : 0.6 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <Text style={styles.title} numberOfLines={1}>{i.name}</Text>
                  {i.addedId ? <Tag text="已添加" color={colors.success} solid /> : null}
                </View>
                <SourceMeta s={i} lines={3} />
                {i.url ? <Text style={[styles.faint, { marginTop: 2 }]} numberOfLines={1}>{i.url}</Text> : null}
              </View>
              {!i.addedId && i.addable ? <PillButton small label="添加" icon="add" loading={busy === i.definition} onPress={() => add(i)} /> : null}
            </View>
          </Card>
        )}
      />
    </Screen>
  );
}
