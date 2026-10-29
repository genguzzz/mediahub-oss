// Library items sharing one piece of metadata: a genre, studio, tag or year (the targets of the
// chips on the item page). Sortable, paged as you scroll.
import { useState } from "react";
import { ScrollView, Text } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { itemCard } from "@/components/embyCards";
import { LayoutToggle, Posters } from "@/components/media";
import { Chip, ChipRow, EmptyState, ErrorBox, Loading, MoreFooter, Pull, Screen, TopBar, styles } from "@/components/ui";
import { embyApi, type Item } from "@/lib/emby";
import { useAutoMore, usePaged } from "@/lib/query";

type Sort = "year" | "rating" | "added" | "name";
type Kind = "Movie,Series" | "Movie" | "Series";
const PAGE = 60;

export default function EmbyFilteredList() {
  const p = useLocalSearchParams<{ title?: string; genre?: string; studioId?: string; tag?: string; year?: string }>();
  const router = useRouter();
  const [sort, setSort] = useState<Sort>("year");
  const [kind, setKind] = useState<Kind>("Movie,Series");
  const q = usePaged(
    `emby:list:${p.genre ?? ""}:${p.studioId ?? ""}:${p.tag ?? ""}:${p.year ?? ""}:${sort}:${kind}`,
    async (page) => {
      const r = await embyApi.filtered({ genre: p.genre, studioId: p.studioId, tag: p.tag, year: p.year, types: kind, sort, start: (page - 1) * PAGE, limit: PAGE });
      return { items: r.Items, total: r.TotalRecordCount };
    },
    { id: (i: Item) => i.Id, maxPages: 50, staleMs: 10 * 60_000 },
  );
  const scroll = useAutoMore(q.autoMore);
  return (
    <Screen>
      <TopBar title={p.title ?? "媒体库"} right={<LayoutToggle />} />
      <ChipRow style={{ marginBottom: 8 }}>
        {([["Movie,Series", "全部"], ["Movie", "电影"], ["Series", "剧集"]] as const).map(([k, l]) => <Chip key={k} label={l} active={kind === k} onPress={() => setKind(k)} />)}
      </ChipRow>
      <ChipRow style={{ marginBottom: 6 }}>
        {([["year", "年份"], ["rating", "评分"], ["added", "入库"], ["name", "名称"]] as const).map(([k, l]) => <Chip key={k} label={l} active={sort === k} onPress={() => setSort(k)} />)}
        {q.total !== undefined ? <Text style={[styles.faint, { alignSelf: "center", marginLeft: 4 }]}>共 {q.total} 部</Text> : null}
      </ChipRow>
      <ScrollView contentContainerStyle={{ paddingTop: 6, paddingBottom: 60 }} refreshControl={<Pull onRefresh={q.refresh} />} {...scroll}>
        {q.error ? <ErrorBox text={q.error} onRetry={q.refresh} /> : null}
        {!q.hasData && q.loading ? <Loading /> : null}
        {q.hasData && !q.items.length ? <EmptyState icon="albums-outline" text="库里没有符合的作品" /> : null}
        <Posters items={q.items.map((i) => itemCard(i, (x) => router.push({ pathname: "/emby/[id]", params: { id: x.Id } })))} />
        <MoreFooter show={q.hasMore} error={q.moreError} onRetry={() => void q.more()} />
      </ScrollView>
    </Screen>
  );
}
