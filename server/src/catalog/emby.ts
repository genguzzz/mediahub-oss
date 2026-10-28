// The AV library in Emby as a catalog (MDC scraped 番号, actresses, genres, release dates), and Emby
// as a stream provider for both kinds: a work that is already in the library plays from there.
import type { CatalogDetail, CatalogItem, CatalogKind, CatalogProvider, HomeRow, ListQuery, Page, Person, StreamProvider, StreamSource } from "./types.ts";
import { normTitle } from "./hanime.ts";

export type EmbyGet = <T>(p: string, query?: Record<string, string | number | undefined>) => Promise<T | null>;

interface Item {
  Id: string; Name?: string; Type?: string; OriginalTitle?: string; Overview?: string; PremiereDate?: string; DateCreated?: string;
  ProductionYear?: number; CommunityRating?: number; Genres?: string[]; People?: { Id: string; Name: string; Type?: string }[];
  Studios?: { Name: string }[]; ImageTags?: Record<string, string>; BackdropImageTags?: string[]; IndexNumber?: number; ParentIndexNumber?: number;
  RunTimeTicks?: number; UserData?: { Played?: boolean };
}

const NOISE_GENRES = new Set(["单体作品", "高画质", "独占配信", "DMM独家", "4K"]);
const CODE = /^([A-Z0-9]{2,10}-\d{2,6}[A-Z]?)\s*/i;

function poster(i: Item) {
  const tag = i.ImageTags?.Primary;
  return tag ? `/v1/img/emby/${i.Id}?type=Primary&w=400&tag=${tag}` : null;
}

