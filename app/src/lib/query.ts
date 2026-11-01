// Tiny data cache: one entry per key, shared by every screen that asks for it, so going back
// to a list shows the last data at once while it refreshes. Screens poll only while focused.
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { AppState, Platform } from "react-native";
import { useFocusEffect } from "expo-router";
import { File, Paths } from "expo-file-system";

interface Entry<T> {
  data?: T;
  error?: string;
  errorCode?: string;       // ApiError.code, e.g. "login_required"
  loading: boolean;
  at: number;
  seq: number;
}

const entries = new Map<string, Entry<unknown>>();
const listeners = new Map<string, Set<() => void>>();
const EMPTY: Entry<unknown> = { loading: false, at: 0, seq: 0 };

// Entries with data are mirrored to one JSON file so a cold start without network still shows the
// last lists/details (each entry keeps its fetch time, so it is refreshed as soon as the network is back).
const STORE_MAX = 6_000_000;
// expo-file-system has no web implementation (constructing a File throws there): memory only on web.
const store = Platform.OS === "web" ? null : new File(Paths.document, "query-cache.json");
let saveTimer: ReturnType<typeof setTimeout> | null = null;

try {
  if (store?.exists) {
    const saved = JSON.parse(store.textSync()) as Record<string, { data: unknown; at: number }>;
    for (const [k, v] of Object.entries(saved)) if (v && v.data !== undefined) entries.set(k, { data: v.data, loading: false, at: v.at || 0, seq: 0 });
  }
} catch {
  // a corrupt cache file is just an empty cache
}

function save() {
  saveTimer = null;
  try {
    const live = [...entries.entries()].filter(([k, e]) => e.data !== undefined && !k.endsWith("#more")).sort((a, b) => b[1].at - a[1].at);
    const out: Record<string, { data: unknown; at: number }> = {};
    let size = 0;
    for (const [k, e] of live) {
      const j = JSON.stringify(e.data);
      if (size + j.length > STORE_MAX) continue;
      size += j.length;
      out[k] = { data: e.data, at: e.at };
    }
    if (!store) return;
    if (!store.exists) store.create({ intermediates: true });
    store.write(JSON.stringify(out));
  } catch {
    // disk full / unwritable: keep running on memory only
  }
}

function emit(key: string) {
  listeners.get(key)?.forEach((l) => l());
}

function set(key: string, patch: Partial<Entry<unknown>>) {
  entries.set(key, { ...(entries.get(key) ?? EMPTY), ...patch });
  if ("data" in patch && !saveTimer) saveTimer = setTimeout(save, 3000);
  emit(key);
}

export async function load<T>(key: string, fn: () => Promise<T>): Promise<T | undefined> {
  const seq = (entries.get(key)?.seq ?? 0) + 1;
  set(key, { loading: true, seq });
  try {
    const data = await fn();
    if (entries.get(key)?.seq === seq) set(key, { data, error: undefined, errorCode: undefined, loading: false, at: Date.now() });
    return data;
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    if (entries.get(key)?.seq === seq) set(key, { error: e instanceof Error ? e.message : String(e), errorCode: typeof code === "string" ? code : undefined, loading: false });
    return undefined;
  }
}

// Change cached data in place (optimistic updates after an action).
export function mutate<T>(key: string, fn: (d: T | undefined) => T | undefined) {
  const cur = entries.get(key) as Entry<T> | undefined;
  set(key, { data: fn(cur?.data) });
}

// ---------- clearing, and the server's say over the cache ----------
// clearAll empties memory and the disk mirror; mounted screens load again at once (generation bump). The server
// sends `x-cache-epoch` with every answer: a new epoch means "drop what you cached" (api.ts → noteCacheHeaders),
// and `x-cache-max-age` caps how long any list counts as fresh.
let generation = 0;
const genListeners = new Set<() => void>();
let maxAgeMs = Infinity;
const epochFile = Platform.OS === "web" ? null : new File(Paths.document, "cache-epoch.txt");
let epoch: string | null = (() => {
  try {
    return epochFile?.exists ? epochFile.textSync().trim() : null;
  } catch {
    return null;
  }
})();

