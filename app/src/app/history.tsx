import { useState } from "react";
import { ScrollView } from "react-native";
import { LayoutToggle, Posters } from "@/components/media";
import { useOpenMedia } from "@/components/mediaCards";
import { ErrorBox, Loading, MoreFooter, Pull, Screen, TopBar } from "@/components/ui";
import { api, img, type HistoryItem } from "@/lib/api";
import { ago } from "@/lib/format";
import { useAutoMore, usePaged } from "@/lib/query";

// MoviePilot download history (subscriptions, manual downloads, batch jobs); tap → work detail.
// Scrolling to the end (or 加载更多) appends the next page in place.
export default function HistoryScreen() {
  const open = useOpenMedia();
  const [now] = useState(() => Date.now());
  const h = usePaged(
    "history:pages",
    async (p) => (await api<{ items: HistoryItem[] }>(`/v1/history?page=${p}`)).items,
    { id: (x) => String(x.id), pageSize: 30, staleMs: 30_000 },
  );
  const scroll = useAutoMore(h.autoMore);
  return (
    <Screen>
      <TopBar title="下载记录" right={<LayoutToggle />} />
      <ScrollView
        contentContainerStyle={{ paddingTop: 6, paddingBottom: 60 }}
        refreshControl={<Pull onRefresh={h.refresh} />}
        {...scroll}
      >
        {h.error ? <ErrorBox text={h.error} onRetry={h.refresh} /> : null}
        {h.loading && !h.hasData ? <Loading /> : null}
        <Posters
          items={h.items.map((x) => ({
            key: String(x.id),
            title: x.title,
            subtitle: [x.se, ago(x.date, now), x.by || "手动"].filter(Boolean).join(" · "),
            overview: x.torrent,
            tags: [x.site.replace(/^直连·|^Prowlarr·/, "")].filter(Boolean),
            poster: img(x.poster),
            onPress: () => void open({ type: x.type, tmdbid: x.tmdbid, title: x.title, year: x.year }),
          }))}
        />
        <MoreFooter show={h.hasMore} error={h.moreError} onRetry={() => void h.more()} />
      </ScrollView>
    </Screen>
  );
}
