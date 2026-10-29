"""App（影库）用的聚合接口 /hub/*：按来源搜资源（带字幕组、规格、打分、库里已有）、入库全流程进度、
115 离线 / NAS qBittorrent / OpenList 任务、Emby 媒体库代理。

凭据都留在插件配置里：App 后端只拿 MP 的 API key 调这些接口，不直接连 OpenList/qBittorrent 等服务。
"""
import re
import threading
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from typing import Any, Dict, List, Optional

from app.sdk.logging import logger
from app.sdk.network import RequestUtils

from fastapi import Body
from fastapi.responses import Response

from . import batch as batch_mod
from .adult import CAT_ANIME, CAT_REAL
from .adult import magnet as adult_magnet
from .adult import VIDEO as VIDEO_EXT
from .pipeline import STALL_AFTER, btih, ep_of
from .policy import features, pick, runtime_minutes, score, year_conflict
from .sources import animetosho, hex_magnet, mikan_rss, nyaa_limited

# 直连来源（后端直接访问，不经 Prowlarr）
DIRECT = [
    {"id": "nyaa", "name": "Nyaa", "kind": "direct", "note": "番剧，按做种数", "lang": "en", "privacy": "public",
     "tags": ["动漫", "外文"], "desc": "东亚媒体为主的公开站，番剧最全（含生肉、英字、合集），英文名/罗马音搜得最准"},
    {"id": "animetosho", "name": "AnimeTosho", "kind": "direct", "note": "Nyaa/AniDex 镜像，合集在前", "lang": "en", "privacy": "public",
     "tags": ["动漫", "外文"], "desc": "Nyaa、AniDex、TokyoTosho 的镜像，可按大小排序，老番 BD 合集不会被新单集挤掉"},
    {"id": "mikan", "name": "Mikan", "kind": "direct", "note": "中文字幕组，用中文名搜", "lang": "zh", "privacy": "public",
     "tags": ["动漫", "中文"], "desc": "蜜柑计划：中文字幕组的周更和合集，用中文名搜"},
    {"id": "sukebei-av", "name": "sukebei 真人", "kind": "adult", "note": "AV 番号", "lang": "ja", "privacy": "public",
     "tags": ["成人"], "desc": "sukebei.nyaa 真人分类，按番号搜"},
    {"id": "sukebei-anime", "name": "sukebei 动画", "kind": "adult", "note": "里番", "lang": "ja", "privacy": "public",
     "tags": ["成人", "动漫"], "desc": "sukebei.nyaa 动画分类，里番"},
]
LANG_NAME = {"zh": "中文", "en": "英文", "ja": "日文", "ru": "俄文", "ko": "韩文", "fr": "法文", "de": "德文", "es": "西班牙文", "pt": "葡萄牙文"}
PRIVACY_NAME = {"public": "公开", "semiPrivate": "半公开（需注册）", "private": "私有（需账号）"}
_ANIME_RX = re.compile(r"anime|动画|動畫|番剧|動漫|动漫|bangumi", re.I)


def _focus(categories: List[dict], description: str) -> List[str]:
    """把 Prowlarr 的 Newznab 分类（2000 电影、5000 剧集、5070 动漫、3000 音乐、6000 成人、7000 书籍、1000/4000 游戏软件）
    和站点自定义分类名归成几个中文标签，给 App 展示「这个站主要有什么」。"""
    ids, top = set(), []
    for c in categories or []:
        ids.add(int(c.get("id") or 0))
        top.append(str(c.get("name") or ""))
        for sc in c.get("subCategories") or []:
            ids.add(int(sc.get("id") or 0))
    # 动漫只看站点简介和顶层分类名：综合站在 TV 下都挂着 5070 Anime 子类，不能算「主要是动漫」
    anime = bool(_ANIME_RX.search(description or "")) or any(_ANIME_RX.search(n) for n in top)
    kinds = [t for t, ok in (("电影", any(2000 <= i < 3000 for i in ids)),
                             ("剧集", any(5000 <= i < 6000 for i in ids)),
                             ("音乐", any(3000 <= i < 4000 for i in ids)),
                             ("书籍", any(7000 <= i < 8000 for i in ids)),
                             ("游戏软件", any(1000 <= i < 2000 or 4000 <= i < 5000 for i in ids))) if ok]
    tags = (["动漫"] if anime else []) + (["综合"] if len(kinds) >= 4 else kinds)
    if any(6000 <= i < 7000 for i in ids):
        tags.append("成人")
    return tags


def _indexer_meta(i: dict) -> Dict[str, Any]:
    """Prowlarr 索引器 / 定义 → App 用的元数据：语言、公开程度、内容标签、简介、网址。"""
    lang = str(i.get("language") or "").split("-")[0].lower()
    desc = str(i.get("description") or "")
    tags = _focus((i.get("capabilities") or {}).get("categories") or [], desc)
    if lang == "zh":
        tags.append("中文")
    elif lang:
        tags.append("外文")
    urls = i.get("indexerUrls") or []
    return {"lang": lang, "langName": LANG_NAME.get(lang, lang), "privacy": i.get("privacy") or "",
            "privacyName": PRIVACY_NAME.get(i.get("privacy") or "", ""), "tags": tags, "desc": desc,
            "url": urls[0] if urls else "", "definition": i.get("definitionName") or ""}


GROUP_RX = re.compile(r"^\s*[\[【]([^\]】]{2,40})[\]】]")
EMBY_GET_OK = re.compile(r"^/(Items|Users|Shows|Library/VirtualFolders|Library/MediaFolders|ScheduledTasks|System/Info|"
                         r"System/ActivityLog|Sessions|Genres|Persons)(/|$|\?)")
_HUB_SEM = threading.BoundedSemaphore(2)      # 同时最多两次 App 搜索（每次会扇出很多请求）


def _get(url: str) -> str:
    r = RequestUtils(headers={"User-Agent": "Mozilla/5.0"}, timeout=20).get_res(url)
    return r.text if r is not None and r.status_code == 200 else ""


def _ts(v: Any) -> str:
    if isinstance(v, (int, float)) and v > 0:
        return datetime.fromtimestamp(v).strftime("%Y-%m-%d %H:%M:%S")
    return str(v or "")[:19].replace("T", " ")


def _meta(title: str) -> Dict[str, Any]:
    """MP 的标题解析：字幕组、分辨率、编码、季集。"""
    try:
        from app.domain.metainfo import MetaInfo
        m = MetaInfo(title=title)
        return {"group": getattr(m, "resource_team", None) or "", "res": getattr(m, "resource_pix", None) or "",
                "codec": getattr(m, "video_encode", None) or "", "type": getattr(m, "resource_type", None) or "",
                "effect": getattr(m, "resource_effect", None) or "", "season": getattr(m, "begin_season", None),
                "episodes": list(getattr(m, "episode_list", None) or []), "se": getattr(m, "season_episode", "") or ""}
    except Exception:  # noqa: BLE001
        return {"group": "", "res": "", "codec": "", "type": "", "effect": "", "season": None, "episodes": [], "se": ""}


