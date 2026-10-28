// Emby item → poster card data (shared by the library home, library browse and search).
import type { CardData } from "./media";
import { landscapeOf, posterOf, seconds, type Item } from "@/lib/emby";

export function itemCard(i: Item, open: (i: Item) => void, landscape = false): CardData {
  const ep = i.Type === "Episode";
  const pos = seconds(i.UserData?.PlaybackPositionTicks);
  const total = seconds(i.RunTimeTicks);
  return {
    key: i.Id,
    title: ep ? i.SeriesName ?? i.Name : i.Name,
    subtitle: ep ? `S${i.ParentIndexNumber ?? "?"}E${i.IndexNumber ?? "?"} · ${i.Name}` : [i.ProductionYear, i.Type === "Series" ? "剧集" : i.Type === "Movie" ? "电影" : ""].filter(Boolean).join(" · "),
    overview: i.Overview,
    poster: landscape ? landscapeOf(i) : posterOf(i),
    rating: i.CommunityRating,
    progress: total && pos ? pos / total : i.UserData?.PlayedPercentage ? i.UserData.PlayedPercentage / 100 : undefined,
    played: i.UserData?.Played && i.Type !== "Series",
    unplayed: i.Type === "Series" ? i.UserData?.UnplayedItemCount : undefined,
    tags: i.Genres?.slice(0, 3),
    onPress: () => open(i),
  };
}
