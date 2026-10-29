"""批量入库：一批作品 → 识别 → 按季精确搜索 → 选片策略挑选 → 下载（经插件下载钩子进 115）/ 订阅在播季。

API：POST /api/v1/plugin/Prowlarr115/batch   （apikey 或 bear）
  {"items": [
     {"tmdbid": 94664, "type": "tv", "seasons": [2, 3]},          # seasons 省略=全部（不含第 0 季）
     {"title": "命运石之门", "year": 2011, "type": "tv"},              # 没有 tmdbid 时按名字识别
     {"tmdbid": 372058, "type": "movie"}
   ],
   "mode": "download" | "subscribe" | "auto",   # auto：已播完的季下载，在播的季订阅（默认）
   "replace": false,                             # true：库里已有的季也重下（升级画质）
   "dry_run": false}                             # true：只返回会选哪些资源
  -> {"job": "<id>"}；GET /batch?job=<id> 看进度和每季的选择理由
"""
import re
import threading
import time
import uuid
from datetime import date
from typing import Tuple, Any, Dict, List, Optional

from .policy import pick, runtime_minutes

JOBS: Dict[str, Dict[str, Any]] = {}


def _mtype(v: str):
    from app.schemas.types import MediaType
    return MediaType.MOVIE if str(v).lower() in ("movie", "电影", "m") else MediaType.TV


_SNAMES: Dict[int, tuple] = {}


def season_names(tmdbid: Any) -> Tuple[Dict[int, List[str]], Dict[int, int]]:
    """TMDb 每季的名字（中/英/日）和集数，缓存 6 小时。篇章制作品（物语系列、鬼灭）靠季名而不是季号区分发布。"""
    key = int(tmdbid or 0)
    hit = _SNAMES.get(key)
    if hit and time.time() - hit[0] < 6 * 3600:
        return hit[1], hit[2]
    names: Dict[int, List[str]] = {}
    counts: Dict[int, int] = {}
    try:
        from app.chain.tmdb import TmdbChain
        for x in TmdbChain().tmdb_seasons(tmdbid=key) or []:
            n = getattr(x, "season_number", None)
            if n is not None:
                names.setdefault(int(n), []).append(getattr(x, "name", "") or "")
                counts[int(n)] = int(getattr(x, "episode_count", 0) or 0)
    except Exception:  # noqa: BLE001
        pass
    for lang in ("en-US", "ja-JP"):
        try:
            from app.modules.themoviedb.tmdbapi import TmdbApi
            d = TmdbApi(language=lang).tv.details(key)
            for x in (d.get("seasons") if isinstance(d, dict) else getattr(d, "seasons", None)) or []:
                x = x if isinstance(x, dict) else getattr(x, "__dict__", {})
                if x.get("season_number") is not None and x.get("name"):
                    names.setdefault(int(x["season_number"]), []).append(x["name"])
        except Exception:  # noqa: BLE001
            pass
        # 特别篇的篇章：每集标题开头那段（「Tsukimonogatari: Yotsugi Doll」->「Tsukimonogatari」），
        # 标题写了这些的发布属于第 0 季，不能算进正片季（物语系列的憑物语曾被当成化物语）
        try:
            from app.modules.themoviedb.tmdbapi import TmdbApi
            sd = TmdbApi(language=lang).get_tv_season_detail(key, 0) or {}
            for ep in (sd.get("episodes") if isinstance(sd, dict) else []) or []:
                head = re.split(r"\s*[:：,，(（\-–]\s*|\s+Part\s|\s+第", (ep.get("name") or "").strip())[0]
                if head and not re.fullmatch(r"(?i)(episode|第)?\s*\d+\s*(话|話|集)?", head):
                    names.setdefault(0, []).append(head)
        except Exception:  # noqa: BLE001
            pass
    names = {k: list(dict.fromkeys(v)) for k, v in names.items()}
    _SNAMES[key] = (time.time(), names, counts)
    return names, counts


