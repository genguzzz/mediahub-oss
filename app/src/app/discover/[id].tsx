import { ScrollView } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { LayoutToggle, Posters } from "@/components/media";
import { ErrorBox, Loading, MoreFooter, Screen, TopBar, Pull } from "@/components/ui";
import { api } from "@/lib/api";
import { useAutoMore, usePaged } from "@/lib/query";
import { mediaCard, useOpenMedia, type DiscoverItem } from "@/components/mediaCards";

// One discover list in full (waterfall or list); scrolling to the end appends the next page. Rankings show the position.
export default function DiscoverList() {
  const { id, title, ranked } = useLocalSearchParams<{ id: string; title?: string; ranked?: string }>();
  const open = useOpenMedia();
  const q = usePaged(
    `discover:${id}:pages`,
    async (p) => (await api<{ items: DiscoverItem[] }>(`/v1/discover/${id}?page=${p}`, { timeoutMs: 45_000 })).items,
    { id: (m) => `${m.source}:${m.sourceId}`, maxPages: 10, staleMs: 30 * 60_000 },
  );
  const scroll = useAutoMore(q.autoMore);
  return (
    <Screen>
      <TopBar title={title ?? "发现"} right={<LayoutToggle />} />
      <ScrollView
        contentContainerStyle={{ paddingTop: 6, paddingBottom: 60 }}
        refreshControl={<Pull onRefresh={q.refresh} />}
        {...scroll}
      >
        {q.error ? <ErrorBox text={q.error} onRetry={q.refresh} /> : null}
        {!q.hasData && q.loading ? <Loading /> : null}
        <Posters items={q.items.map((m, i) => mediaCard(m, () => void open(m), ranked ? i + 1 : undefined))} />
        <MoreFooter show={q.hasMore} error={q.moreError} onRetry={() => void q.more()} />
      </ScrollView>
    </Screen>
  );
}