export function clearAll() {
  entries.clear();
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  try {
    if (store?.exists) store.delete();
  } catch {
    // nothing to delete
  }
  generation++;
  genListeners.forEach((l) => l());
  for (const k of listeners.keys()) emit(k);
}

export function noteCacheHeaders(epochHeader: string | null, maxAgeHeader: string | null) {
  const secs = Number(maxAgeHeader);
  maxAgeMs = maxAgeHeader && secs > 0 ? secs * 1000 : Infinity;
  if (!epochHeader || epochHeader === epoch) return;
  const first = epoch === null;
  epoch = epochHeader;
  try {
    if (epochFile && !epochFile.exists) epochFile.create({ intermediates: true });
    epochFile?.write(epochHeader);
  } catch {
    // keeps working from memory
  }
  if (!first || entries.size) clearAll();
}

function useGeneration() {
  return useSyncExternalStore(
    (l) => {
      genListeners.add(l);
      return () => genListeners.delete(l);
    },
    () => generation,
  );
}

export function invalidate(prefix: string) {
  for (const k of entries.keys()) if (k.startsWith(prefix)) set(k, { at: 0 });
}

function useEntry<T>(key: string | null): Entry<T> {
  const k = key ?? "";
  return useSyncExternalStore(
    (l) => {
      if (!listeners.has(k)) listeners.set(k, new Set());
      listeners.get(k)!.add(l);
      return () => listeners.get(k)?.delete(l);
    },
    () => (key ? (entries.get(k) as Entry<T> | undefined) ?? (EMPTY as Entry<T>) : (EMPTY as Entry<T>)),
  );
}

export function useQuery<T>(key: string | null, fn: () => Promise<T>, opts: { interval?: number; staleMs?: number } = {}) {
  const k = key ?? "";
  const entry = useEntry<T>(key);
  // fn changes every render; only the key decides what is fetched, the latest fn runs.
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  });
  const refresh = useCallback(async () => {
    if (key) await load(k, () => fnRef.current());
  }, [key, k]);
  const stale = Math.min(opts.staleMs ?? 15_000, maxAgeMs);
  // the whole cache was cleared (设置 → 清除缓存, or a new server epoch): load again even though nothing refocused
  const gen = useGeneration();
  useEffect(() => {
    if (gen && key && !entries.get(k)) void refresh();
  }, [gen, key, k, refresh]);

  useFocusEffect(
    useCallback(() => {
      if (!key) return;
      const e = entries.get(k);
      if (!e || (!e.loading && Date.now() - e.at > stale)) void refresh();
      if (!opts.interval) return;
      const t = setInterval(() => {
        if (AppState.currentState === "active" && !entries.get(k)?.loading) void refresh();
      }, opts.interval);
      return () => clearInterval(t);
    }, [key, k, refresh, stale, opts.interval]),
  );

  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active" && key && Date.now() - (entries.get(k)?.at ?? 0) > stale) void refresh();
    });
    return () => sub.remove();
  }, [key, k, refresh, stale]);

  return { data: entry.data, error: entry.error, errorCode: entry.errorCode, loading: entry.loading, refresh, at: entry.at };
}

interface Pages<T> {
  items: T[];
  page: number;
  done: boolean;
  total?: number;
}

// A page fetcher returns the page's items, optionally with the total count (Emby does).
type PageResult<T> = T[] | { items: T[]; total?: number };
const unpack = <T,>(r: PageResult<T>) => (Array.isArray(r) ? { items: r, total: undefined } : r);

function append<T>(items: T[], add: T[], id: (t: T) => string): T[] {
  const seen = new Set(items.map(id));
  return [...items, ...add.filter((t) => !seen.has(id(t)) && !!seen.add(id(t)))];
}

