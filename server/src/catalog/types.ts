// Catalog = an index of adult works (AV, 里番) that is browsed by sort / tag / person, separate from
// TMDb. Streams = places a work can be watched online. Both are provider registries so new sources
// plug in without touching routes or the app: add a provider file and list it in catalog/index.ts.

export type CatalogKind = "av" | "hentai";

export interface CatalogItem {
  id: string;                 // provider-scoped id
  title: string;
  code?: string;              // AV 番号
  subtitle?: string;          // brand · year, episode, …
  poster: string | null;      // backend image path (/v1/img/...)
  posterCrop?: "right";       // poster is a wide DVD cover: the front is its right part
  posterAspect?: number;      // width / height of the poster image when it isn't 2:3
  landscape?: string | null;
  rating: number | null;      // 0..10
  votes?: number;
  views?: number;
  date: string | null;        // release date YYYY-MM-DD
  added?: string | null;      // when the source listed it
  tags: string[];
  people?: { id: string; name: string }[];
  inLibrary?: boolean;
  blurb?: string;             // short synopsis for list cards
}

export interface CatalogDetail extends CatalogItem {
  overview: string;
  originalTitle?: string;
  brand?: string;
  facts: { label: string; value: string }[];
  episodes: CatalogItem[];    // other parts of the same series, this one included
  keyword: string;            // what to search resources with (番号 / Japanese title)
  aliases?: string;           // every known title, for matching against the library
  sourceUrl?: string;         // the work's page at the index source (opened as H5 in the app)
  sourceName?: string;
  previews?: { thumb: string; full: string }[]; // sample screenshots
  refs?: Record<string, string>; // ids this work has at stream providers (jable slug, …)
}

export interface Person { id: string; name: string; count: number | null; latest: string | null; poster: string | null; aliases?: string }

export interface ListQuery { sort: string; tag?: string; person?: string; q?: string; since?: string; page: number; size: number }
export interface Page<T> { items: T[]; total: number; page: number; hasMore: boolean }

export interface HomeRow { id: string; title: string; query: Partial<ListQuery>; items: CatalogItem[] }

export interface CatalogProvider {
  id: string;
  name: string;
  kind: CatalogKind;
  note: string;                                  // where the data comes from, shown in the app
  sorts: { id: string; label: string }[];        // list sorts
  personSorts?: { id: string; label: string }[];  // list sorts when filtered to one person
  personIndexSorts?: { id: string; label: string }[]; // sorts of the person index itself
  tagFilter: boolean;                            // list() understands `tag`
  home(): Promise<HomeRow[]>;
  list(q: ListQuery): Promise<Page<CatalogItem>>;
  item(id: string): Promise<CatalogDetail | null>;
  tags(): Promise<{ name: string; count: number }[]>;
  persons?(sort: string, page: number): Promise<Page<Person>>;
}

// One way to watch a work. `emby` sources play through the normal Emby route in the app; web
// sources carry a `ref` the app sends to /v1/stream/:provider/resolve right before playing (links
// from web sources expire), which returns a URL plus the headers the CDN wants.
export interface StreamSource {
  provider: string;
  label: string;              // "Emby 媒体库"
  note?: string;              // "1080p", "第 2 集"
  embyId?: string;
  embyFolder?: boolean;       // embyId is a series, not a playable item: open it instead
  ref?: string;
}

export interface ResolvedStream { uri: string; headers: Record<string, string>; title?: string; poster?: string | null; expires?: number }

export interface StreamProvider {
  id: string;
  name: string;
  kinds: CatalogKind[];
  slow?: boolean;             // fetches pages to find sources: not part of the detail response
  find(item: CatalogDetail, kind: CatalogKind): Promise<StreamSource[]>;
  resolve?(ref: string): Promise<ResolvedStream>;
}
