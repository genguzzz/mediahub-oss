// Tiny data cache: one entry per key, shared by every screen that asks for it, so going back
// to a list shows the last data at once while it refreshes. Screens poll only while focused.
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { useFocusEffect } from "expo-router";
import { File, Paths } from "expo-file-system";

interface Entry<T> {
  data?: T;
  error?: string;
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
const store = new File(Paths.document, "query-cache.json");
let saveTimer: ReturnType<typeof setTimeout> | null = null;

try {
  if (store.exists) {
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
    if (entries.get(key)?.seq === seq) set(key, { data, error: undefined, loading: false, at: Date.now() });
    return data;
  } catch (e) {
    if (entries.get(key)?.seq === seq) set(key, { error: e instanceof Error ? e.message : String(e), loading: false });
    return undefined;
  }
}

// Change cached data in place (optimistic updates after an action).
export function mutate<T>(key: string, fn: (d: T | undefined) => T | undefined) {
  const cur = entries.get(key) as Entry<T> | undefined;
  set(key, { data: fn(cur?.data) });
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
  const stale = opts.staleMs ?? 15_000;

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

  return { data: entry.data, error: entry.error, loading: entry.loading, refresh, at: entry.at };
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

// Paged list that grows in place: `more()` fetches only the next page and appends it, so the
// items already on screen never disappear. A refresh (focus, pull) re-fetches page 1 and keeps the
// pages loaded so far behind it, so coming back from a detail page doesn't shrink the list.
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
      const { items: first, total } = unpack(await fetchRef.current(1));
      const cur = entries.get(key)?.data as Pages<T> | undefined;
      const fresh = append([], first, idRef.current);
      if (!cur || cur.page <= 1) return { items: fresh, page: 1, total, done: finished(first.length, first.length, 1, fresh.length, total) };
      return { items: append(fresh, cur.items, idRef.current), page: cur.page, total: total ?? cur.total, done: cur.done };
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
