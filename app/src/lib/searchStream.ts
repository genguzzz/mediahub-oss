// Progressive smart search over SSE (/v1/search/stream): the server pushes the whole sorted result list each time a
// source (keyword × indexer) answers. Scrolling to the end asks for the next page of the sources whose last page
// worked (more()); the update arrives on the same stream. Leaving the screen or stop() closes the stream, which
// tells the server this viewer left. refresh() searches again from scratch (force).
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type SearchResult } from "./api";
import { kfetch, pump, streamFetch } from "./sse";

export interface StreamTask { name: string; state: "queued" | "running" | "more" | "end" | "error" | "timeout" | "cancelled"; pages: number; raw: number; kept: number; ms: number | null; error: string | null }

interface Update extends SearchResult { type: "update"; v: number; busy: boolean; round: number; more: boolean; cancelled: boolean; tasks: StreamTask[] }

interface State { job: string | null; data: SearchResult | null; tasks: StreamTask[]; busy: boolean; round: number; more: boolean; error: string | null; open: boolean }

const EMPTY: State = { job: null, data: null, tasks: [], busy: true, round: 0, more: false, error: null, open: false };

export function useSmartStream(key: string | null, query: { tmdbid?: number; type: string; season?: number | null }) {
  const [st, setSt] = useState<State>(EMPTY);
  const [run, setRun] = useState(0);
  const force = useRef(false);
  const abort = useRef<AbortController | null>(null);
  const q = useRef(query);
  q.current = query;

  useEffect(() => {
    if (!key || !q.current.tmdbid) return;
    const ac = new AbortController();
    abort.current = ac;
    setSt({ ...EMPTY, open: true });
    const { tmdbid, type, season } = q.current;
    const qs = `tmdbid=${tmdbid}&type=${type}${season != null ? `&season=${season}` : ""}${force.current ? "&force=1" : ""}`;
    force.current = false;
    void (async () => {
      try {
        const r = await kfetch(`/v1/search/stream?${qs}`, { signal: ac.signal, headers: { accept: "text/event-stream" } }, await streamFetch());
        if (!r.ok) {
          const body = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error || `服务器返回 ${r.status}`);
        }
        await pump(r, (ev: { type: string; job?: string; error?: string }) => {
          if (ac.signal.aborted) return;
          if (ev.type === "job") setSt((s) => ({ ...s, job: ev.job ?? null }));
          else if (ev.type === "error") setSt((s) => ({ ...s, error: ev.error || "搜索出错", busy: false }));
          else if (ev.type === "update") {
            const u = ev as unknown as Update;
            setSt((s) => ({
              ...s,
              data: u.results ? { ok: true, error: u.error ?? null, elapsed: u.elapsed, mode: "smart", season: u.season, media: u.media, library: u.library, groups: u.groups, sources: u.sources, results: u.results } : s.data,
              error: !u.results && u.error ? u.error : s.error,
              tasks: u.tasks, busy: u.busy, round: u.round, more: u.more,
            }));
          }
        }, () => {});
      } catch (e) {
        if (!ac.signal.aborted) setSt((s) => ({ ...s, error: e instanceof Error ? e.message : String(e), busy: false }));
      } finally {
        if (!ac.signal.aborted) setSt((s) => ({ ...s, open: false, busy: false }));
      }
    })();
    return () => ac.abort();
  }, [key, run]);

  const more = useCallback(() => {
    if (!st.job || st.busy || !st.more || !st.open) return;
    setSt((s) => ({ ...s, busy: true }));
    void api<{ ok: boolean; started?: number; error?: string }>("/v1/search/stream/more", { body: { job: st.job } })
      .then((r) => { if (!r.ok || !r.started) setSt((s) => ({ ...s, busy: false, more: r.ok ? false : s.more, error: r.ok ? s.error : r.error ?? s.error })); })
      .catch(() => setSt((s) => ({ ...s, busy: false })));
  }, [st.job, st.busy, st.more, st.open]);

  const stop = useCallback(() => {
    abort.current?.abort();
    setSt((s) => ({ ...s, busy: false, open: false, more: false }));
  }, []);

  const refresh = useCallback(() => { force.current = true; setRun((n) => n + 1); }, []);

  const finished = st.tasks.filter((t) => t.state !== "running" && t.state !== "queued").length;
  return {
    data: st.data ?? undefined,
    loading: st.open && st.busy && st.round <= 1,
    loadingMore: st.busy && st.round > 1,
    busy: st.busy,
    hasMore: st.open && st.more,
    open: st.open,
    error: st.error ?? undefined,
    tasks: st.tasks,
    progress: st.tasks.length ? { done: finished, total: st.tasks.length } : null,
    more, stop, refresh,
  };
}