def _recognize(item: Dict[str, Any]):
    """tmdbid 优先；否则按 片名 (年) 识别。"""
    from app.chain.media import MediaChain
    from app.schemas.types import MediaSource
    from app.domain.metainfo import MetaInfo
    mtype = _mtype(item.get("type", "tv"))
    if item.get("tmdbid"):
        return MediaChain().recognize_media(mtype=mtype, media_source=MediaSource.TMDB, media_id=str(item["tmdbid"]))
    title = f"{item.get('title', '')} {item.get('year') or ''}".strip()
    media = MediaChain().recognize_media(meta=MetaInfo(title=title, mtype=mtype), mtype=mtype)
    want = int(item.get("year") or 0)
    if media and (not want or int(media.year or 0) == want):
        return media
    # 年份不完全一致（「钢之炼金术师 FA 2009」被认成 2003 版；「【我推的孩子】2023」被认成 2024 真人剧）：
    # 在搜索候选里按类型挑，年份完全一致优先，其次 ±1；动画请求（"anime": true）优先动画
    _, cands = MediaChain().search(item.get("title", ""), mtype=mtype)
    cands = [m for m in cands or [] if getattr(m, "type", None) == mtype and getattr(m, "tmdb_id", None)]

    def rank(m):
        y = abs(int(getattr(m, "year", 0) or 0) - want) if want else 0
        anime = 16 in (getattr(m, "genre_ids", None) or [])
        return (y, 0 if (anime or not item.get("anime")) else 1)
    cands = sorted((m for m in cands if not want or abs(int(getattr(m, "year", 0) or 0) - want) <= 1), key=rank)
    if cands:
        return MediaChain().recognize_media(mtype=mtype, media_source=MediaSource.TMDB, media_id=str(cands[0].tmdb_id))
    return media if media and (not want or abs(int(media.year or 0) - want) <= 1) else None


def _siblings(media) -> List[str]:
    """同名的其他作品（重制版、续作、衍生作、同名剧场版）独有的名字。
    「狼与香辛料 (2008)」-> ["狼与香辛料 行商邂逅贤狼", "Spice and Wolf: Merchant Meets the Wise Wolf", ...]。"""
    from app.chain.media import MediaChain
    import unicodedata

    def norm(t):
        return re.sub(r"[\W_]+", "", unicodedata.normalize("NFKC", t or "").lower())
    ours = [norm(n) for n in [media.title, getattr(media, "original_title", None), getattr(media, "en_title", None)]
            + list(getattr(media, "names", None) or []) if n]
    short = re.split(r"\s*[～~:：\-－—（(]\s*", media.title or "")[0]
    out = []
    try:
        _, cands = MediaChain().search(short)
    except Exception:  # noqa: BLE001
        return []
    for m in cands or []:
        if getattr(m, "tmdb_id", None) == media.tmdb_id:
            continue
        for n in [m.title, getattr(m, "original_title", None), getattr(m, "en_title", None)]:
            k = norm(n)
            if len(k) >= 5 and not any(k in o for o in ours):
                out.append(n)
    return list(dict.fromkeys(out))


_EP_CACHE: Dict[tuple, tuple] = {}


def _episodes(media, season: int) -> List[tuple]:
    """TMDb 这一季的 [(集号, 播出日期)]（按 作品+季 缓存 1 小时：_aired/_airing 都要用）。"""
    key = (media.tmdb_id, season)
    hit = _EP_CACHE.get(key)
    if hit and time.time() - hit[0] < 3600:
        return hit[1]
    from app.chain.tmdb import TmdbChain
    out = []
    for ep in TmdbChain().tmdb_episodes(tmdbid=media.tmdb_id, season=season) or []:
        n = getattr(ep, "episode_number", None)
        if n:
            out.append((int(n), getattr(ep, "air_date", None) or ""))
    _EP_CACHE[key] = (time.time(), out)
    return out


def _season_year(media, season: int) -> Optional[int]:
    """本季首播年份（TMDb 分集日期）。"""
    try:
        ds = sorted(d for _, d in _episodes(media, season) if d)
        return int(ds[0][:4]) if ds else None
    except Exception:  # noqa: BLE001
        return None


def _aired(media, season: int) -> List[int]:
    """已经播出的集号（拿不到 TMDb 分集时用 MP 给的季集结构）。"""
    today = date.today().isoformat()
    try:
        return sorted({n for n, d in _episodes(media, season) if not d or d <= today})
    except Exception:  # noqa: BLE001
        return sorted(set((getattr(media, "seasons", None) or {}).get(season) or []))


