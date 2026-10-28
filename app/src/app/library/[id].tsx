import { useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { itemCard } from "@/components/embyCards";
import { LayoutToggle, Posters } from "@/components/media";
import { Chip, ChipRow, EmptyState, ErrorBox, Loading, MoreFooter, Screen, TopBar, styles, Pull } from "@/components/ui";
import { embyApi, type Item, type ItemsResult } from "@/lib/emby";
import { useAutoMore, usePaged } from "@/lib/query";
import { colors, radius } from "@/lib/theme";

type Sort = "added" | "name" | "year" | "rating";
const PAGE = 60;

export default function LibraryScreen() {
  const { id, name, search } = useLocalSearchParams<{ id: string; name?: string; search?: string }>();
  const router = useRouter();
  const [sort, setSort] = useState<Sort>("added");
  const [unplayed, setUnplayed] = useState(false);
  const [text, setText] = useState("");
  const [term, setTerm] = useState("");
  const parentId = id === "all" || id === "favorites" ? undefined : id;
  const filters = [id === "favorites" ? "IsFavorite" : "", unplayed ? "IsUnplayed" : ""].filter(Boolean).join(",") || undefined;
  const base = `emby:lib:${id}:${sort}:${filters ?? ""}:${term}`;
  // Scrolling to the end appends the next PAGE items (StartIndex), never re-fetching what's shown.
  const q = usePaged(
    base,
    async (p) => {
      const r = (await embyApi.items({ parentId, search: term || undefined, sort, filters, start: (p - 1) * PAGE, limit: PAGE, types: term ? "Movie,Series,Episode" : undefined })) as ItemsResult;
      return { items: r.Items, total: r.TotalRecordCount };
    },
    { id: (i: Item) => i.Id, pageSize: PAGE, maxPages: 200, staleMs: 60_000 },
  );
  const scroll = useAutoMore(q.autoMore);
  const items = q.items;

  const open = (i: Item) => router.push({ pathname: "/emby/[id]", params: { id: i.Id } });

  return (
    <Screen>
      <TopBar title={name ?? "媒体库"} right={<LayoutToggle />} />
      <View style={{ marginHorizontal: 16, marginBottom: 8, flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: colors.card, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 12, height: 42 }}>
        <Ionicons name="search" size={16} color={colors.textFaint} />
        <TextInput
          value={text}
          onChangeText={setText}
          onSubmitEditing={() => setTerm(text.trim())}
          autoFocus={search === "1"}
          returnKeyType="search"
          clearButtonMode="while-editing"
          placeholder={`在${name ?? "媒体库"}里找`}
          placeholderTextColor={colors.textFaint}
          style={{ flex: 1, fontSize: 15, color: colors.text }}
          autoCorrect={false}
        />
      </View>
      <ChipRow style={{ marginBottom: 10 }}>
        {(["added", "name", "year", "rating"] as Sort[]).map((s) => (
          <Chip key={s} label={{ added: "最近添加", name: "名称", year: "年份", rating: "评分" }[s]} active={sort === s} onPress={() => setSort(s)} />
        ))}
        <Chip label="未看" active={unplayed} onPress={() => setUnplayed(!unplayed)} />
      </ChipRow>
      <ScrollView {...scroll} contentContainerStyle={{ paddingBottom: 60 }} refreshControl={<Pull onRefresh={q.refresh} />}>
        {q.error ? <ErrorBox text={q.error} onRetry={q.refresh} /> : null}
        {q.total !== undefined ? <Text style={[styles.faint, { paddingHorizontal: 16, marginBottom: 10 }]}>共 {q.total} 项</Text> : null}
        {!q.hasData && q.loading ? <Loading /> : null}
        {q.hasData && !items.length ? <EmptyState icon="albums-outline" text={term ? "没有找到" : "这里还没有内容"} /> : null}
        <Posters items={items.map((i) => itemCard(i, open))} />
        <MoreFooter show={q.hasMore} error={q.moreError} onRetry={() => void q.more()} />
      </ScrollView>
    </Screen>
  );
}