export function embyCatalog(embyGet: EmbyGet, libName = "AV"): CatalogProvider {
  let cache: { at: number; items: Item[] } | null = null;

  async function libId(): Promise<string | null> {
    const views = (await embyGet<{ Name: string; ItemId: string }[]>("/Library/VirtualFolders")) ?? [];
    return views.find((v) => v.Name === libName)?.ItemId ?? null;
  }

  async function all(): Promise<Item[]> {
    if (cache && Date.now() - cache.at < 5 * 60_000) return cache.items;
    const parent = await libId();
    if (!parent) return [];
    const r = await embyGet<{ Items: Item[] }>("/Items", {
      Recursive: "true", ParentId: parent, IncludeItemTypes: "Movie", Limit: 5000, SortBy: "DateCreated", SortOrder: "Descending",
      Fields: "People,Genres,CommunityRating,PremiereDate,DateCreated,Studios,Overview,OriginalTitle,ProductionYear", EnableImageTypes: "Primary,Backdrop,Thumb",
    });
    cache = { at: Date.now(), items: r?.Items ?? [] };
    return cache.items;
  }

  const actors = (i: Item) => (i.People ?? []).filter((p) => p.Type === "Actor");
  // MDC puts studio, label, series code and the actresses into Genres as well; keep the real genres.
  const genres = (i: Item) => {
    const names = new Set(actors(i).map((p) => p.Name));
    const code = CODE.exec(i.Name ?? "")?.[1]?.split("-")[0].toUpperCase();
    return (i.Genres ?? []).filter((g) => !names.has(g) && !/[:：]/.test(g) && g.toUpperCase() !== code && !NOISE_GENRES.has(g));
  };

  function card(i: Item): CatalogItem {
    const m = CODE.exec(i.Name ?? "");
    const code = m?.[1]?.toUpperCase();
    const people = actors(i).map((p) => ({ id: p.Id, name: p.Name }));
    return {
      id: i.Id, code, title: (m ? (i.Name ?? "").slice(m[0].length) : i.Name ?? "") || code || "",
      subtitle: [code, people.map((p) => p.name).slice(0, 2).join("、")].filter(Boolean).join(" · "),
      poster: poster(i), landscape: i.BackdropImageTags?.[0] ? `/v1/img/emby/${i.Id}?type=Backdrop&w=800&tag=${i.BackdropImageTags[0]}` : null,
      rating: i.CommunityRating ?? null, date: i.PremiereDate?.slice(0, 10) ?? null, added: i.DateCreated?.slice(0, 10) ?? null,
      tags: genres(i).slice(0, 6), people, blurb: (i.Overview ?? "").replace(/\s+/g, " ").slice(0, 140) || undefined,
    };
  }

  const SORTS: Record<string, (a: Item, b: Item) => number> = {
    added: (a, b) => String(b.DateCreated).localeCompare(String(a.DateCreated)),
    released: (a, b) => String(b.PremiereDate).localeCompare(String(a.PremiereDate)),
    rating: (a, b) => (b.CommunityRating ?? 0) - (a.CommunityRating ?? 0),
    code: (a, b) => String(a.Name).localeCompare(String(b.Name)),
  };

  async function allPersons(sort: string): Promise<Person[]> {
    const by = new Map<string, Person>();
    for (const i of await all()) {
      for (const a of actors(i)) {
        const p = by.get(a.Id) ?? { id: a.Id, name: a.Name, count: 0, latest: null, poster: null };
        p.count = (p.count ?? 0) + 1;
        const d = i.PremiereDate?.slice(0, 10) ?? null;
        if (d && (!p.latest || d > p.latest)) {
          p.latest = d;
          p.poster = poster(i) ?? p.poster; // no actress photos in the library: use her newest cover
        }
        p.poster ??= poster(i);
        by.set(a.Id, p);
      }
    }
    const list = [...by.values()];
    if (sort === "name") return list.sort((a, b) => a.name.localeCompare(b.name, "zh"));
    if (sort === "recent") return list.sort((a, b) => String(b.latest).localeCompare(String(a.latest)));
    return list.sort((a, b) => (b.count ?? 0) - (a.count ?? 0) || String(b.latest).localeCompare(String(a.latest)));
  }

  return {
    id: "emby-av",
    name: "媒体库 AV",
    kind: "av",
    note: "Emby AV 库（MDC 刮削的番号、女优、类别）",
    sorts: [{ id: "added", label: "入库" }, { id: "released", label: "发行" }, { id: "rating", label: "评分" }, { id: "code", label: "番号" }],
    personIndexSorts: [{ id: "count", label: "作品数" }, { id: "recent", label: "最近发行" }, { id: "name", label: "名字" }],
    tagFilter: true,

    async home(): Promise<HomeRow[]> {
      const items = await all();
      const top = (sort: string) => [...items].sort(SORTS[sort]).slice(0, 20).map(card);
      const rows: HomeRow[] = [
        { id: "added", title: "最近入库", query: { sort: "added" }, items: top("added") },
        { id: "released", title: "最新发行", query: { sort: "released" }, items: top("released") },
      ];
      if (items.some((i) => i.CommunityRating)) rows.push({ id: "rating", title: "评分最高", query: { sort: "rating" }, items: top("rating") });
      return rows;
    },

    async list(q: ListQuery): Promise<Page<CatalogItem>> {
      const needle = q.q?.trim().toLowerCase();
      const hits = (await all()).filter((i) =>
        (!q.tag || genres(i).includes(q.tag)) &&
        (!q.person || actors(i).some((p) => p.Id === q.person)) &&
        (!needle || (i.Name ?? "").toLowerCase().includes(needle) || actors(i).some((p) => p.Name.toLowerCase().includes(needle))) &&
        (!q.since || String(i.PremiereDate) >= q.since));
      hits.sort(SORTS[q.sort] ?? SORTS.added);
      const start = (q.page - 1) * q.size;
      return { items: hits.slice(start, start + q.size).map(card), total: hits.length, page: q.page, hasMore: start + q.size < hits.length };
    },

    async item(id: string): Promise<CatalogDetail | null> {
      const i = (await all()).find((x) => x.Id === id);
      if (!i) return null;
      const c = card(i);
      const director = (i.People ?? []).find((p) => p.Type === "Director")?.Name;
      const studio = i.Studios?.[0]?.Name;
      const minutes = i.RunTimeTicks ? Math.round(i.RunTimeTicks / 600_000_000) : 0;
      return {
        ...c,
        tags: genres(i),
        overview: i.Overview ?? "",
        originalTitle: i.OriginalTitle && i.OriginalTitle !== i.Name ? i.OriginalTitle : undefined,
        brand: studio,
        facts: [
          { label: "番号", value: c.code ?? "" },
          { label: "发行", value: c.date ?? "" },
          { label: "片商", value: studio ?? "" },
          { label: "导演", value: director ?? "" },
          { label: "时长", value: minutes ? `${minutes} 分钟` : "" },
          { label: "入库", value: c.added ?? "" },
        ].filter((f) => f.value),
        episodes: [],
        keyword: c.code ?? c.title,
      };
    },

    async tags() {
      const count = new Map<string, number>();
      for (const i of await all()) for (const g of genres(i)) count.set(g, (count.get(g) ?? 0) + 1);
      return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, count: n }));
    },

    async persons(sort: string, page: number) {
      const all = await allPersons(sort);
      return { items: page === 1 ? all : [], total: all.length, page, hasMore: false };
    },
  };
}

