// A TMDb list filtered by one genre / network / company / keyword (tapped on a 发现 work page or a genre chip),
// sortable by popularity, rating or newest. For series lists from a company or keyword, movies are one tap away.
import { useState } from "react";
import { ScrollView } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { LayoutToggle, Posters } from "@/components/media";
import { mediaCard, useOpenMedia } from "@/components/mediaCards";
import { Chip, ChipRow, EmptyState, ErrorBox, Loading, MoreFooter, Pull, Screen, Segmented, TopBar } from "@/components/ui";
import { api, type TmdbWork } from "@/lib/api";
import { useAutoMore, usePaged } from "@/lib/query";

type Sort = "popularity.desc" | "vote_average.desc" | "new";

export default function DiscoverBrowse() {
  const { title, type, filter, value } = useLocalSearchParams<{ title?: string; type?: string; filter: string; value: string }>();
  const open = useOpenMedia();
  const [kind, setKind] = useState<"movie" | "tv">(type === "movie" ? "movie" : "tv");
  const [sort, setSort] = useState<Sort>("popularity.desc");
  const by = sort === "new" ? (kind === "movie" ? "primary_release_date.desc" : "first_air_date.desc") : sort;
  const q = usePaged(
    `tdisc:${filter}:${value}:${kind}:${by}`,
    async (p) => (await api<{ items: TmdbWork[] }>(`/v1/tmdb/discover?type=${kind}&${filter}=${encodeURIComponent(value)}&sort_by=${by}&page=${p}`, { timeoutMs: 45_000 })).items,
    { id: (m) => `${m.type}:${m.tmdbid}`, maxPages: 15, staleMs: 30 * 60_000 },
  );
  const scroll = useAutoMore(q.autoMore);
  // Genre ids differ between movies and series; networks only make series.
  const canSwitch = filter === "with_companies" || filter === "with_keywords";
  return (
    <Screen>
      <TopBar title={title ?? "发现"} right={<LayoutToggle />} />
      <ScrollView contentContainerStyle={{ paddingBottom: 60 }} refreshControl={<Pull onRefresh={q.refresh} />} {...scroll}>
        {canSwitch ? <Segmented value={kind} onChange={setKind} options={[{ value: "tv", label: "剧集" }, { value: "movie", label: "电影" }]} style={{ marginHorizontal: 16, marginTop: 4 }} /> : null}
        <ChipRow style={{ marginTop: 10, marginBottom: 12 }}>
          <Chip label="热门" active={sort === "popularity.desc"} onPress={() => setSort("popularity.desc")} />
          <Chip label="高分" active={sort === "vote_average.desc"} onPress={() => setSort("vote_average.desc")} />
          <Chip label="最新" active={sort === "new"} onPress={() => setSort("new")} />
        </ChipRow>
        {q.error ? <ErrorBox text={q.error} onRetry={q.refresh} /> : null}
        {!q.hasData && q.loading ? <Loading text="正在读取 TMDb" /> : null}
        {q.hasData && !q.items.length ? <EmptyState icon="film-outline" text="TMDb 里没有符合的作品" /> : null}
        <Posters items={q.items.map((m, i) => mediaCard(m, () => void open(m), sort === "vote_average.desc" ? i + 1 : undefined))} />
        <MoreFooter show={q.hasMore} error={q.moreError} onRetry={() => void q.more()} />
      </ScrollView>
    </Screen>
  );
}
