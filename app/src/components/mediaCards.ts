// TMDb / discover item → poster card, and opening one (Bangumi / Douban entries resolve to TMDb first).
import { useRouter } from "expo-router";
import type { CardData } from "./media";
import { toastError } from "./ui";
import { api, img, type MediaBrief } from "@/lib/api";
import { colors } from "@/lib/theme";
import { track } from "@/lib/track";

export interface DiscoverItem extends MediaBrief { source: string; sourceId: string }

export function useOpenMedia() {
  const router = useRouter();
  return async (m: { type: "movie" | "tv"; tmdbid: number | null; title: string; year: string }) => {
    if (m.tmdbid) {
      router.push({ pathname: "/media/[type]/[id]", params: { type: m.type, id: String(m.tmdbid) } });
      return;
    }
    // Bangumi / Douban entries: find the TMDb item first.
    try {
      const r = await api<{ tmdbid: number; type: "movie" | "tv" }>(`/v1/media/resolve?title=${encodeURIComponent(m.title)}&year=${m.year}&type=${m.type}`);
      track("discover_resolve", { ok: true });
      router.push({ pathname: "/media/[type]/[id]", params: { type: r.type, id: String(r.tmdbid) } });
    } catch (e) {
      track("discover_resolve", { ok: false });
      toastError("没有找到对应的 TMDb 条目", e);
    }
  };
}

export function mediaCard(m: MediaBrief, open: () => void, rank?: number): CardData {
  return {
    rank,
    key: `${m.type}:${m.tmdbid ?? m.title}`,
    title: m.title,
    subtitle: [m.year, m.type === "movie" ? "电影" : "剧集"].filter(Boolean).join(" · "),
    overview: m.overview,
    poster: img(m.poster),
    rating: m.vote || undefined,
    badge: m.library ? { text: `已入库 · ${m.library.lib}`, color: colors.success } : undefined,
    link: m.tmdbid ? { name: "TMDb 页面", url: `https://www.themoviedb.org/${m.type === "movie" ? "movie" : "tv"}/${m.tmdbid}` } : undefined,
    onPress: open,
  };
}