def _airing(media, season: int) -> bool:
    """在播：有未来的集，或最后一集在 14 天内且剧没标完结。"""
    try:
        dates = [d for _, d in _episodes(media, season) if d]
    except Exception:  # noqa: BLE001
        return False
    if not dates:
        return False
    today = date.today()
    if max(dates) > today.isoformat():
        return True
    return (today - date.fromisoformat(max(dates))).days <= 14 and \
        str(getattr(media, "status", "")) not in ("Ended", "Canceled")


def _cour_starts(media, season: int) -> Dict[int, int]:
    """TMDb 合并季里各「字幕组季」的起始集号：相邻两集播出间隔 > 45 天就算新一季（文豪野犬 -> {1:1, 2:13, 3:25, 4:37, 5:50}）。"""
    eps = sorted((n, d) for n, d in _episodes(media, season) if d)
    out, k, prev = {1: 1}, 1, None
    for n, d in eps:
        if prev and (date.fromisoformat(d) - date.fromisoformat(prev)).days > 45:
            k += 1
            out[k] = n
        prev = d
    return out


def _emby_eps(plugin, media, season: Optional[int]) -> set:
    """Emby 里这一季已有的集号。"""
    p = plugin._pipe
    if not p or not media.tmdb_id:
        return set()
    d = p.emby.get("/Items", Recursive="true", IncludeItemTypes="Series", AnyProviderIdEquals=f"Tmdb.{media.tmdb_id}",
                   Fields="Path") or {}
    items = d.get("Items") or []
    if not items:
        return set()
    eps = (p.emby.get(f"/Shows/{items[0]['Id']}/Episodes") or {}).get("Items") or []
    have = {(int(e.get("ParentIndexNumber") or 0), int(e["IndexNumber"])) for e in eps if e.get("IndexNumber") is not None}
    # 动漫库按 TVDB 编号入库：换回 TMDb 编号再比
    inv = {}
    if p.tvdb_map and "/动漫/" in (items[0].get("Path") or ""):
        try:
            inv = {v: k for k, v in (plugin._tvdb_map(media.tmdb_id) or {}).items()}
        except Exception:  # noqa: BLE001
            inv = {}
    return {inv.get(x, x)[1] for x in have if inv.get(x, x)[0] == season}


def _emby_have(plugin, media, season: Optional[int]) -> int:
    """Emby 里这一季已有几集（电影：有没有）。"""
    p = plugin._pipe
    if not p or not media.tmdb_id:
        return 0
    from app.schemas.types import MediaType
    movie = media.type == MediaType.MOVIE
    d = p.emby.get("/Items", Recursive="true", IncludeItemTypes="Movie" if movie else "Series",
                   AnyProviderIdEquals=f"Tmdb.{media.tmdb_id}") or {}
    items = d.get("Items") or []
    if movie or not items:
        return len(items)
    return len(_emby_eps(plugin, media, season))


def _run(plugin, job: Dict[str, Any], items: List[Dict[str, Any]], mode: str, replace: bool, dry: bool) -> None:
    """多部作品并发处理（默认 4 线程；Prowlarr 全局并发另由插件限流），结束时发汇总通知。"""
    from concurrent.futures import ThreadPoolExecutor
    policy = plugin._policy()
    recs = [{"item": it, "seasons": []} for it in items]
    job["results"] = recs
    workers = max(1, int(plugin._conf.get("batch_workers") or 10))   # 番剧直连源不压 NAS，可以多开
    with ThreadPoolExecutor(max_workers=workers, thread_name_prefix=f"p115batch-{job['id']}") as pool:
        list(pool.map(lambda r: _one(plugin, job, r, mode, replace, dry, policy), recs))
    _finish(plugin, job, dry)