// The 里番 library: series named in Chinese with the Japanese title as OriginalTitle, episodes by
// part. `match` finds the series whose title is contained in a hanime entry's titles (longest wins,
// so "寝取られた爆乳妻たち2" beats "寝取られた爆乳妻たち").
export function hentaiLibrary(embyGet: EmbyGet) {
  let cache: { at: number; series: { id: string; norm: string }[] } | null = null;
  async function load() {
    if (cache && Date.now() - cache.at < 5 * 60_000) return cache.series;
    const views = (await embyGet<{ Name: string; ItemId: string }[]>("/Library/VirtualFolders")) ?? [];
    const lib = views.find((v) => v.Name === "里番")?.ItemId;
    const r = lib ? await embyGet<{ Items: Item[] }>("/Items", { Recursive: "true", ParentId: lib, IncludeItemTypes: "Series", Limit: 5000, Fields: "OriginalTitle" }) : null;
    const series = (r?.Items ?? []).map((i) => ({ id: i.Id, norm: normTitle(i.OriginalTitle || i.Name || "") })).filter((x) => x.norm.length >= 2);
    cache = { at: Date.now(), series };
    return series;
  }
  return {
    async matcher() {
      const series = await load();
      return (titles: string) => {
        let best: { id: string; norm: string } | undefined;
        for (const s of series) if (titles.includes(s.norm) && (!best || s.norm.length > best.norm.length)) best = s;
        return best?.id;
      };
    },
  };
}

// Works already in Emby play from Emby: AV by 番号 in the AV library, 里番 by title + part in the
// 里番 library.
export function embyStreams(embyGet: EmbyGet, hentai: ReturnType<typeof hentaiLibrary>): StreamProvider {
  const views = async () => (await embyGet<{ Name: string; ItemId: string }[]>("/Library/VirtualFolders")) ?? [];
  return {
    id: "emby",
    name: "Emby 媒体库",
    kinds: ["av", "hentai"],
    async find(item: CatalogDetail, kind: CatalogKind): Promise<StreamSource[]> {
      if (kind === "av") {
        if (!item.code) return [];
        const lib = (await views()).find((v) => v.Name === "AV")?.ItemId;
        const r = await embyGet<{ Items: Item[] }>("/Items", { Recursive: "true", ParentId: lib, IncludeItemTypes: "Movie", SearchTerm: item.code, Limit: 5 });
        return (r?.Items ?? []).filter((i) => (i.Name ?? "").toUpperCase().startsWith(item.code!)).map((i) => ({ provider: "emby", label: "Emby 媒体库", note: "原画直连", embyId: i.Id }));
      }
      const seriesId = (await hentai.matcher())(item.aliases ?? normTitle(item.title));
      if (!seriesId) return [];
      const part = Number(/(\d+)$/.exec(item.title)?.[1] ?? 1);
      const eps = (await embyGet<{ Items: Item[] }>(`/Shows/${seriesId}/Episodes`, {}))?.Items ?? [];
      const ep = eps.length === 1 ? eps[0] : eps.find((e) => e.IndexNumber === part);
      return ep
        ? [{ provider: "emby", label: "Emby 媒体库", note: eps.length > 1 ? `第 ${ep.IndexNumber ?? part} 集` : "已入库", embyId: ep.Id }]
        : [{ provider: "emby", label: "Emby 媒体库", note: "库里有这部，没有这一集", embyId: seriesId, embyFolder: true }];
    },
  };
}
