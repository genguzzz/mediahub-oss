// TMDb / discover item → poster card, and opening one (Bangumi / Douban entries resolve to TMDb first).
import { useRouter } from "expo-router";
import type { CardData } from "./media";
import { Linking } from "react-native";
import { toast, toastError } from "./ui";
import { ApiError, api, img, type MediaBrief } from "@/lib/api";
import { colors } from "@/lib/theme";
import { track } from "@/lib/track";

export interface DiscoverItem extends MediaBrief { source: string; sourceId: string }

export function useOpenMedia() {
  const router = useRouter();
  return async (m: { type: "movie" | "tv"; tmdbid: number | null; title: string; year: string; source?: string; sourceId?: string }) => {
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
      if (!(e instanceof ApiError && e.status === 404)) {
        toastError("打开失败", e);
        return;
      }
      // Not on TMDb (yet): new 番 and Chinese web shows often are. It can still be found by title on the
      // sources, and read on the site it came from.
      const page = sourcePage(m.source, m.sourceId);
      toast("TMDb 还没有这部作品", `《${m.title}》没有详情页，可以按标题去资源站搜索`, [
        { label: "按来源搜索", onPress: () => router.push({ pathname: "/resources", params: { mode: "raw", type: m.type, keyword: m.title } }) },
        ...(page ? [{ label: page.name, onPress: () => void Linking.openURL(page.url) }] : []),
      ]);
    }
  };
}

function sourcePage(source?: string, id?: string) {
  if (!id) return null;
  if (source === "bangumi") return { name: "Bangumi 页面", url: `https://bgm.tv/subject/${id}` };
  if (source === "douban") return { name: "豆瓣页面", url: `https://movie.douban.com/subject/${id}/` };
  return null;
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
