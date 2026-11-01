// Casting a show as a playlist: from the chosen episode to the end of the series (seasons in order, specials
// left out), so the TV goes on to the next episode by itself. The TV has no "next track" command over DLNA
// but plays a playlist URL in order: the backend keeps the list (POST /v1/cast/playlist) at a short-lived
// public URL; each entry is the episode's own direct-play Emby link, as a single cast (quality and
// subtitles unchanged). Whether a TV plays playlists is what it declares over standard DLNA
// (ConnectionManager.GetProtocolInfo, dlna.ts playlistMime): one that doesn't gets the episode alone.
import { api } from "./api";
import { cast, playlistMime, type Renderer } from "./dlna";
import { embyApi, playbackPlan, type Item } from "./emby";
import { logger } from "./log";
import { getSettings } from "./settings";

const log = logger("cast-queue");
const MAX = 30;

export const epTitle = (e: Item) => `${e.SeriesName ?? ""} 第${e.ParentIndexNumber ?? 1}季第${e.IndexNumber ?? "?"}集${e.Name ? ` ${e.Name}` : ""}`.trim();

/** The episodes from this one on (up to MAX), or null when the item isn't an episode of a series. */
export async function queueFrom(itemId: string): Promise<Item[] | null> {
  const ep = await embyApi.item(itemId);
  if (ep.Type !== "Episode" || !ep.SeriesId) return null;
  const all = (await embyApi.episodes(ep.SeriesId)).Items.filter((e) => (e.ParentIndexNumber ?? 0) > 0);
  const i = all.findIndex((e) => e.Id === ep.Id);
  return i < 0 ? [ep] : all.slice(i, i + MAX);
}

/** Build the playlist's stream links (a few at a time) and store it; returns the URL the TV fetches. */
export async function playlistUrl(eps: Item[]): Promise<string> {
  const urls: string[] = new Array(eps.length);
  for (let i = 0; i < eps.length; i += 4) {
    await Promise.all(eps.slice(i, i + 4).map(async (e, j) => { urls[i + j] = (await playbackPlan(e.Id, 0)).uri; }));
  }
  const r = await api<{ path: string }>("/v1/cast/playlist", {
    method: "POST",
    body: { items: eps.map((e, i) => ({ url: urls[i], title: epTitle(e), duration: e.RunTimeTicks ? Math.round(e.RunTimeTicks / 1e7) : 0 })) },
  });
  return getSettings().server + r.path;
}

/**
 * Cast a show from this episode on: as a playlist when the TV declares M3U support and there are more
 * episodes, else the episode alone (`reason` says why). Returns what was cast.
 */
export async function castSeries(tv: Renderer, eps: Item[], at = 0): Promise<{ mode: "playlist" | "single"; count: number; reason?: string }> {
  const first = eps[0];
  const mime = eps.length > 1 ? await playlistMime(tv) : null;
  if (mime) {
    const url = await playlistUrl(eps);
    log.info("cast playlist", { tv: tv.name, n: eps.length, mime });
    await cast.load(tv, url, `${epTitle(first)} 起 ${eps.length} 集`, at, mime);
    return { mode: "playlist", count: eps.length };
  }
  const plan = await playbackPlan(first.Id, at);
  await cast.load(tv, plan.uri, epTitle(first), at);
  return { mode: "single", count: 1, ...(eps.length > 1 ? { reason: "这台电视不支持播放列表，只投了这一集" } : {}) };
}