class Hub:
    def __init__(self, plugin):
        self.p = plugin
        self._c115_cache: tuple = (0.0, {})

    # ---------------- 路由 ----------------
    def routes(self) -> List[Dict[str, Any]]:
        r = [
            ("/hub/sources", self.sources, "GET", "可选搜索来源：Prowlarr 索引器 + 直连源"),
            ("/hub/prowlarr/catalog", self.prowlarr_catalog, "GET", "Prowlarr 可添加的索引器定义（带语言、内容、公开程度）"),
            ("/hub/prowlarr/add", self.prowlarr_add, "POST", "添加公开索引器：{definition}"),
            ("/hub/prowlarr/update", self.prowlarr_update, "POST", "启用/停用索引器：{id, enable}"),
            ("/hub/prowlarr/delete", self.prowlarr_delete, "POST", "删除索引器：{id}"),
            ("/hub/search", self.search, "POST", "资源搜索：{tmdbid,type,season} 智能（MP 识别+过滤）或 {keyword,sources} 指定来源"),
            ("/hub/library", self.library, "POST", "批量查是否已入库：{items:[{tmdbid,type}]}"),
            ("/hub/library/item", self.library_item, "GET", "某作品在 Emby 里的条目和已有集：tmdbid,type"),
            ("/hub/pipeline", self.pipeline, "GET", "入库全流程：任务阶段 + 实时 115/qB 进度 + AV 刮削"),
            ("/hub/task/events", self.task_events, "GET", "某任务的事件日志：hash（按步骤分组）"),
            ("/hub/task/files", self.task_files, "GET", "某任务的文件和下载细节：hash（缓冲=qB 每个文件进度；115=任务状态、做种、速度）"),
            ("/hub/task/candidates", self.task_candidates, "GET", "给某任务换资源的候选：hash（按任务的作品/季/集重新搜，打分，标出当前和已拉黑的）"),
            ("/hub/task/reselect", self.task_reselect, "POST", "换资源：{hash, magnet, title, buffer}（取消旧任务+删 115 文件+拉黑，新资源进同一目录；buffer=直接走 NAS 缓冲）"),
            ("/hub/subscription", self.subscription, "GET", "订阅详情：id（每集状态：未播/缺/已提交/下载中/卡住/失败/已入库）"),
            ("/hub/stats", self.stats, "GET", "系统统计：Emby 每个库的部数/集数/近 7 天新增、115 空间、NAS 下载盘剩余、入库任务按类型和状态"),
            ("/hub/blacklist", self.blacklist, "GET", "已拉黑的资源"),
            ("/hub/blacklist/remove", self.blacklist_remove, "POST", "解除拉黑：{hashes:[..]}"),
            ("/hub/offline", self.offline, "GET", "115 离线任务列表"),
            ("/hub/offline/delete", self.offline_delete, "POST", "删 115 离线任务：{hashes:[..]}"),
            ("/hub/task/remove", self.task_remove, "POST", "从入库列表移除已结束（完成/失败/取消）的任务记录：{hashes:[..]}"),
            ("/hub/av/cancel", self.av_cancel, "POST", "取消/删除 AV 记录：{key, files}（files=true 连 115 已下文件）"),
            ("/hub/emby/delete", self.emby_delete, "POST", "删 Emby 条目（电影/剧/季/集）：{id, files, dry_run}；files=true 连 115 原文件一起删"),
            ("/hub/qb", self.qb, "GET", "NAS qBittorrent 任务和速度"),
            ("/hub/qb/action", self.qb_action, "POST", "qB 操作：{hashes, action: pause|resume|delete|recheck|reannounce, delete_files}"),
            ("/hub/openlist", self.openlist, "GET", "OpenList 复制/上传/离线任务"),
            ("/hub/emby/get", self.emby_get, "GET", "Emby 只读 JSON 代理：path, query"),
            ("/hub/emby/image", self.emby_image, "GET", "Emby 图片：id, type, w, tag"),
            ("/hub/emby/refresh", self.emby_refresh, "POST", "Emby 重新刮削条目：{id, replace}"),
            ("/hub/emby/scan", self.emby_scan, "POST", "Emby 扫描全部媒体库"),
            ("/hub/emby/activity", self.emby_activity, "GET", "Emby 正在跑的计划任务（扫描/刮削进度）和最近活动"),
            ("/hub/subs/list", self.subs_list, "GET", "视频同目录（含 Subs/ 子目录）的字幕文件：url=strm 里的 OpenList 链接或 115 路径"),
            ("/hub/subs/file", self.subs_file, "GET", "读一个字幕文件（≤20MB）：path=115 路径"),
        ]
        return [{"path": p, "endpoint": fn, "methods": [m], "summary": s} for p, fn, m, s in r]

    # ---------------- 来源 ----------------
    def _pw(self, method: str, path: str, json: Any = None, timeout: int = 30):
        """调 NAS 上的 Prowlarr；返回 (status, body)。"""
        ru = RequestUtils(headers={"X-Api-Key": self.p._prowlarr_key, "Content-Type": "application/json"}, timeout=timeout)
        url = f"{self.p._prowlarr_url}/api/v1{path}"
        r = ru.get_res(url) if method == "GET" else ru.post_res(url, json=json) if method == "POST" else \
            ru.put_res(url, json=json) if method == "PUT" else ru.delete_res(url)
        if r is None:
            return 0, None
        try:
            return r.status_code, r.json() if r.content else None
        except Exception:  # noqa: BLE001
            return r.status_code, r.text

    def sources(self) -> Dict[str, Any]:
        out = []
        try:
            code, ix = self._pw("GET", "/indexer", timeout=15)
            _, st = self._pw("GET", "/indexerstatus", timeout=15)
            down = {s.get("indexerId"): s.get("disabledTill") for s in (st or []) if isinstance(s, dict)}
            for i in (ix if code == 200 else []) or []:
                if i.get("protocol") != "torrent":
                    continue
                excluded = i["id"] in (self.p._exclude_indexers or [])
                out.append({"id": f"prowlarr:{i['id']}", "pid": i["id"], "name": i.get("name"), "kind": "prowlarr",
                            "enabled": bool(i.get("enable")) and not excluded, "prowlarrEnabled": bool(i.get("enable")),
                            "excluded": excluded, "downTill": down.get(i["id"]) or "",
                            "note": PRIVACY_NAME.get(i.get("privacy") or "", ""), **_indexer_meta(i)})
        except Exception as err:  # noqa: BLE001
            logger.warning(f"【Prowlarr115】hub 取索引器失败：{err}")
        direct = [dict(d, enabled=True, langName=LANG_NAME.get(d["lang"], d["lang"]),
                       privacyName=PRIVACY_NAME[d["privacy"]], url="", definition="") for d in DIRECT]
        return {"sources": direct + out}

    def prowlarr_catalog(self) -> Dict[str, Any]:
        """所有可添加的 torrent 定义。公开的可以一键添加；需要账号的只展示，去 Prowlarr 网页填凭据。"""
        code, schema = self._pw("GET", "/indexer/schema", timeout=60)
        if code != 200:
            return {"ok": False, "error": f"Prowlarr 返回 {code or '无响应'}"}
        _, ix = self._pw("GET", "/indexer", timeout=15)
        have = {i.get("definitionName"): i.get("id") for i in ix or []}
        out = []
        for d in schema or []:
            if d.get("protocol") != "torrent":
                continue
            out.append({"name": d.get("name"), "addedId": have.get(d.get("definitionName")),
                        "addable": d.get("privacy") == "public", **_indexer_meta(d)})
        out.sort(key=lambda x: (not x["addable"], x["lang"] != "zh", x["name"].lower()))
        return {"ok": True, "items": out}

    def prowlarr_add(self, payload: dict = Body(...)) -> Dict[str, Any]:
        name = str(payload.get("definition") or "")
        code, schema = self._pw("GET", "/indexer/schema", timeout=60)
        d = next((x for x in schema or [] if x.get("definitionName") == name), None) if code == 200 else None
        if not d:
            return {"ok": False, "error": "没有这个索引器定义"}
        if d.get("privacy") != "public":
            return {"ok": False, "error": "这个站需要账号，请在 Prowlarr 网页里添加并填写凭据"}
        _, profiles = self._pw("GET", "/appprofile")
        d.update(enable=True, priority=25, appProfileId=(profiles or [{}])[0].get("id", 1), tags=[])
        code, body = self._pw("POST", "/indexer", json=d, timeout=60)     # Prowlarr 会先测试站点能不能连通
        if code not in (200, 201):
            msg = "；".join(str(e.get("errorMessage")) for e in body) if isinstance(body, list) else str(body)[:200]
            return {"ok": False, "error": f"添加失败（{code}）：{msg}"}
        logger.info(f"【Prowlarr115】App 添加索引器 {d.get('name')} -> {body.get('id')}")
        return {"ok": True, "id": body.get("id"), "name": body.get("name")}

    def prowlarr_update(self, payload: dict = Body(...)) -> Dict[str, Any]:
        iid = int(payload.get("id") or 0)
        code, cur = self._pw("GET", f"/indexer/{iid}")
        if code != 200 or not isinstance(cur, dict):
            return {"ok": False, "error": "没有这个索引器"}
        cur["enable"] = bool(payload.get("enable"))
        code, body = self._pw("PUT", f"/indexer/{iid}", json=cur, timeout=60)
        if code not in (200, 202):
            msg = "；".join(str(e.get("errorMessage")) for e in body) if isinstance(body, list) else str(body)[:200]
            return {"ok": False, "error": f"保存失败（{code}）：{msg}"}
        return {"ok": True}

    def prowlarr_delete(self, payload: dict = Body(...)) -> Dict[str, Any]:
        iid = int(payload.get("id") or 0)
        code, _ = self._pw("DELETE", f"/indexer/{iid}")
        return {"ok": code in (200, 204)} if code in (200, 204) else {"ok": False, "error": f"删除失败（{code}）"}

    # ---------------- 搜索 ----------------
    def search(self, payload: dict = Body(...)) -> Dict[str, Any]:
        """两种模式：
        - 智能：给 tmdbid（+type、season），走 MP 的 search_by_id（插件多关键词、身份声明、MP 季过滤），和网页「搜索资源」一致；
        - 指定来源：给 keyword + sources（["nyaa","prowlarr:3",...]），原样搜，不过滤季。
        两种都会按选片策略打分、标出推荐、和 Emby 已有的集对比。"""
        t0 = time.time()
        tmdbid, kind = payload.get("tmdbid"), "movie" if payload.get("type") == "movie" else "tv"
        season = int(payload["season"]) if payload.get("season") not in (None, "") else None
        sources = [s for s in payload.get("sources") or [] if s]
        keyword = (payload.get("keyword") or "").strip()
        # 多个关键词（中文名 / 日文名 / 英文名…）：每个都搜一遍再合并去重，最多 4 个
        keywords = list(dict.fromkeys(k.strip() for k in (payload.get("keywords") or []) if k and k.strip()))[:4]
        media, err = None, None
        if tmdbid:
            media = batch_mod._recognize({"tmdbid": tmdbid, "type": kind})
            if not media:
                return {"ok": False, "error": "TMDb 识别失败"}
            if kind == "tv" and season is None:
                season = min((int(s) for s in (media.seasons or {}) if int(s) > 0), default=1)
        with _HUB_SEM:
            if sources or not media:
                items, err = self._raw_multi(keywords or [keyword or (media.title if media else "")],
                                             sources or ["nyaa", "animetosho", "mikan"], kind)
            else:
                items = self._smart(media, season)
        have: set = set()
        aired: List[int] = []
        if media and kind == "tv":
            try:
                have = batch_mod._emby_eps(self.p, media, season)
                aired = batch_mod._aired(media, season)
            except Exception:  # noqa: BLE001
                pass
        elif media:
            have = {1} if self.p._pipe and self.p._pipe.emby.folder_by_tmdb(media.tmdb_id, True, ["电影"]) else set()
        self._score(items, kind, media, season, aired)
        for it in items:
            it["have"] = len(set(it["episodes"]) & have) if kind == "tv" else (1 if have else 0)
        items.sort(key=lambda x: (x["excluded"] is not None, -(x["score"] or 0), -x["seeders"]))
        groups: Dict[str, int] = {}
        srcs: Dict[str, int] = {}
        for it in items:
            if it["group"]:
                groups[it["group"]] = groups.get(it["group"], 0) + 1
            srcs[it["source"]] = srcs.get(it["source"], 0) + 1
        return {"ok": True, "elapsed": round(time.time() - t0, 1), "mode": "raw" if (sources or not media) else "smart",
                "keyword": keyword, "keywords": keywords, "season": season, "error": err,
                "media": self._media_brief(media) if media else None,
                "library": {"have": sorted(have), "aired": aired} if media else None,
                "groups": sorted(groups.items(), key=lambda kv: -kv[1]), "sources": sorted(srcs.items(), key=lambda kv: -kv[1]),
                "results": items}

    @staticmethod
    def _media_brief(m: Any) -> Dict[str, Any]:
        return {"tmdbid": m.tmdb_id, "title": m.title, "year": m.year, "type": "movie" if m.type.value == "电影" else "tv",
                "original_title": getattr(m, "original_title", None), "poster": getattr(m, "poster_path", None),
                "seasons": {str(k): len(v or []) for k, v in (m.seasons or {}).items()}}

    def _item(self, title: str, size: float, seeders: int, peers: int, magnet: str, source: str, kind: str,
              pub: str = "", page: str = "", indexer: str = "", meta: Optional[dict] = None) -> Optional[Dict[str, Any]]:
        magnet = hex_magnet(magnet, title) if magnet and magnet.startswith("magnet:") else magnet
        h = btih(magnet)
        if not h:
            return None
        m = meta or _meta(title)
        g = m.get("group") or ((GROUP_RX.match(title) or [None, ""])[1])
        return {"id": h, "title": title, "size": float(size or 0), "seeders": int(seeders or 0), "peers": int(peers or 0),
                "magnet": magnet, "source": source, "kind": kind, "indexer": indexer, "pubdate": pub, "page": page,
                "group": g.strip(), "res": m.get("res") or "", "codec": m.get("codec") or "", "rtype": m.get("type") or "",
                "effect": m.get("effect") or "", "season": m.get("season"), "episodes": m.get("episodes") or [],
                "se": m.get("se") or "", "score": None, "why": [], "excluded": None, "recommended": False, "have": 0}

    def _smart(self, media: Any, season: Optional[int]) -> List[Dict[str, Any]]:
        from app.chain.search import SearchChain
        from app.schemas.types import MediaSource
        ctxs = SearchChain().search_by_id(media_source=MediaSource.TMDB, media_id=str(media.tmdb_id),
                                          mtype=media.type, season=season) or []
        out, seen = [], set()
        for c in ctxs:
            t, mi = c.torrent_info, c.meta_info
            site = str(t.site_name or "")
            kind, _, src = site.partition("·") if "·" in site else ("", "", site)
            meta = {"group": getattr(mi, "resource_team", None) or "", "res": getattr(mi, "resource_pix", None) or "",
                    "codec": getattr(mi, "video_encode", None) or "", "type": getattr(mi, "resource_type", None) or "",
                    "effect": getattr(mi, "resource_effect", None) or "", "season": getattr(mi, "begin_season", None),
                    "episodes": list(getattr(mi, "episode_list", None) or []), "se": getattr(mi, "season_episode", "") or ""}
            it = self._item(t.title, t.size, t.seeders, t.peers, t.enclosure or "", src or site,
                            "prowlarr" if kind == "Prowlarr" else "direct", str(t.pubdate or ""), t.page_url or "",
                            str(t.description or "") if kind == "Prowlarr" else "", meta)
            if it and it["id"] not in seen:
                seen.add(it["id"])
                out.append(it)
        return out

    def _raw_multi(self, qs: List[str], sources: List[str], kind: str) -> tuple:
        if len(qs) <= 1:
            return self._raw(qs[0] if qs else "", sources, kind)
        out, seen, errs = [], set(), []
        with ThreadPoolExecutor(max_workers=2) as pool:      # 每个关键词内部还会按来源并发，这里只并 2 个
            for items, err in pool.map(lambda q: self._raw(q, sources, kind), qs):
                if err:
                    errs.append(err)
                for it in items:
                    if it["id"] not in seen:
                        seen.add(it["id"])
                        out.append(it)
        return out, "；".join(dict.fromkeys(errs)) or None

    def _raw(self, q: str, sources: List[str], kind: str) -> tuple:
        if not q:
            return [], "缺少关键词"
        jobs = []
        prow = [int(s.split(":", 1)[1]) for s in sources if s.startswith("prowlarr:") and s.split(":", 1)[1].isdigit()]
        if prow or "prowlarr" in sources:
            jobs.append(("prowlarr", lambda: self._prowlarr(q, prow)))
        if "nyaa" in sources:
            jobs.append(("nyaa", lambda: nyaa_limited(_get, q, "seeders", 1)))
        if "animetosho" in sources:
            jobs.append(("animetosho", lambda: animetosho(_get, q, "size-d", 1) + animetosho(_get, q, "", 1)))
        if "mikan" in sources:
            jobs.append(("mikan", lambda: mikan_rss(_get, q)))
        for s, cat in (("sukebei-av", CAT_REAL), ("sukebei-anime", CAT_ANIME)):
            if s in sources and self.p._adult:
                jobs.append((s, lambda cat=cat: [dict(r, magnet=adult_magnet(r["hash"]), site="sukebei", peers=0)
                                                 for r in self.p._adult.sukebei(q, cat) if len(r.get("hash") or "") == 40]))
        errs, out, seen = [], [], set()
        with ThreadPoolExecutor(max_workers=6) as pool:
            futs = [(name, pool.submit(fn)) for name, fn in jobs]
            for name, f in futs:
                try:
                    rows = f.result(timeout=90) or []
                except Exception as e:  # noqa: BLE001
                    errs.append(f"{name}: {e}")
                    continue
                for r in rows:
                    it = self._item(r["title"], r.get("size"), r.get("seeders"), r.get("peers"), r.get("magnet") or "",
                                    r.get("site") or name, "prowlarr" if name == "prowlarr" else
                                    "adult" if name.startswith("sukebei") else "direct",
                                    r.get("pub") or _ts(r.get("ts")), r.get("page") or "", r.get("indexer") or "")
                    if it and it["id"] not in seen:
                        seen.add(it["id"])
                        out.append(it)
        return out, "；".join(errs) or None

    def _prowlarr(self, q: str, ids: List[int]) -> List[dict]:
        params = [("query", q), ("type", "search"), ("limit", 100)] + [("indexerIds", i) for i in ids]
        res = RequestUtils(headers={"X-Api-Key": self.p._prowlarr_key}, timeout=self.p._timeout).get_res(
            f"{self.p._prowlarr_url}/api/v1/search", params=params)
        if res is None or res.status_code != 200:
            raise RuntimeError(f"Prowlarr 返回 {getattr(res, 'status_code', '无响应')}")
        out = []
        for r in res.json() or []:
            if r.get("protocol") not in (None, "torrent"):
                continue
            h = (r.get("infoHash") or "").strip()
            mg = r.get("magnetUrl") if str(r.get("magnetUrl") or "").startswith("magnet:") else None
            if re.fullmatch(r"[0-9a-fA-F]{40}", h):
                mg = f"magnet:?xt=urn:btih:{h.lower()}&dn={urllib.parse.quote(r.get('title') or '')}"
            if not mg:
                continue
            out.append({"title": r.get("title") or "", "size": r.get("size"), "seeders": r.get("seeders"),
                        "peers": r.get("leechers"), "magnet": mg, "site": r.get("indexer") or "Prowlarr",
                        "indexer": r.get("indexer") or "", "pub": _ts(r.get("publishDate")),
                        "page": r.get("infoUrl") or r.get("guid") or ""})
        return out

    def _score(self, items: List[dict], kind: str, media: Any, season: Optional[int], aired: List[int]) -> None:
        policy = self.p._policy()
        mins = runtime_minutes(media) if media else 0
        for it in items:
            f = features(it["title"], it["size"], it["seeders"], it["episodes"], policy)
            sc, why = score(f, kind, policy, len(aired), mins)
            if sc is None:
                it["excluded"] = "；".join(why) or "被策略排除"
            else:
                it["score"], it["why"] = round(sc, 1), why
            it["tags"] = [x for x, ok in (("HEVC", f["hevc"]), ("AV1", f["av1"]), ("HDR", f["hdr"]), ("BD", f["bd"]),
                                          ("WEB", f["web"] and not f["bd"]), ("中字", f["cn_sub"]), ("内封", f["cn_sub_inner"]),
                                          ("软字幕", f.get("softsub")), ("硬字幕", f.get("hardsub")), ("双语", f["bilingual"])) if ok]
            if not it["res"] and f["res"]:
                it["res"] = f["res"]
        if not media or not items:
            return
        if kind == "movie":
            names = [media.title, getattr(media, "original_title", None), getattr(media, "en_title", None)]
            for it in items:
                why = year_conflict(it["title"], media.year, names)
                if why and not it["excluded"]:
                    it["excluded"], it["score"] = why, None
        try:
            cands = [{"idx": i, "title": it["title"], "size": it["size"], "seeders": it["seeders"],
                      "episodes": it["episodes"], "season": it["season"]} for i, it in enumerate(items)]
            names = [media.title, getattr(media, "original_title", None), getattr(media, "en_title", None)] + \
                    list(getattr(media, "names", None) or [])[:12]
            res = pick(cands, kind, policy, aired if kind == "tv" else [], season=season if kind == "tv" else None, ep_minutes=mins,
                       movie_names=names, movie_year=media.year if kind == "movie" else None)
            for c in res["chosen"]:
                items[c["idx"]]["recommended"] = True
        except Exception as err:  # noqa: BLE001
            logger.warning(f"【Prowlarr115】hub 推荐计算失败：{err}")

    # ---------------- 媒体库 ----------------
    def library(self, payload: dict = Body(...)) -> Dict[str, Any]:
        """{items:[{tmdbid,type}]} -> {"tv:123": {id, name, lib}}；没入库的不返回。"""
        p = self.p._pipe
        if not p:
            return {}
        want: Dict[str, List[str]] = {"Movie": [], "Series": []}
        for it in payload.get("items") or []:
            if it.get("tmdbid"):
                want["Movie" if it.get("type") == "movie" else "Series"].append(str(it["tmdbid"]))
        out: Dict[str, Any] = {}
        for typ, ids in want.items():
            for i in range(0, len(ids), 40):
                d = p.emby.get("/Items", Recursive="true", IncludeItemTypes=typ, Fields="Path,ProviderIds,ChildCount",
                               AnyProviderIdEquals=",".join(f"Tmdb.{x}" for x in ids[i:i + 40])) or {}
                for e in d.get("Items") or []:
                    tid = str((e.get("ProviderIds") or {}).get("Tmdb") or "")
                    if tid in ids:
                        lib = (e.get("Path") or "").replace(p.emby.lib_root, "", 1).strip("/").split("/")[0]
                        out[f"{'movie' if typ == 'Movie' else 'tv'}:{tid}"] = {"id": e["Id"], "name": e.get("Name"), "lib": lib,
                                                                              "count": e.get("ChildCount")}
        return out

    def library_item(self, tmdbid: int, type: str = "tv") -> Dict[str, Any]:  # noqa: A002
        p = self.p._pipe
        if not p:
            return {"ok": False, "error": "流水线未就绪"}
        typ = "Movie" if type == "movie" else "Series"
        d = p.emby.get("/Items", Recursive="true", IncludeItemTypes=typ, AnyProviderIdEquals=f"Tmdb.{tmdbid}",
                       Fields="Path,ProviderIds,Overview,DateCreated") or {}
        items = [e for e in d.get("Items") or [] if str((e.get("ProviderIds") or {}).get("Tmdb")) == str(tmdbid)]
        if not items:
            return {"ok": True, "found": False}
        e = items[0]
        out = {"ok": True, "found": True, "id": e["Id"], "name": e.get("Name"), "path": e.get("Path"),
               "lib": (e.get("Path") or "").replace(p.emby.lib_root, "", 1).strip("/").split("/")[0],
               "added": e.get("DateCreated"), "seasons": {}}
        if typ == "Series":
            eps = (p.emby.get(f"/Shows/{e['Id']}/Episodes", Fields="Path") or {}).get("Items") or []
            for x in eps:
                if x.get("IndexNumber") is not None:
                    out["seasons"].setdefault(str(int(x.get("ParentIndexNumber") or 0)), []).append(int(x["IndexNumber"]))
            out["numbering"] = "tvdb" if "/动漫/" in (e.get("Path") or "") and p.tvdb_map else "tmdb"
        return out

    # ---------------- 入库进度 ----------------
    def _c115(self, pages: int = 2) -> Dict[str, dict]:
        ts, data = self._c115_cache
        if time.time() - ts < 10 and data:
            return data
        p = self.p._pipe
        data = p.c115.tasks(pages) if p else {}
        self._c115_cache = (time.time(), data)
        return data

    @staticmethod
    def _times(t: dict) -> List[tuple]:
        """五步各自的 (开始, 结束) 时间（秒）；旧任务没有 ts 时用 added/done/emby 推。"""
        ts = t.get("ts") or {}
        sub = ts.get("submitted") or t.get("added")
        dl_end = ts.get("uploaded") if t.get("buffer") else ts.get("offline")
        dl_end = dl_end or ts.get("strm_start") or (t.get("done") if t.get("status") == "done" else None)
        strm_start = ts.get("strm_start") or dl_end
        strm_end = ts.get("strm") or t.get("done")
        emby = t.get("emby") or 0
        scrape_end = ts.get("emby") or (emby if emby > 0 else None)
        sel = ts.get("select") or ((t.get("meta") or {}).get("pick") or {}).get("at") or sub
        return [(sel, sel), (sub, sub), (sub, dl_end), (strm_start, strm_end if strm_start else None),
                (strm_end, scrape_end if strm_end else None), (scrape_end, scrape_end)]

    STEP_EVENTS = {"select": ["select"], "submit": ["submit"], "download": ["offline", "buffer"], "strm": ["strm", "subs"],
                   "scrape": ["emby"], "finish": ["manual"]}

    @staticmethod
    def _steps(t: dict) -> tuple:
        """任务 -> (阶段文字, 五步进度, 是否失败)。步骤：提交 → 115 离线/NAS 缓冲 → 生成 strm → Emby 刮削 → 完成。"""
        st = t.get("status") or ""
        emby = t.get("emby") or 0
        kind = (t.get("meta") or {}).get("kind") or "media"
        via = "NAS 缓冲" if t.get("buffer") else "115 离线"
        keys = ["select", "submit", "download", "strm", "scrape", "finish"]
        # 三类资源同一套步骤，只有入库/刮削两步不同：影视 TMDb、里番 Emby 的 Bangumi 插件、AV 交给 MDC 刮削整理
        labels = ["搜索选片", "提交", via, *{"av": ("写入 MDC 收件箱", "MDC 刮削整理"), "hentai": ("生成 strm", "Bangumi 刮削")}.get(kind, ("生成 strm", "Emby 刮削")), "完成"]
        pos = {"downloading": 2, "buffer": 2, "uploaded": 3, "scraping": 4, "done": 6 if emby > 0 else 4}.get(st)
        err = {"too-big": 2, "dead": 2, "no-video": 3, "strm-failed": 3, "needs-id": 3, "scrape-failed": 4}.get(st)
        if st == "done" and emby < 0:
            err = 3
        steps = []
        times = Hub._times(t)
        for i, k in enumerate(keys):
            if st in ("superseded", "cancelled"):
                state = "done" if i <= 1 else "skipped"
            elif err is not None:
                state = "done" if i < err else "error" if i == err else "pending"
            else:
                p = pos if pos is not None else 0
                state = "done" if i < p else "active" if i == p else "pending"
            st_at, en_at = times[i]
            steps.append({"key": k, "label": labels[i], "state": state, "start": st_at, "end": en_at if state != "active" else None})
        stage = {"downloading": f"{via}下载中", "buffer": "NAS 缓冲下载，逐个上传 115", "uploaded": "等待生成 strm",
                 "scraping": "MDC 刮削中", "scrape-failed": "MDC 刮削失败",
                 "strm-failed": "生成 strm 连续失败，已停止重试", "needs-id": "没有 TMDb 条目，请选择作品后入库", "too-big": "种子太大，已放弃", "dead": "死种",
                 "no-video": "没认出可入库的视频", "superseded": "库里已有其他版本", "cancelled": "已取消"}.get(st, st)
        if st == "done":
            stage = "已入库" if emby > 0 else "Emby 未能刮削，需手动识别" if emby < 0 else \
                ("已生成 strm，等待 Bangumi 刮削" if kind == "hentai" else "已生成 strm，等待 Emby 刮削")
            if t.get("identity_warn"):
                stage = f"可能认错：{t['identity_warn']}"
        return stage, steps, err is not None

    def pipeline(self, limit: int = 60, live: bool = True) -> Dict[str, Any]:
        tasks = self.p._load_tasks()
        items = sorted(tasks.items(), key=lambda kv: -kv[1].get("added", 0))
        active_st = ("downloading", "buffer", "uploaded", "scraping")
        keep = [kv for kv in items if kv[1].get("status") in active_st or (kv[1].get("status") == "done" and not kv[1].get("emby"))]
        keep += [kv for kv in items[:int(limit)] if kv not in keep]
        c115: Dict[str, dict] = {}
        qbt: Dict[str, dict] = {}
        if live and self.p._pipe:
            if any(t.get("status") == "downloading" for _, t in keep):
                try:
                    c115 = self._c115()
                except Exception as err:  # noqa: BLE001
                    logger.warning(f"【Prowlarr115】hub 取 115 任务失败：{err}")
            if any(t.get("status") == "buffer" for _, t in keep) and self.p._pipe.qb:
                try:
                    qbt = {q["hash"]: q for q in self.p._pipe.qb.get("/api/v2/torrents/info", {"category": "mp115buffer"}) or []}
                except Exception:  # noqa: BLE001
                    pass
        out = []
        ev = (self.p.get_data("events") or {}) if self.p._pipe else {}
        for h, t in keep:
            stage, steps, failed = self._steps(t)
            rows = ev.get(h) or []
            for s_ in steps:
                mine = [r for r in rows if r[1] in self.STEP_EVENTS.get(s_["key"], [])]
                s_["events"] = len(mine)
                s_["last"] = mine[-1][3][:120] if mine else ""
                s_["warn"] = any(r[2] in ("warn", "error") for r in mine)
            meta = t.get("meta") or {}
            row = {"hash": h, "kind": "media", "status": t.get("status"), "stage": stage, "steps": steps, "failed": failed,
                   "dir": t.get("dir"), "name": t.get("name") or t.get("title") or "", "added": t.get("added"),
                   "done": t.get("done"), "emby": t.get("emby"), "identityWarn": t.get("identity_warn") or "", "percent": t.get("percent"), "strm": len(t.get("strm") or []),
                   "stalled": t.get("stalled") if t.get("status") == "downloading" else None,
                   "autoBufferAt": (t.get("added") or 0) + STALL_AFTER if t.get("status") == "downloading" and not t.get("percent") else None,
                   "episodes": meta.get("episodes") or [], "subId": meta.get("sub_id"),
                   "title": meta.get("title") or (t.get("dir") or "").split("/")[-2 if "/Season " in (t.get("dir") or "") else -1],
                   "year": meta.get("year"), "tmdbid": meta.get("tmdbid"), "season": meta.get("merged_season") or meta.get("season"),
                   "type": "movie" if meta.get("type") == "电影" or "/电影/" in (t.get("dir") or "") else "tv",
                   "category": meta.get("kind") or "media"}
            info = c115.get(h)
            if info:
                row.update(percent=info.get("percentDone"), size=info.get("size"), rate=info.get("rateDownload"),
                           name=info.get("name") or row["name"], peers=info.get("peers"))
            q = qbt.get(h)
            if q:
                row.update(percent=round(float(q.get("progress") or 0) * 100, 1), size=q.get("total_size") or q.get("size"),
                           rate=q.get("dlspeed"), eta=q.get("eta"), name=q.get("name") or row["name"])
            if t.get("buffer"):
                b = t["buffer"]
                row["buffer"] = {"reason": b.get("reason"), "since": b.get("since"), "uploaded": len(b.get("uploaded") or {}),
                                 "uploading": list((b.get("uploading") or {}).keys())[:5]}
            out.append(row)
        adult = self._adult_rows(c115 if live else {})
        return {"ok": True, "tasks": out, "adult": adult, "ts": int(time.time())}

    def task_events(self, hash: str) -> Dict[str, Any]:  # noqa: A002
        """{events:[{at, step, group, level, msg}]}：group 是 App 里五个步骤的 key。"""
        h = hash.lower()
        rows = self.p._pipe.events(h) if self.p._pipe else []
        group = {e: k for k, es in self.STEP_EVENTS.items() for e in es}
        t = (self.p._load_tasks() or {}).get(h) or {}
        out = [{"at": r[0], "step": r[1], "group": group.get(r[1], "finish"), "level": r[2], "msg": r[3]} for r in rows]
        if not out and t:
            out = [{"at": t.get("added"), "step": "submit", "group": "submit", "level": "info",
                    "msg": "（这个任务在事件日志上线前提交，只有时间点，没有详细日志）"}]
        return {"ok": True, "hash": h, "events": out, "ts": t.get("ts") or {}}

    AV_STEPS = [("submit", "提交"), ("offline", "115 离线"), ("strm", "生成 strm"), ("scrape", "MDC 刮削"), ("done", "入库")]

    @classmethod
    def _av_steps(cls, at: Any, pos: int, err: bool = False) -> List[dict]:
        """AV 五个节点：pos 是当前所在节点（5=全部完成）；err 表示卡在 pos 这一步。"""
        out = []
        for i, (k, label) in enumerate(cls.AV_STEPS):
            state = "done" if i < pos else ("error" if err else "active") if i == pos else "pending"
            out.append({"key": k, "label": label, "state": state, "start": at if i == 0 else None, "end": None})
        return out

    def _adult_rows(self, c115: Dict[str, dict]) -> List[dict]:
        """AV 行：key 是 /hub/av/cancel 用的标识。115 已完成但还没生成 strm 的也显示（以前被隐藏，任务像是消失了）。"""
        a = self.p._adult
        if not a:
            return []
        av = a.get_data("av") or {}
        rows = []
        mine = set(self.p._load_tasks() or {})   # 已进流水线的 AV 任务按普通任务显示，这里只列旧记录
        sub = {k: v for k, v in (av.get("submitted") or {}).items() if btih(v.get("link") or "") not in mine}
        if sub and not c115:
            try:
                c115 = self._c115()
            except Exception:  # noqa: BLE001
                c115 = {}
        for key, v in sub.items():
            h = btih(v.get("link") or "")
            info = c115.get(h) or {}
            st = info.get("status")
            # 115 列表只取最近几页：查不到又超过 2 小时，多半是任务被清掉或没成功（下载目录里要有文件，av_run 早就生成 strm 了）
            gone = not info and time.time() - (v.get("at") or 0) > 7200
            stage = {2: "115 已完成，等待生成 strm", -1: "115 离线失败"}.get(st, "115 离线下载中" if info else "115 里找不到这个任务" if gone else "115 离线排队中")
            failed = st == -1 or gone
            pos = 2 if st == 2 else 1
            rows.append({"kind": "av", "key": key, "code": key if not re.fullmatch(r"[0-9a-f]{40}", key) else (info.get("name") or key[:12]),
                         "stage": stage, "at": v.get("at"), "hash": h, "percent": info.get("percentDone"),
                         "name": info.get("name") or key, "failed": failed, "step": "offline",
                         "error": "任务已不在 115，也没有文件落到下载目录：移除这条记录后重新入库" if gone else None,
                         "steps": self._av_steps(v.get("at"), pos, failed)})
        for remote, v in (av.get("stubbed") or {}).items():
            if v.get("hash") in mine:
                continue
            st = v.get("status") or ""
            stage = {"scraping": "MDC 刮削中", "failed": "MDC 刮削失败", "missing": "strm 丢失", "new": "等待提交 MDC"}.get(st, st or "等待 MDC")
            bad = st in ("failed", "missing")
            slow = st == "scraping" and time.time() - (v.get("job") or v.get("at") or 0) > 1800
            rows.append({"kind": "av", "key": remote, "code": v.get("code") or v.get("name"), "stage": "MDC 刮削超时" if slow else stage, "at": v.get("at"),
                         "name": remote.rsplit("/", 1)[-1], "strm": v.get("name"), "failed": bad or slow,
                         "error": v.get("err") or ("提交 MDC 超过 30 分钟还没有结果，点「重新刮削」" if slow else None), "step": "scrape",
                         "steps": self._av_steps(v.get("at"), 3, bad or slow)})
        for v in sorted((av.get("done") or [])[-15:], key=lambda x: -x.get("at", 0)):
            if v.get("hash") in mine:
                continue
            rows.append({"kind": "av", "key": f"done:{v.get('code')}:{v.get('at')}", "code": v.get("code"), "stage": "已入库", "at": v.get("at"),
                         "name": v.get("target", "").rsplit("/", 1)[-1], "done": True, "failed": False, "step": "done",
                         "steps": self._av_steps(v.get("at"), 5)})
        return rows

    def av_cancel(self, payload: dict = Body(...)) -> Dict[str, Any]:
        a = self.p._adult
        if not a:
            return {"ok": False, "error": "AV 功能未开启"}
        key = str(payload.get("key") or "").strip()
        if not key:
            return {"ok": False, "error": "缺少 key"}
        self._c115_cache = (0.0, {})
        return a.av_cancel(key, bool(payload.get("files")))

    def task_remove(self, payload: dict = Body(...)) -> Dict[str, Any]:
        """只移除已结束的任务记录（进行中的先取消）。"""
        hs = {str(h).lower() for h in payload.get("hashes") or []}
        tasks = self.p._load_tasks()
        gone, kept = [], []
        for h in hs:
            t = tasks.get(h)
            if not t:
                continue
            if t.get("status") in ("downloading", "buffer", "uploaded") and not (t.get("status") == "uploaded" and t.get("emby")):
                kept.append(h)
                continue
            tasks.pop(h)
            gone.append(h)
        if gone:
            self.p._save_tasks(tasks)
        return {"ok": True, "removed": gone, "active": kept}

    # ---------------- Emby 删除（连 115 原文件） ----------------
    def _lib_ol(self, emby_path: str) -> Optional[str]:
        """Emby 路径 → OpenList 上媒体库里的同一路径。"""
        p = self.p._pipe
        root = p.emby.lib_root
        return p.lib_ol + emby_path[len(root):] if emby_path and emby_path.startswith(root + "/") else None

    def emby_delete(self, payload: dict = Body(...)) -> Dict[str, Any]:
        """删一个 Emby 条目：媒体库里的 strm/目录 + Emby 记录；files=true 时连 strm 指向的 115 文件（同名字幕）一起删，
        删完若 115 作品目录里没有视频了就删目录。dry_run=true 只返回会删什么。只动 /115/Emby 和媒体库目录下的东西。"""
        p = self.p._pipe
        if not p:
            return {"ok": False, "error": "流水线未就绪"}
        iid = str(payload.get("id") or "")
        files, dry = bool(payload.get("files")), bool(payload.get("dry_run", True))
        if not re.fullmatch(r"\w+", iid):
            return {"ok": False, "error": "id 不对"}
        e, ol = p.emby, p.ol
        it = ((e.get("/Items", Ids=iid, Fields="Path") or {}).get("Items") or [None])[0]
        if not it:
            return {"ok": False, "error": "Emby 里没有这个条目"}
        typ = it.get("Type")
        if typ in ("CollectionFolder", "UserView", "Folder", "BoxSet"):
            return {"ok": False, "error": "不能删整个媒体库或合集"}
        videos = [it] if typ in ("Movie", "Episode", "Video") else ((e.get("/Items", ParentId=iid, Recursive="true", IncludeItemTypes="Movie,Episode,Video",
                                                                            Fields="Path") or {}).get("Items") or [])
        stubs = [s for s in (self._lib_ol(v.get("Path") or "") for v in videos) if s]
        # 媒体库这边删什么：剧/季删整个目录；电影目录里只有它一部就删目录，否则删同名文件；集删同名文件
        lib_dirs: List[str] = []
        lib_files: List[str] = []
        if typ in ("Series", "Season") and self._lib_ol(it.get("Path") or ""):
            lib_dirs.append(self._lib_ol(it["Path"]))
        else:
            for s_ in stubs:
                d, n = s_.rsplit("/", 1)
                stem = n.rsplit(".", 1)[0]
                siblings = [i["name"] for i in ol.list(d)]
                if typ == "Movie" and sum(1 for x in siblings if x.lower().endswith((".strm",) + VIDEO_EXT)) <= 1 and d.count("/") > p.lib_ol.count("/") + 1:
                    lib_dirs.append(d)
                else:
                    lib_files += [f"{d}/{x}" for x in siblings if x == n or x.startswith(stem + ".") or x.startswith(stem + "-")]
        remotes: List[str] = []
        skipped: List[str] = []
        if files:
            for s_ in stubs:
                r = ol.remote_of_strm(s_) if s_.endswith(".strm") else None
                if r and r.startswith(p.root + "/") and r.count("/") >= p.root.count("/") + 2:
                    remotes.append(r)
                elif r:
                    skipped.append(r)
        plan = {"ok": True, "dry_run": dry, "item": {"id": iid, "name": it.get("Name"), "type": typ}, "videos": len(videos),
                "libDirs": lib_dirs, "libFiles": lib_files, "remotes": remotes, "skipped": skipped}
        if dry:
            return plan
        errors: List[str] = []
        removed_remote_dirs: List[str] = []
        for r in remotes:                      # 115：视频和同名字幕
            d, n = r.rsplit("/", 1)
            stem = n.rsplit(".", 1)[0]
            try:
                names = [i["name"] for i in ol.list(d, refresh=True) if i["name"] == n or i["name"].startswith(stem + ".")]
                if names:
                    ol.remove(d, names)
            except Exception as err:  # noqa: BLE001
                errors.append(f"115 {r[-60:]}：{err}")
        for d in sorted({r.rsplit("/", 1)[0] for r in remotes}, key=len, reverse=True):   # 作品目录里没有视频了就删目录
            try:
                if d.count("/") >= p.root.count("/") + 2 and ol.get(d) and not any(x.lower().endswith(VIDEO_EXT) for x, _ in ol.walk(d)):
                    parent, folder = d.rsplit("/", 1)
                    ol.remove(parent, [folder])
                    removed_remote_dirs.append(d)
            except Exception as err:  # noqa: BLE001
                errors.append(f"115 目录 {d[-60:]}：{err}")
        try:                                   # Emby 记录（它能删就顺手删 strm）
            RequestUtils(timeout=60).delete_res(f"{e.url}/emby/Items/{iid}?api_key={e.key}")
        except Exception:  # noqa: BLE001
            pass
        for d in lib_dirs:
            try:
                if ol.get(d):
                    parent, folder = d.rsplit("/", 1)
                    ol.remove(parent, [folder])
            except Exception as err:  # noqa: BLE001
                errors.append(f"媒体库 {d[-60:]}：{err}")
        for f in lib_files:
            try:
                if ol.get(f):
                    ol.remove(f.rsplit("/", 1)[0], [f.rsplit("/", 1)[1]])
            except Exception as err:  # noqa: BLE001
                errors.append(f"媒体库 {f[-60:]}：{err}")
        try:
            paths = [p.emby_path(x) for x in lib_dirs or [f.rsplit("/", 1)[0] for f in lib_files]]
            RequestUtils(content_type="application/json", timeout=60).post_res(
                f"{e.url}/emby/Library/Media/Updated?api_key={e.key}",
                json={"Updates": [{"Path": (it.get("Path") or ""), "UpdateType": "Deleted"}] + [{"Path": x, "UpdateType": "Deleted"} for x in paths]})
        except Exception:  # noqa: BLE001
            pass
        logger.info(f"【Prowlarr115】删除 Emby 条目 {it.get('Name')}（{typ}）：115 {len(remotes)} 个文件，媒体库 {len(lib_dirs)} 个目录 {len(lib_files)} 个文件，错误 {len(errors)}")
        return {**plan, "dry_run": False, "removedRemoteDirs": removed_remote_dirs, "errors": errors, "ok": not errors}


    # ---------------- 任务细节 / 换资源 ----------------
    def task_files(self, hash: str) -> Dict[str, Any]:  # noqa: A002
        """缓冲中：qB 每个文件的进度；115 离线中：任务状态、做种、速度（115 完成前列不出文件）；完成后：115 目录里的视频。"""
        h, p = hash.lower(), self.p._pipe
        t = (self.p._load_tasks() or {}).get(h)
        if not p or not t:
            return {"ok": False, "error": "任务不存在"}
        out: Dict[str, Any] = {"ok": True, "status": t.get("status"), "files": [], "offline": None, "note": ""}
        if t.get("status") == "buffer" and p.qb:
            try:
                fs = p.qb.get("/api/v2/torrents/files", {"hash": h}) or []
                out["files"] = [{"name": f.get("name"), "size": f.get("size"), "progress": round(float(f.get("progress") or 0) * 100, 1),
                                 "uploaded": (f.get("name") or "") in ((t.get("buffer") or {}).get("uploaded") or {})} for f in fs[:300]]
                q = (p.qb.get("/api/v2/torrents/info", {"hashes": h}) or [{}])[0]
                out["qb"] = {"state": q.get("state"), "seeds": q.get("num_seeds"), "peers": q.get("num_leechs"),
                             "swarmSeeds": q.get("num_complete"), "rate": q.get("dlspeed"), "eta": q.get("eta")}
            except Exception as err:  # noqa: BLE001
                out["note"] = f"读取 qB 失败：{err}"
        elif t.get("status") == "downloading":
            info = self._c115().get(h)
            if info:
                out["offline"] = {"status": info.get("status"), "percent": info.get("percentDone"), "size": info.get("size"),
                                  "peers": info.get("peers"), "rate": info.get("rateDownload"), "added": info.get("add_time"),
                                  "updated": info.get("last_update")}
                if not info.get("size"):
                    out["note"] = "115 还没拿到种子信息（文件列表、大小都没有）：多半是 115 离线服务器连不上这个种子的做种者"
            else:
                out["note"] = "115 离线列表里暂时找不到这个任务"
        elif t.get("status") in ("done", "uploaded") and t.get("name"):
            name = t["name"]
            try:
                base = f"{t['dir']}/{name}"
                if not p.ol.get(base):
                    return out                 # 只列本任务自己的文件；找不到就不列（不能把整季目录当成这个任务的）
                out["files"] = [{"name": r[len(t["dir"]) + 1:], "size": it.get("size"), "progress": 100.0}
                                for r, it in list(p.ol.walk(base))[:300] if r.lower().endswith(VIDEO_EXT)]
            except Exception as err:  # noqa: BLE001
                out["note"] = f"列 115 目录失败：{err}"
        return out

    def _task_eps(self, t: dict) -> List[int]:
        eps = [int(e) for e in (t.get("meta") or {}).get("episodes") or [] if str(e).isdigit()]
        if not eps:
            se = ep_of(t.get("name") or t.get("title") or "")
            if se:
                eps = [se[1]]
        return eps

    def task_candidates(self, hash: str) -> Dict[str, Any]:  # noqa: A002
        h = hash.lower()
        t = (self.p._load_tasks() or {}).get(h)
        if not t:
            return {"ok": False, "error": "任务不存在"}
        meta = t.get("meta") or {}
        bl = self.p._blacklist()
        if meta.get("kind") in ("av", "hentai"):
            # AV 按番号、里番按系列名在 sukebei 重新搜；同一集优先（里番）
            q = meta.get("code") if meta.get("kind") == "av" else (meta.get("series") or meta.get("title"))
            if not q:
                return {"ok": False, "error": "这个任务没有番号/系列名，没法重新搜索"}
            t0 = time.time()
            items, err = self._raw(q, ["sukebei-av" if meta["kind"] == "av" else "sukebei-anime"], "movie" if meta["kind"] == "av" else "tv")
            ep = meta.get("ep")
            for it in items:
                it["current"], it["blacklisted"] = it["id"] == h, (bl.get(it["id"]) or {}).get("reason")
                it["score"], it["recommended"] = None, False
                it["tags"] = [x for x in (it.get("res"),) if x]
            items.sort(key=lambda it: (bool(ep) and ep not in (it.get("episodes") or [ep]), -it["seeders"]))
            return {"ok": True, "task": {"hash": h, "title": meta.get("title"), "episodes": [ep] if ep else [], "name": t.get("name")},
                    "elapsed": round(time.time() - t0, 1), "error": err, "results": items[:40]}
        if not meta.get("tmdbid"):
            return {"ok": False, "error": "这个任务没有 TMDb 作品信息，请用发现页搜索后提交"}
        kind = "movie" if meta.get("type") == "电影" else "tv"
        season = meta.get("merged_season") or meta.get("season")
        res = self.search({"tmdbid": meta["tmdbid"], "type": kind, "season": season})
        if not res.get("ok"):
            return res
        eps = self._task_eps(t) if kind == "tv" else []
        off = int(meta.get("ep_offset") or 0)
        want = set(eps) | {e + off for e in eps}
        rows = []
        for it in res["results"]:
            if kind == "tv" and want and it["episodes"] and not (want & set(it["episodes"])):
                continue                     # 别的集
            it["current"] = it["id"] == h
            it["blacklisted"] = (bl.get(it["id"]) or {}).get("reason")
            rows.append(it)
        return {"ok": True, "task": {"hash": h, "title": meta.get("title"), "season": season, "episodes": eps, "name": t.get("name")},
                "elapsed": res.get("elapsed"), "results": rows[:40]}

    def task_reselect(self, payload: dict = Body(...)) -> Dict[str, Any]:
        """换资源：旧任务取消（删 115 离线任务和已下文件、缓冲连本地文件）并拉黑，新资源用同样的目录和入库参数提交。"""
        p = self.p._pipe
        h = str(payload.get("hash") or "").lower()
        magnet = str(payload.get("magnet") or "")
        t = (self.p._load_tasks() or {}).get(h)
        if not p or not t:
            return {"ok": False, "error": "任务不存在"}
        nh = btih(magnet)
        if not nh:
            return {"ok": False, "error": "只支持磁力链接"}
        if nh == h:
            return {"ok": False, "error": "选的就是当前资源"}
        if t.get("status") in ("downloading", "buffer"):
            self.p.api_cancel({"hashes": [h]})
        self.p._blacklist_add(h, "手动换资源", t)
        bl = self.p._blacklist()
        if nh in bl:                       # 用户明确选了一个拉黑过的：以用户为准
            bl.pop(nh, None)
            self.p.save_data("blacklist", bl)
        title = str(payload.get("title") or "")[:300]
        ok, nh, err = p.submit(magnet, t["dir"], title, meta=dict(t.get("meta") or {}, replaced_from=h,
                                                             pick={"by": "reselect", "at": int(time.time()), "title": title}))
        if not ok:
            return {"ok": False, "error": err}
        p.event(h, "manual", f"已换成另一个资源：{title[:120]}（{nh[:8]}）", "warn")
        p.event(nh, "submit", f"由 {h[:8]} 换来（{(t.get('name') or t.get('title') or '')[:100]}）")
        if payload.get("buffer"):
            r = self.p.api_retry(nh, "buffer")
            if not r.get("ok", True):
                return {"ok": True, "hash": nh, "warning": r.get("error")}
        self.p._kick()
        return {"ok": True, "hash": nh}

    def blacklist(self) -> Dict[str, Any]:
        bl = self.p._blacklist()
        return {"ok": True, "items": sorted(({"hash": k, **v} for k, v in bl.items()), key=lambda r: -r.get("at", 0))[:300]}

    def blacklist_remove(self, payload: dict = Body(...)) -> Dict[str, Any]:
        bl = self.p._blacklist()
        n = sum(1 for k in payload.get("hashes") or [] if bl.pop(str(k).lower(), None) is not None)
        self.p.save_data("blacklist", bl)
        return {"ok": True, "removed": n}

    # ---------------- 系统统计 ----------------
    def stats(self) -> Dict[str, Any]:
        """后端按需调用（App 打开且缓存超过 10 分钟）并缓存；各段失败互不影响，错误写进 errors。"""
        p = self.p._pipe
        out: Dict[str, Any] = {"ok": True, "at": int(time.time()), "errors": [], "libraries": [], "storage": {}, "ingest": {}}
        if not p:
            return {"ok": False, "error": "流水线未就绪"}
        since = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 7 * 86400))

        def count(**q: Any) -> int:
            return int((p.emby.get("/Items", Recursive="true", Limit="0", **q) or {}).get("TotalRecordCount") or 0)
        try:
            for f in p.emby.get("/Library/VirtualFolders") or []:
                lid, ctype = f.get("ItemId"), (f.get("CollectionType") or "mixed")
                movies = count(ParentId=lid, IncludeItemTypes="Movie")
                series = count(ParentId=lid, IncludeItemTypes="Series")
                eps = count(ParentId=lid, IncludeItemTypes="Episode") if series else 0
                vids = count(ParentId=lid, IncludeItemTypes="Video") if ctype in ("homevideos", "mixed") else 0
                new7 = count(ParentId=lid, IncludeItemTypes="Movie,Episode,Video", MinDateCreated=since)
                # Emby 4.10 不认 HasPrimaryImage=false：没海报 = 总数 - 有 Primary 图的
                no_img = max(0, movies + series - count(ParentId=lid, IncludeItemTypes="Movie,Series", ImageTypes="Primary"))
                out["libraries"].append({"id": lid, "name": f.get("Name"), "type": ctype, "movies": movies, "series": series,
                                         "episodes": eps, "videos": vids, "new7d": new7, "noPoster": no_img,
                                         "adult": f.get("Name") in ("AV", "里番")})
        except Exception as err:  # noqa: BLE001
            out["errors"].append(f"Emby：{err}")
        try:
            out["storage"]["c115"] = p.c115.space()
        except Exception as err:  # noqa: BLE001
            out["errors"].append(f"115：{err}")
        if p.qb:
            try:
                srv = (p.qb.get("/api/v2/sync/maindata", {"rid": 0}) or {}).get("server_state") or {}
                out["storage"]["nas"] = {"free": srv.get("free_space_on_disk"), "dl": srv.get("dl_info_speed"), "up": srv.get("up_info_speed")}
            except Exception as err:  # noqa: BLE001
                out["errors"].append(f"qBittorrent：{err}")
        tasks = self.p._load_tasks() or {}
        by: Dict[str, Dict[str, int]] = {}
        week = 0
        for t in tasks.values():
            cat = (t.get("meta") or {}).get("kind") or "media"
            st = t.get("status") or "?"
            grp = "active" if st in ("downloading", "buffer", "uploaded", "scraping") else "done" if st == "done" else \
                "ended" if st in ("cancelled", "superseded") else "failed"
            by.setdefault(cat, {}).setdefault(grp, 0)
            by[cat][grp] += 1
            if st == "done" and (t.get("done") or 0) > time.time() - 7 * 86400:
                week += 1
        out["ingest"] = {"byKind": by, "done7d": week, "blacklisted": len(self.p._blacklist())}
        return out

    # ---------------- 订阅详情 ----------------
    def subscription(self, id: int) -> Dict[str, Any]:  # noqa: A002
        """一部订阅每一集现在在哪一步。集号按订阅自己的编号（Bangumi 来源是本季第几集），入库按 TMDb 编号核对。"""
        from app.db.oper.subscribe import SubscribeOper
        from app.chain.media import MediaChain
        from app.schemas.types import MediaSource, MediaType
        sub = SubscribeOper().get(int(id))
        if not sub:
            return {"ok": False, "error": "订阅不存在（可能已结束）"}
        mtype = MediaType.MOVIE if sub.type == MediaType.MOVIE.value else MediaType.TV
        src = sub.media_source or "themoviedb"
        warn: List[str] = []
        media = tmdb = None
        try:
            ms = {"themoviedb": MediaSource.TMDB, "bangumi": MediaSource.Bangumi}.get(src)
            if ms:
                media = MediaChain().recognize_media(mtype=mtype, media_source=ms, media_id=str(sub.media_id))
        except Exception as err:  # noqa: BLE001
            warn.append(f"识别失败：{err}")
        info: Dict[str, Any] = {}
        if media is not None:
            if src == "bangumi":
                tw = self.p._tmdb_twin(media, force=True)
                tmdb = batch_mod._recognize({"tmdbid": tw.tmdb_id, "type": "tv"}) if tw is not None and tw.tmdb_id else None
            else:
                tmdb = media
            try:
                _, info = self.p._plan(media, [sub.season] if sub.season else [], sub.season, "")
            except Exception as err:  # noqa: BLE001
                warn.append(f"算目录失败：{err}")
        tid = getattr(tmdb, "tmdb_id", None) or info.get("tmdbid")
        season = info.get("merged_season") or info.get("season") or sub.season or 1
        off = int(info.get("ep_offset") or 0)
        have, aired, tm_eps = set(), [], []
        if tmdb is not None and mtype == MediaType.TV:
            try:
                have = batch_mod._emby_eps(self.p, tmdb, season)
                aired = batch_mod._aired(tmdb, season)
                tm_eps = sorted(set((getattr(tmdb, "seasons", None) or {}).get(season) or []))
            except Exception as err:  # noqa: BLE001
                warn.append(f"读 Emby/TMDb 失败：{err}")
        tasks = [(h, t) for h, t in (self.p._load_tasks() or {}).items()
                 if (t.get("meta") or {}).get("sub_id") == sub.id
                 or (tid and f"[tmdbid={tid}]" in (t.get("dir") or "") and (f"/Season {season}" in t.get("dir", "") or "/Season " not in t.get("dir", "")))]
        note = {int(e) for e in (sub.note or []) if str(e).isdigit()} if isinstance(sub.note, list) else set()
        total = int(sub.total_episode or 0)
        span = [e for e in tm_eps if e > off]
        if total and span and len(span) != total:
            warn.append(f"订阅总集数 {total}（{'Bangumi' if src == 'bangumi' else 'MP'}）和 TMDb 本季 {len(span)} 集对不上")
        first = int(sub.start_episode or 1)
        eps_out = []
        for e in range(first, max(total, len(span), max(note or {0})) + 1):
            te = e + off
            row = {"ep": e, "tmdbEp": te, "state": "未播", "hash": None, "detail": ""}
            mine = [(h, t) for h, t in tasks if e in self._task_eps(t) or te in self._task_eps(t)]
            mine.sort(key=lambda kv: -(kv[1].get("added") or 0))
            if te in have:
                row["state"] = "已入库"
            elif mine:
                h, t = mine[0]
                st = t.get("status")
                row["hash"], row["detail"] = h, (t.get("name") or t.get("title") or "")[:120]
                row["state"] = ("卡住" if t.get("stalled") else "下载中") if st in ("downloading", "buffer") else \
                    "入库中" if st in ("uploaded", "done") else "已取消" if st in ("cancelled", "superseded") else "失败"
            elif e in note:
                row["state"] = "已提交"
            elif te in aired or (not tm_eps and e <= len(aired)):
                row["state"] = "缺"
            eps_out.append(row)
        return {"ok": True, "warnings": warn,
                "sub": {"id": sub.id, "name": sub.name, "year": sub.year, "season": sub.season, "source": src, "mediaId": sub.media_id,
                        "total": total, "lack": sub.lack_episode, "state": sub.state, "user": sub.username,
                        "lastSearch": str(sub.last_search or ""), "lastUpdate": sub.last_update, "poster": sub.poster},
                "tmdb": {"id": tid, "season": season, "offset": off, "episodes": len(span), "aired": len([a for a in aired if a > off])},
                "episodes": eps_out}

    # ---------------- 115 ----------------
    def offline(self, pages: int = 2) -> Dict[str, Any]:
        p = self.p._pipe
        if not p:
            return {"ok": False, "error": "流水线未就绪"}
        mine = self.p._load_tasks()
        rows = []
        for h, t in self._c115(int(pages)).items():
            rows.append({"hash": h, "name": t.get("name"), "size": t.get("size"), "percent": t.get("percentDone"),
                         "status": t.get("status"), "rate": t.get("rateDownload"), "peers": t.get("peers"),
                         "added": t.get("add_time"), "updated": t.get("last_update"),
                         "dir": (mine.get(h) or {}).get("dir"), "ours": h in mine})
        rows.sort(key=lambda r: -(r.get("added") or 0))
        return {"ok": True, "tasks": rows}

    def offline_delete(self, payload: dict = Body(...)) -> Dict[str, Any]:
        p = self.p._pipe
        if not p:
            return {"ok": False, "error": "流水线未就绪"}
        n = 0
        for h in payload.get("hashes") or []:
            try:
                p.c115.task_del(str(h).lower())
                n += 1
            except Exception as err:  # noqa: BLE001
                logger.warning(f"【Prowlarr115】删 115 任务 {h} 失败：{err}")
        self._c115_cache = (0.0, {})
        return {"ok": True, "deleted": n}

    # ---------------- qBittorrent ----------------
    def qb(self, filter: str = "all", category: str = "") -> Dict[str, Any]:  # noqa: A002
        p = self.p._pipe
        if not p or not p.qb:
            return {"ok": False, "error": "没有配置 qBittorrent"}
        params = {"filter": filter, "sort": "added_on", "reverse": "true"}
        if category:
            params["category"] = category
        keys = ("hash", "name", "size", "total_size", "progress", "dlspeed", "upspeed", "eta", "state", "category",
                "added_on", "completion_on", "num_seeds", "num_leechs", "ratio", "save_path", "tags")
        rows = [{k: q.get(k) for k in keys} for q in p.qb.get("/api/v2/torrents/info", params) or []]
        return {"ok": True, "torrents": rows, "transfer": p.qb.get("/api/v2/transfer/info") or {}}

    def qb_action(self, payload: dict = Body(...)) -> Dict[str, Any]:
        p = self.p._pipe
        if not p or not p.qb:
            return {"ok": False, "error": "没有配置 qBittorrent"}
        hs = "|".join(str(h) for h in payload.get("hashes") or [])
        act = payload.get("action")
        if not hs or act not in ("pause", "resume", "delete", "recheck", "reannounce"):
            return {"ok": False, "error": "参数不对"}
        if act in ("pause", "resume"):
            p.qb.pause(hs, act == "pause")
            code = 200
        elif act == "delete":
            code = p.qb.post("/api/v2/torrents/delete", {"hashes": hs, "deleteFiles": "true" if payload.get("delete_files") else "false"})
        else:
            code = p.qb.post(f"/api/v2/torrents/{act}", {"hashes": hs})
        return {"ok": code == 200, "code": code}

    # ---------------- OpenList ----------------
    def openlist(self) -> Dict[str, Any]:
        p = self.p._pipe
        if not p:
            return {"ok": False, "error": "流水线未就绪"}
        out: Dict[str, Any] = {"ok": True}
        tok = p.ol._token or p.ol._login()
        for kind in ("copy", "upload", "offline_download", "offline_download_transfer"):
            out[kind] = {}
            for st in ("undone", "done"):
                try:
                    res = RequestUtils(headers={"Authorization": tok}, timeout=20).get_res(f"{p.ol.url}/api/task/{kind}/{st}")
                    data = (res.json() or {}).get("data") or [] if res is not None else []
                except Exception:  # noqa: BLE001
                    data = []
                data = data[-30:] if st == "done" else data
                out[kind][st] = [{"id": d.get("id"), "name": d.get("name"), "state": d.get("state"), "status": d.get("status"),
                                  "progress": d.get("progress"), "error": d.get("error"), "total": d.get("total_bytes"),
                                  "start": d.get("start_time"), "end": d.get("end_time")} for d in data]
        return out

    # ---------------- Emby ----------------
    def emby_get(self, path: str, query: str = "") -> Any:
        p = self.p._pipe
        if not p or not EMBY_GET_OK.match(path or "") or ".." in path:
            return {"ok": False, "error": "不允许的路径"}
        params = dict(urllib.parse.parse_qsl(query or ""))
        params.pop("api_key", None)
        return p.emby.get(path, **params)

    def emby_image(self, id: str, type: str = "Primary", w: int = 400, tag: str = "") -> Response:  # noqa: A002
        p = self.p._pipe
        if not p or not re.fullmatch(r"[0-9a-f]{1,40}", id or "") or not re.fullmatch(r"[A-Za-z]{2,20}(/\d+)?", type or ""):
            return Response(status_code=404)
        q = {"maxWidth": int(w), "quality": 85, "api_key": p.emby.key}
        if tag:
            q["tag"] = tag
        r = RequestUtils(timeout=30).get_res(f"{p.emby.url}/emby/Items/{id}/Images/{type}", params=q)
        if r is None or r.status_code != 200:
            return Response(status_code=getattr(r, "status_code", 502) or 502)
        return Response(content=r.content, media_type=r.headers.get("Content-Type") or "image/jpeg",
                        headers={"Cache-Control": "public, max-age=86400"})

    def emby_refresh(self, payload: dict = Body(...)) -> Dict[str, Any]:
        p = self.p._pipe
        iid = str(payload.get("id") or "")
        if not p or not re.fullmatch(r"[0-9a-f]{1,40}", iid):
            return {"ok": False, "error": "参数不对"}
        full = "FullRefresh"
        p.emby.post(f"/Items/{iid}/Refresh", None, Recursive="true", MetadataRefreshMode=full, ImageRefreshMode=full,
                    ReplaceAllMetadata="true" if payload.get("replace") else "false",
                    ReplaceAllImages="true" if payload.get("replace") else "false")
        return {"ok": True}

    def emby_scan(self) -> Dict[str, Any]:
        p = self.p._pipe
        if not p:
            return {"ok": False, "error": "流水线未就绪"}
        p.emby.post("/Library/Refresh")
        return {"ok": True}

    def emby_activity(self) -> Dict[str, Any]:
        p = self.p._pipe
        if not p:
            return {"ok": False, "error": "流水线未就绪"}
        tasks = p.emby.get("/ScheduledTasks", IsHidden="false") or []
        running = [{"id": t.get("Id"), "name": t.get("Name"), "category": t.get("Category"),
                    "progress": t.get("CurrentProgressPercentage"), "state": t.get("State")}
                   for t in tasks if t.get("State") in ("Running", "Cancelling")]
        recent = [{"id": t.get("Id"), "name": t.get("Name"), "status": (t.get("LastExecutionResult") or {}).get("Status"),
                   "end": (t.get("LastExecutionResult") or {}).get("EndTimeUtc")}
                  for t in tasks if t.get("Category") in ("Library", "Metadata", "媒体库", "元数据") and t.get("LastExecutionResult")]
        log = (p.emby.get("/System/ActivityLog/Entries", Limit="30") or {}).get("Items") or []
        return {"ok": True, "running": running, "library_tasks": recent,
                "log": [{"name": e.get("Name"), "type": e.get("Type"), "date": e.get("Date"), "severity": e.get("Severity"),
                         "overview": e.get("ShortOverview") or e.get("Overview")} for e in log]}

    # ---------------- 同目录字幕 ----------------
    SUB_EXT = (".ass", ".ssa", ".srt", ".vtt", ".sup", ".sub", ".idx")
    SUB_DIRS = re.compile(r"(?i)^(subs?|subtitles?|字幕|sc|tc|chs|cht)$")

    def _remote_of(self, url: str) -> str:
        """strm 里的 OpenList 直链（http://host/d/115/...?...）或 115 路径 → 115 路径。"""
        m = re.match(r"https?://[^/]+/d(/[^?]+)", url or "")
        return urllib.parse.unquote(m.group(1)) if m else (url or "")

    def subs_list(self, url: str) -> Dict[str, Any]:
        p = self.p._pipe
        if not p:
            return {"ok": False, "error": "流水线未就绪"}
        remote = self._remote_of(url)
        if not remote.startswith(p.root + "/") or ".." in remote:
            return {"ok": False, "error": "不在 115 媒体目录里"}
        d, video = remote.rsplit("/", 1)
        stem = video.rsplit(".", 1)[0]
        ep = ep_of(video)
        found = []
        try:
            entries = p.ol.list(d)
        except Exception as err:  # noqa: BLE001
            return {"ok": False, "error": f"列目录失败：{err}"}
        dirs = [e["name"] for e in entries if e.get("is_dir") and self.SUB_DIRS.match(e["name"])]
        for sub_dir, items in [(d, entries)] + [(f"{d}/{n}", None) for n in dirs[:3]]:
            if items is None:
                try:
                    items = p.ol.list(sub_dir)
                except Exception:  # noqa: BLE001
                    continue
            for e in items:
                n = e.get("name") or ""
                if e.get("is_dir") or not n.lower().endswith(self.SUB_EXT):
                    continue
                match = 2 if n.startswith(stem) else 1 if ep and ep_of(n) and ep_of(n)[1] == ep[1] and ep_of(n)[0] in (None, ep[0]) else 0
                lang = next((t for t in ("chs", "cht", "sc", "tc", "jpsc", "jptc", "zh", "chi", "eng", "en", "jpn", "ja")
                             if re.search(rf"(?i)[._\[\(\s]{t}[._\]\)\s]", f".{n.rsplit('.', 1)[0]}.")), "")
                found.append({"name": n, "path": f"{sub_dir}/{n}", "size": e.get("size"), "match": match, "lang": lang,
                              "format": n.rsplit(".", 1)[-1].lower()})
        found.sort(key=lambda x: (-x["match"], x["name"]))
        return {"ok": True, "dir": d, "video": video, "subs": found[:80]}

    def subs_file(self, path: str) -> Response:
        p = self.p._pipe
        if not p or not path.startswith(p.root + "/") or ".." in path or not path.lower().endswith(self.SUB_EXT):
            return Response(status_code=404)
        info = p.ol.get(path) or {}
        if int(info.get("size") or 0) > 20 * 1024 * 1024:
            return Response(status_code=413)
        data = p.ol.read(path)
        ext = path.rsplit(".", 1)[-1].lower()
        mime = {"srt": "application/x-subrip", "vtt": "text/vtt", "ass": "text/x-ssa", "ssa": "text/x-ssa"}.get(ext, "application/octet-stream")
        return Response(content=data, media_type=mime, headers={"Cache-Control": "private, max-age=3600"})
