// Adult catalogs (AV / 里番 index) and online stream sources, served by the backend's provider
// registry (/v1/catalog, server/src/catalog). New sources appear here without app changes.
import { useRouter } from "expo-router";
import type { CardData } from "@/components/media";
import { toastError } from "@/components/ui";
import { api, img } from "./api";
import { colors } from "./theme";
import { track } from "./track";

export type CatalogKind = "av" | "hentai";

export interface CatalogItem {
  id: string;
  title: string;
  code?: string;
  subtitle?: string;
  poster: string | null;
  posterCrop?: "right";
  posterAspect?: number;
  landscape?: string | null;
  rating: number | null;
  votes?: number;
  views?: number;
  date: string | null;
  added?: string | null;
  tags: string[];
  people?: { id: string; name: string }[];
  inLibrary?: boolean;
  blurb?: string;
}

export interface CatalogDetail extends CatalogItem {
  sourceUrl?: string;
  sourceName?: string;
  previews?: { thumb: string; full: string }[];
  overview: string;
  originalTitle?: string;
  brand?: string;
  facts: { label: string; value: string }[];
  episodes: CatalogItem[];
  keyword: string;
}

export interface Person { id: string; name: string; count: number | null; latest: string | null; poster: string | null; aliases?: string }
export interface ListQuery { sort?: string; tag?: string; person?: string; q?: string; since?: string }
export interface HomeRow { id: string; title: string; query: ListQuery; items: CatalogItem[] }
type SortOpt = { id: string; label: string };
export interface ProviderInfo { id: string; name: string; kind: CatalogKind; note: string; sorts: SortOpt[]; personSorts: SortOpt[]; personIndexSorts: SortOpt[]; tagFilter: boolean; people: boolean }
export interface LibraryHit { embyId: string; folder: boolean; note?: string }

// One way to watch a work: `embyId` plays through Emby, `ref` is resolved by its provider first.
export interface StreamSource { provider: string; label: string; note?: string; embyId?: string; embyFolder?: boolean; ref?: string }

export const PROVIDER_FOR: Record<CatalogKind, string> = { av: "javdb", hentai: "hanime" };
// AV has several indexes; 发现 → AV shows a switch between them.
export const AV_PROVIDERS = [{ value: "javdb", label: "JavDB 排行" }, { value: "jable", label: "Jable 热门" }, { value: "emby-av", label: "我的库" }];

export const catalogApi = {
  providers: () => api<{ providers: ProviderInfo[] }>("/v1/catalog"),
  home: (p: string) => api<{ rows: HomeRow[] }>(`/v1/catalog/${p}/home`, { timeoutMs: 60_000 }),
  list: (p: string, q: ListQuery, page: number, size = 30) =>
    api<{ items: CatalogItem[]; total: number; hasMore: boolean }>(`/v1/catalog/${p}/list?${qs({ ...q, page, size })}`, { timeoutMs: 60_000 }),
  tags: (p: string) => api<{ tags: { name: string; count: number }[] }>(`/v1/catalog/${p}/tags`),
  persons: (p: string, sort: string, page = 1) => api<{ items: Person[]; hasMore: boolean }>(`/v1/catalog/${p}/persons?${qs({ sort, page })}`, { timeoutMs: 90_000 }),
  item: (p: string, id: string) => api<{ item: CatalogDetail; kind: CatalogKind; library: LibraryHit | null; moreStreams: boolean }>(`/v1/catalog/${p}/item/${encodeURIComponent(id)}`, { timeoutMs: 60_000 }),
  streams: (p: string, id: string) => api<{ streams: StreamSource[]; errors: string[] }>(`/v1/catalog/${p}/item/${encodeURIComponent(id)}/streams`, { timeoutMs: 120_000 }),
};

export function qs(o: Record<string, string | number | undefined>) {
  return Object.entries(o).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");
}

export const listKey = (p: string, q: ListQuery) => `catalog:${p}:list:${qs({ ...q })}`;

export function catalogCard(c: CatalogItem, onPress: () => void): CardData {
  return {
    key: c.id,
    title: c.code ? `${c.code} ${c.title}` : c.title,
    subtitle: c.code ? [c.people?.map((p) => p.name).slice(0, 2).join("、"), c.date?.slice(0, 4)].filter(Boolean).join(" · ") : [c.subtitle, c.views ? `${compact(c.views)} 次播放` : ""].filter(Boolean).join(" · "),
    poster: img(c.poster),
    posterRight: c.posterCrop === "right",
    aspect: c.posterAspect,
    rating: c.rating ?? undefined,
    tags: c.tags.slice(0, 3),
    overview: c.blurb,
    badge: c.inLibrary ? { text: "已入库", color: colors.success } : c.tags.includes("中文字幕") ? { text: "中字", color: colors.primary } : undefined,
    onPress,
  };
}

export function compact(n: number) {
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1)} 亿`;
  if (n >= 10_000) return `${(n / 10_000).toFixed(n >= 100_000 ? 0 : 1)} 万`;
  return String(n);
}

export function useOpenCatalog(provider: string) {
  const router = useRouter();
  return (c: CatalogItem) => router.push({ pathname: "/catalog/[p]/item/[id]", params: { p: provider, id: c.id } });
}

// Online sources are resolved by the player itself (links expire, so right before playing).
// A work already in Emby plays (or opens) there instead.
export function usePlaySource() {
  const router = useRouter();
  return {
    online: (s: StreamSource, title: string) => {
      track("catalog_play", { provider: s.provider });
      if (s.ref) router.push({ pathname: "/player", params: { stream: s.provider, ref: s.ref, title } });
      else toastError("无法播放", "这个播放源没有可用的地址");
    },
    library: (l: LibraryHit) => {
      track("catalog_play", { provider: "emby" });
      if (l.folder) router.push({ pathname: "/emby/[id]", params: { id: l.embyId } });
      else router.push({ pathname: "/player", params: { id: l.embyId, resume: "1" } });
    },
  };
}