// Paged list that grows in place: `more()` fetches only the next page and appends it. A refresh
// (focus, pull, cold start from the disk cache) re-fetches every page loaded so far (in parallel, up to
// REFRESH_PAGES) and rebuilds the list from them, so coming back doesn't shrink the list and items
// deleted or renamed at the source drop out (keeping old pages behind page 1 used to show deleted
// 里番 entries indefinitely).
const REFRESH_PAGES = 10;
export function usePaged<T>(
  key: string,
  fetchPage: (page: number) => Promise<PageResult<T>>,
  opts: { id: (t: T) => string; pageSize?: number; maxPages?: number; staleMs?: number },
) {
  const fetchRef = useRef(fetchPage);
  const idRef = useRef(opts.id);
  useEffect(() => {
    fetchRef.current = fetchPage;
    idRef.current = opts.id;
  });
  const max = opts.maxPages ?? 50;
  const finished = (got: number, added: number, page: number, have: number, total?: number) =>
    got === 0 || added === 0 || (total !== undefined ? have >= total : !!opts.pageSize && got < opts.pageSize) || page >= max;
  const q = useQuery<Pages<T>>(
    key,
    async () => {
      const cur = entries.get(key)?.data as Pages<T> | undefined;
      const pages = Math.min(Math.max(cur?.page ?? 1, 1), REFRESH_PAGES);
      const got = (await Promise.all(Array.from({ length: pages }, (_, i) => fetchRef.current(i + 1)))).map(unpack);
      const total = got[0].total;
      let items: T[] = [];
      let done = false;
      let page = 0;
      for (const g of got) {
        page++;
        const before = items.length;
        items = append(items, g.items, idRef.current);
        if (finished(g.items.length, items.length - before, page, items.length, total ?? got[got.length - 1].total)) {
          done = true;
          break;
        }
      }
      return { items, page, total, done };
    },
    { staleMs: opts.staleMs },
  );
  const moreKey = `${key}#more`;
  const moreEntry = useEntry<boolean>(moreKey);
  const more = useCallback(async () => {
    const cur = entries.get(key)?.data as Pages<T> | undefined;
    if (!cur || cur.done || entries.get(moreKey)?.loading) return;
    await load(moreKey, async () => {
      const page = cur.page + 1;
      const { items: got, total } = unpack(await fetchRef.current(page));
      const now = (entries.get(key)?.data as Pages<T> | undefined) ?? cur;
      const items = append(now.items, got, idRef.current);
      const t = total ?? now.total;
      set(key, { data: { items, page, total: t, done: finished(got.length, items.length - now.items.length, page, items.length, t) } });
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, moreKey, max, opts.pageSize]);
  return {
    items: q.data?.items ?? [],
    hasData: !!q.data,
    total: q.data?.total,
    loading: q.loading,
    error: q.error,
    errorCode: q.errorCode,
    moreError: moreEntry.error,
    refresh: q.refresh,
    more,
    // For scroll triggers: doesn't retry by itself after a failed page (the footer offers 重试).
    autoMore: () => {
      if (!entries.get(moreKey)?.error) void more();
    },
    loadingMore: moreEntry.loading,
    hasMore: !!q.data && !q.data.done,
  };
}

// ScrollView props for infinite scroll: calls `more` when the user nears the bottom, and also when
// the loaded content is still shorter than the screen (nothing to scroll, so no scroll events).
export function useAutoMore(more: () => void, threshold = 800) {
  const box = useRef({ view: 0, content: 0, y: 0 });
  const moreRef = useRef(more);
  useEffect(() => {
    moreRef.current = more;
  });
  return useMemo(() => {
    const b = box.current;
    const check = () => {
      if (b.view && b.content && b.content - b.y - b.view < threshold) moreRef.current();
    };
    return {
      scrollEventThrottle: 200,
      onScroll: (e: { nativeEvent: { contentOffset: { y: number }; contentSize: { height: number }; layoutMeasurement: { height: number } } }) => {
        b.y = e.nativeEvent.contentOffset.y;
        b.content = e.nativeEvent.contentSize.height;
        b.view = e.nativeEvent.layoutMeasurement.height;
        check();
      },
      onLayout: (e: { nativeEvent: { layout: { height: number } } }) => {
        b.view = e.nativeEvent.layout.height;
        check();
      },
      onContentSizeChange: (_w: number, h: number) => {
        b.content = h;
        check();
      },
    };
  }, [threshold]);
}
