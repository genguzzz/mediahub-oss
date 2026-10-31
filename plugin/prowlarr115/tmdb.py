"""TMDb data MoviePilot's REST API does not expose, read through MP's own TmdbApi (its key, proxy and language):
a person's whole filmography with roles (cast and crew), discover by network / company / keyword, a work's
keywords and its collection. Used by 发现 to browse by metadata (actor → works timeline, network → its shows…)."""
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

from app.sdk.logging import logger

IMG = "https://image.tmdb.org/t/p/w500"
TTL = 6 * 3600
DISCOVER_KEYS = {"with_networks", "with_companies", "with_keywords", "with_genres", "with_original_language",
                 "sort_by", "vote_count.gte", "first_air_date.gte", "first_air_date.lte",
                 "primary_release_date.gte", "primary_release_date.lte"}

_api = None
_lock = threading.Lock()
_cache: Dict[Tuple, Tuple[float, Any]] = {}


def _tmdb():
    global _api
    with _lock:
        if _api is None:
            from app.modules.themoviedb.tmdbapi import TmdbApi
            _api = TmdbApi()
        return _api


def _cached(key: Tuple, fn):
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < TTL:
        return hit[1]
    val = fn()
    if len(_cache) > 500:
        _cache.clear()
    _cache[key] = (time.time(), val)
    return val


def _img(p: Optional[str]) -> Optional[str]:
    return f"{IMG}{p}" if p else None


def brief(x: dict, kind: Optional[str] = None) -> Dict[str, Any]:
    """TMDb list entry → the backend's MediaBrief shape (type movie|tv)."""
    t = kind or ("movie" if x.get("media_type") == "movie" or x.get("title") else "tv")
    date = x.get("release_date") or x.get("first_air_date") or ""
    return {"tmdbid": x.get("id"), "type": t, "title": x.get("title") or x.get("name") or "",
            "originalTitle": x.get("original_title") or x.get("original_name") or "",
            "year": date[:4], "date": date, "poster": _img(x.get("poster_path")),
            "vote": round(float(x.get("vote_average") or 0), 1), "votes": int(x.get("vote_count") or 0),
            "overview": x.get("overview") or ""}


# Appearances as themself (talk shows, making-ofs, award ceremonies) and "thanks" credits: shown only on request.
_SELF = ("self", "himself", "herself", "本人", "自己")
_MINOR_JOBS = {"Thanks", "Special Thanks"}
_TALK_GENRES = {99, 10763, 10767}      # Documentary (making-ofs), News, Talk


def person(pid: int) -> Dict[str, Any]:
    def load():
        api = _tmdb()
        d = dict(api.person.details(pid, append_to_response="external_ids") or {})
        c = api.person.combined_credits(pid) or {}
        works: Dict[Tuple[str, int], Dict[str, Any]] = {}
        for role, rows in (("cast", c.get("cast") or []), ("crew", c.get("crew") or [])):
            for x in rows:
                kind = "movie" if x.get("media_type") == "movie" else "tv"
                key = (kind, x.get("id"))
                w = works.get(key)
                if not w:
                    w = works[key] = {**brief(x, kind), "roles": [], "dept": set(), "episodes": 0, "minor": True}
                if role == "cast":
                    ch = (x.get("character") or "").strip()
                    if ch and ch not in w["roles"]:
                        w["roles"].append(ch)
                    w["dept"].add("Acting")
                    w["episodes"] = max(w["episodes"], int(x.get("episode_count") or 0))
                    if not (ch.lower().startswith(_SELF) or set(x.get("genre_ids") or []) & _TALK_GENRES):
                        w["minor"] = False
                else:
                    job = x.get("job") or ""
                    if job not in _MINOR_JOBS:
                        w["minor"] = False
                    if job and job not in w["roles"]:
                        w["roles"].append(job)
                    w["dept"].add(x.get("department") or "Crew")
        out = []
        for w in works.values():
            w["dept"] = sorted(w["dept"])
            out.append(w)
        out.sort(key=lambda w: w["date"] or "9999", reverse=True)
        ext = d.get("external_ids") or {}
        return {
            "id": pid, "name": d.get("name") or "", "aka": list(d.get("also_known_as") or [])[:6],
            "birthday": d.get("birthday") or "", "deathday": d.get("deathday") or "",
            "place": d.get("place_of_birth") or "", "dept": d.get("known_for_department") or "",
            "bio": d.get("biography") or "", "photo": _img(d.get("profile_path")),
            "imdb": d.get("imdb_id") or ext.get("imdb_id") or "", "works": out,
        }
    return _cached(("person", pid), load)


def discover(kind: str, params: Dict[str, Any], page: int = 1) -> List[Dict[str, Any]]:
    q = tuple(sorted((k, str(v)) for k, v in params.items() if k in DISCOVER_KEYS and v not in (None, ""))) + (("page", page),)

    def load():
        api = _tmdb()
        rows = api.discover.discover_movies(q) if kind == "movie" else api.discover.discover_tv_shows(q)
        return [brief(dict(x), kind) for x in rows or []]
    return _cached(("discover", kind, q), load)


def extra(kind: str, tmdbid: int) -> Dict[str, Any]:
    """Keywords for a work, and for movies the collection it belongs to (with its parts, oldest first)."""
    def load():
        api = _tmdb()
        if kind == "movie":
            m = dict(api.movie.details(tmdbid, append_to_response="keywords") or {})
            kw = (m.get("keywords") or {}).get("keywords") or []
            col = m.get("belongs_to_collection")
            collection = None
            if col and col.get("id"):
                try:
                    parts = [brief(dict(p), "movie") for p in api.collection.details(col["id"]) or []]
                except Exception as err:  # noqa: BLE001
                    logger.warning(f"【Prowlarr115】取 TMDb 合集失败：{err}")
                    parts = []
                parts.sort(key=lambda p: p["date"] or "9999")
                collection = {"id": col["id"], "name": col.get("name") or "", "poster": _img(col.get("poster_path")), "parts": parts}
            return {"keywords": [{"id": k.get("id"), "name": k.get("name")} for k in kw], "collection": collection}
        kw = api.tv.keywords(tmdbid) or []
        return {"keywords": [{"id": k.get("id"), "name": k.get("name")} for k in kw], "collection": None}
    return _cached(("extra", kind, tmdbid), load)