def _one(plugin, job, rec, mode, replace, dry, policy) -> None:
    from app.chain.download import DownloadChain
    from app.chain.search import SearchChain
    from app.chain.subscribe import SubscribeChain
    from app.schemas.types import MediaSource, MediaType
    item = rec["item"]
    t_item = time.time()
    if True:
        try:
            media = _recognize(item)
            if not media:
                rec["error"] = "识别失败"
                rec["t_total"] = round(time.time() - t_item, 1)
                return
            rec["media"] = f"{media.title} ({media.year}) TMDb {media.tmdb_id}"
            movie = media.type == MediaType.MOVIE
            snames, scounts = ({}, {}) if movie else season_names(media.tmdb_id)
            seasons = [None] if movie else sorted(int(s) for s in (item.get("seasons") or (media.seasons or {}).keys())
                                                  if int(s) > 0 or item.get("seasons"))
            sibs = _siblings(media)
            rec["siblings"] = sibs[:12]
            todo = [] if movie else [x for x in seasons
                                     if replace or _emby_have(plugin, media, x) < len(_aired(media, x) or [0])]
            for s in seasons:
                job["current"] = f"{media.title} {'' if s is None else f'S{s}'}"
                srec: Dict[str, Any] = {"season": s}
                rec["seasons"].append(srec)
                want = [] if movie else _aired(media, s)
                have = _emby_have(plugin, media, s)
                srec.update(aired=len(want), have=have)
                airing = (not movie) and _airing(media, s)
                if not replace and ((movie and have) or (not movie and want and have >= len(want))):
                    srec["action"] = "已齐，跳过"
                    if airing and mode in ("auto", "subscribe") and not dry:
                        sid, msg = SubscribeChain().add(title=media.title, year=media.year, mtype=media.type,
                                                        season=s, media_source=MediaSource.TMDB,
                                                        media_id=str(media.tmdb_id), exist_ok=True, source="Prowlarr115批量")
                        srec["action"] += f"；在播，已订阅 {sid or msg}"
                    continue
                if mode == "subscribe" or (mode == "auto" and airing):
                    if not dry:
                        sid, msg = SubscribeChain().add(title=media.title, year=media.year, mtype=media.type,
                                                        season=s, media_source=MediaSource.TMDB,
                                                        media_id=str(media.tmdb_id), exist_ok=True, source="Prowlarr115批量")
                        srec["action"] = f"订阅 {sid or ''} {msg or ''}".strip()
                    else:
                        srec["action"] = "将订阅（在播）"
                    if mode == "subscribe":
                        continue
                t0 = time.time()
                ctxs = SearchChain().search_by_id(media_source=MediaSource.TMDB, media_id=str(media.tmdb_id),
                                                  mtype=media.type, season=s) or []
                srec["t_search"] = round(time.time() - t0, 1)
                cands = [{"idx": i, "title": c.torrent_info.title, "size": c.torrent_info.size or 0,
                          "seeders": c.torrent_info.seeders or 0,
                          "episodes": list(getattr(c.meta_info, "episode_list", None) or [])}
                         for i, c in enumerate(ctxs)]
                for i, c in enumerate(ctxs):
                    cands[i]["season"] = getattr(c.meta_info, "begin_season", None)
                starts = None
                if not movie and scounts.get(s, 0) >= 30:
                    try:
                        starts = _cour_starts(media, s)
                        srec["season_starts"] = starts
                    except Exception:  # noqa: BLE001
                        starts = None
                res = pick(cands, "movie" if movie else "tv", policy, want, season=s, ep_minutes=runtime_minutes(media),
                           season_names=snames, season_counts=scounts, season_starts=starts,
                           sibling_names=sibs, want_seasons=todo,
                           season_year=_season_year(media, s) if not movie else None,
                           movie_year=media.year if movie else None,
                           movie_names=[media.title, getattr(media, "original_title", None), getattr(media, "en_title", None)]
                           + ([] if movie else list(getattr(media, "names", None) or [])[:12]))
                # 单集只补缺的集，不替换已有的；--replace（升级画质）只接受整季合集
                if not movie:
                    have_eps = _emby_eps(plugin, media, s)

                    def is_pack(c):
                        return not c.get("episodes") or len(c["episodes"]) >= 6
                    res["chosen"] = [c for c in res["chosen"]
                                     if (is_pack(c) and (replace or set(c.get("episodes") or want) - have_eps))
                                     or (not is_pack(c) and set(c["episodes"]) - have_eps)]
                srec["candidates"] = len(cands)
                srec["chosen"] = [{k: c[k] for k in ("title", "score", "why")} | {"size_gb": round(c["size"] / 1e9, 1), "ep_offset": c.get("ep_offset", 0), "season_starts": c.get("season_starts")}
                                  for c in res["chosen"]]
                srec["top"] = [f'{c["score"]:>6} {c["size"] / 1e9:5.1f}G {c["title"][:90]}' for c in res["ranked"][:6]]
                srec["missing"] = res["missing"]
                if not res["chosen"]:
                    srec["action"] = "没有符合策略的资源"
                    continue
                if dry:
                    srec["action"] = "dry-run"
                    continue
                if item.get("ep_offset"):
                    off = item["ep_offset"]
                    plugin._overrides[(str(media.tmdb_id), s)] = {"ep_offset": off.get(str(s), 0) if isinstance(off, dict) else off}
                dl = DownloadChain()
                ok = 0
                for c in res["chosen"]:
                    if c.get("ep_offset") or c.get("season_starts"):   # 合并季的分季合集：按种子记偏移，下载事件里取用
                        h = re.search(r"btih:([0-9a-fA-F]{40})", ctxs[c["idx"]].torrent_info.enclosure or "")
                        if h:
                            plugin._hash_overrides[h.group(1).lower()] = dict(
                                {k: c[k] for k in ("ep_offset", "season_starts") if c.get(k)}, merged_season=s,
                                ep_max=max(c.get("episodes") or [0]) or None)
                    hm = re.search(r"btih:([0-9a-fA-F]{40})", ctxs[c["idx"]].torrent_info.enclosure or "")
                    if hm and not movie and not (c.get("ep_offset") or c.get("season_starts")):
                        # 选片时已经确定是第 s 季：入库目录按这个季放，不再按发布标题重新解析
                        # （「Monogatari Series - Off & Monster Season - 05」标题没季号，会被当成第 1 季）
                        plugin._hash_overrides.setdefault(hm.group(1).lower(), {})["merged_season"] = s
                    if hm:   # 「搜索选片」节点：记下自动选片的依据，下载事件里写进任务
                        plugin._pick_info[hm.group(1).lower()] = {"by": "auto", "score": c.get("score"), "why": c.get("why") or [],
                                                                 "candidates": len(cands), "at": int(time.time())}
                    if dl.download_single(ctxs[c["idx"]], source="Prowlarr115批量"):
                        ok += 1
                if item.get("ep_offset"):
                    plugin._overrides.pop((str(media.tmdb_id), s), None)   # 只给这次批量用，不留给以后的下载（不落盘）
                srec["action"] = f"已提交 {ok}/{len(res['chosen'])} 个下载"
        except Exception as err:  # noqa: BLE001
            rec["error"] = str(err)
        rec["t_total"] = round(time.time() - t_item, 1)


