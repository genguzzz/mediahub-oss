// A catalog list in full: sort chips, tag filter, waterfall or list, infinite scroll. Opened from a
// home row, a tag, an actress or an index search; every filter is a route param so back works.
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { LayoutToggle, Posters } from "@/components/media";
import { Chip, ChipRow, EmptyState, ErrorBox, Loading, MoreFooter, Pull, Screen, TopBar, styles, tap } from "@/components/ui";
import { catalogApi, catalogCard, listKey, useOpenCatalog, type ListQuery } from "@/lib/catalog";
import { useAutoMore, usePaged, useQuery } from "@/lib/query";
import { colors } from "@/lib/theme";
import { track } from "@/lib/track";

const SIZE = 30;

export default function CatalogList() {
  const params = useLocalSearchParams<{ p: string; title?: string; sort?: string; tag?: string; person?: string; q?: string; since?: string }>();
  const p = params.p;
  const router = useRouter();
  const open = useOpenCatalog(p);
  const providers = useQuery("catalog:providers", catalogApi.providers, { staleMs: 60 * 60_000 });
  const info = providers.data?.providers.find((x) => x.id === p);
  const tags = useQuery(info?.tagFilter ? `catalog:${p}:tags` : null, () => catalogApi.tags(p), { staleMs: 60 * 60_000 });
  const [sort, setSort] = useState(params.sort);
  const [tag, setTag] = useState(params.tag);
  const sorts = (params.person ? info?.personSorts : info?.sorts) ?? [];
  const curSort = sort ?? sorts[0]?.id;
  const q: ListQuery = { sort: curSort, tag, person: params.person, q: params.q, since: params.since };
  // Wait for the provider's sort list so the first page isn't fetched twice.
  const ready = !!info || !!providers.error;
  const list = usePaged(
    ready ? listKey(p, q) : `${listKey(p, q)}#wait`,
    async (page) => {
      if (!ready) return [];
      const r = await catalogApi.list(p, q, page, SIZE);
      return r.total ? { items: r.items, total: r.total } : r.hasMore ? r.items : { items: r.items, total: (page - 1) * SIZE + r.items.length };
    },
    { id: (c) => c.id, maxPages: 120, staleMs: 10 * 60_000 },
  );
  const scroll = useAutoMore(list.autoMore);
  const isHentai = info?.kind === "hentai";

  return (
    <Screen>
      <TopBar title={params.title ?? info?.name ?? "索引"} right={<LayoutToggle />} />
      <ScrollView contentContainerStyle={{ paddingBottom: 60 }} refreshControl={<Pull onRefresh={list.refresh} />} stickyHeaderIndices={[0]} {...scroll}>
        <View style={{ backgroundColor: colors.bg, paddingBottom: 10 }}>
          {sorts.length ? (
            <ChipRow style={{ marginTop: 2 }}>
              {sorts.map((s) => (
                <Chip key={s.id} label={s.label} icon={curSort === s.id ? "swap-vertical" : undefined} active={curSort === s.id} onPress={() => { track("catalog_sort", { p, sort: s.id }); setSort(s.id); }} />
              ))}
            </ChipRow>
          ) : null}
          {tags.data?.tags.length && !params.tag ? (
            <ChipRow style={{ marginTop: 8 }}>
              {tags.data.tags.slice(0, 40).map((t) => (
                <Chip key={t.name} label={t.name} active={tag === t.name} onPress={() => setTag(tag === t.name ? undefined : t.name)} />
              ))}
            </ChipRow>
          ) : null}
        </View>

        {list.total ? (
          <Text style={[styles.faint, { paddingHorizontal: 16, marginBottom: 10 }]}>
            共 {list.total} 部{tag ? ` · ${tag}` : ""}{params.q ? ` · “${params.q}”` : ""}{info ? ` · ${info.note}` : ""}
          </Text>
        ) : null}

        {params.q ? (
          <Pressable
            onPress={() => { tap(); router.push({ pathname: "/resources", params: { mode: isHentai ? "hentai" : "av", keyword: params.q! } }); }}
            style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 16, paddingBottom: 12 }}
          >
            <Ionicons name="flash-outline" size={15} color={colors.primary} />
            <Text style={{ color: colors.primary, fontSize: 14, fontWeight: "600" }}>按关键词直接搜资源</Text>
          </Pressable>
        ) : null}

        {list.error ? <ErrorBox text={list.error} onRetry={list.refresh} /> : null}
        {!list.hasData && list.loading ? <Loading /> : null}
        {list.hasData && !list.items.length ? <EmptyState icon="search-outline" text={params.q ? "索引里没有这个名字，试试罗马音或日文原名" : "没有符合条件的作品"} /> : null}
        <Posters items={list.items.map((c) => catalogCard(c, () => open(c)))} />
        <MoreFooter show={list.hasMore} error={list.moreError} onRetry={() => void list.more()} />
      </ScrollView>
    </Screen>
  );
}