def _finish(plugin, job, dry) -> None:
    job["status"] = "done"
    job["finished"] = int(time.time())
    job["elapsed"] = job["finished"] - job["started"]
    if not dry:
        lines = []
        for r in job["results"]:
            name = r.get("media") or r["item"].get("title") or r["item"].get("tmdbid")
            acts = "；".join(f"{'' if x['season'] is None else 'S' + str(x['season']) + ' '}{x.get('action', '')}"
                            for x in r["seasons"])
            lines.append(f"• {name}：{r.get('error') or acts}")
        plugin._post(f"📋 批量入库完成（{len(job['results'])} 部，用时 {job['elapsed'] // 60} 分 {job['elapsed'] % 60} 秒）",
                     "\n".join(lines)[:3500])


def start(plugin, body: Dict[str, Any]) -> Dict[str, Any]:
    items = body.get("items") or []
    if not items:
        return {"ok": False, "error": "items 为空"}
    jid = uuid.uuid4().hex[:8]
    job = {"id": jid, "status": "running", "started": int(time.time()), "results": [], "current": "",
           "mode": body.get("mode", "auto"), "dry_run": bool(body.get("dry_run"))}
    JOBS[jid] = job
    threading.Thread(target=_run, name=f"prowlarr115-batch-{jid}", daemon=True,
                     args=(plugin, job, items, body.get("mode", "auto"), bool(body.get("replace")),
                           bool(body.get("dry_run")))).start()
    return {"ok": True, "job": jid}


def status(job: Optional[str] = None) -> Any:
    if job:
        return JOBS.get(job) or {"error": "没有这个 job"}
    return [{k: v for k, v in j.items() if k != "results"} for j in JOBS.values()]
