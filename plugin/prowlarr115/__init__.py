"""Prowlarr 资源源 + 115 离线下载（MoviePilot V3 插件）。

用途：MoviePilot 未做站点认证时，内置站点索引不可用；本插件通过"插件资源源"通路
（SearchChain.search_plugin_torrents，site={}）把自建 Prowlarr 的搜索结果交给 MP 原生的
搜索页和订阅；下载时不经过 qBittorrent，直接把磁力交给 NAS 上的 mp115.py 接口提交 115 离线。

目录约定（与 NAS 脚本、Emby 一致）：
  ResourceDownload 事件里按 TMDb 识别结果改写保存路径为
    <root>/电影/<名> (<年>) [tmdbid=N]
    <root>/{剧集,动漫}/<名> (<年>) [tmdbid=N]/Season N
  root 默认 /115/Emby，必须落在 MP「下载目录」配置的根之内（MP 会校验）。
  NAS 端 mp115.py 在离线完成后生成同路径的 strm、拷外挂字幕、通知 Emby；目录名里的
  [tmdbid=N] 让 Emby 按 ID 精确匹配。

源码：skills/nas-manager/scripts/moviepilot/plugins/plugins.v3/prowlarr115/
"""
import asyncio
import json
import hashlib
import inspect
import re
import threading
import time
import unicodedata
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from contextvars import ContextVar
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from app.domain.context import TorrentInfo
from app.plugins import _PluginBase
from app.schemas.event import ResourceDownloadEventData
from app.schemas.types import ChainEventType, EventType, MediaType, MessageType
from app.sdk.events import Event, eventmanager
from app.sdk.logging import logger
from app.sdk.network import RequestUtils

from fastapi import Body

from . import batch as batch_mod
from .adult import AV_REJECT, CAT_ANIME, CAT_REAL, CODE_ONLY, JUNK_RX, Adult, av_code, rejected
from .adult import magnet as adult_magnet
from .clients import ClientError, Emby
from .hub import Hub
from .pipeline import LIBS, Pipeline, btih as _pipe_btih, ep_of, with_trackers
from .policy import DEFAULT_POLICY, DEFAULT_QUERY_TEMPLATES, gb_per_hour, load_policy, query_context, render_queries, runtime_minutes, veto, year_conflict

DOWNLOADER_NAME = "115离线"
TRACKERS = ("udp://tracker.opentrackr.org:1337/announce", "udp://open.stealth.si:80/announce",
            "http://nyaa.tracker.wf:7777/announce")
# 成人分类（Torznab 6000-6999）一律不收，避免真人片混进影视搜索
ADULT_CAT = range(6000, 7000)
ANIMATION_GENRE = 16
# 不报分类的索引器（TorrentKitty 等）里混着的同人/成人/非影视内容
JUNK = re.compile(r"(?i)hentai|\bporn|erohon|エロ本|同人|doujin|\bCOMIC\s?\d|COMIC1|\(C\d{2,3}\)|\[3D|\bJAV\b|"
                  r"\bmanga\b|画集|artbook|\bOST\b|soundtrack|原声|\bFLAC\b(?!.*(?:BD|Blu|HEVC|x26|AVC|1080|720|2160))")
_PROWLARR_SEM = threading.BoundedSemaphore(4)   # NAS 只有 2GB：2026-10-11 订阅风暴把它压到看门狗重启
# 当前这次搜索的目标媒体和季号（由包装后的 SearchChain 入口设置），插件资源源调用里拿不到它们
_TARGET: ContextVar = ContextVar("prowlarr115_target", default=None)
_SEASONS: ContextVar = ContextVar("prowlarr115_seasons", default=None)
# 同一轮搜索（MP v3.1.2+ 的 SearchSources：网页渐进式搜索、自动订阅）会按每个别名各调一次插件；
# 插件第一次就用全部关键词搜完，同一轮后面的调用返回空，避免重复结果和重复请求 Prowlarr
_ROUND: ContextVar = ContextVar("prowlarr115_round", default=None)


def _seasons_of(args: Dict[str, Any]) -> Optional[set]:
    """从 search_by_id(season=) 或 process(no_exists={key: {季: ...}}) 取要搜的季"""
    if args.get("season"):
        return {int(args["season"])}
    ne = args.get("no_exists") or {}
    out = {int(k) for v in ne.values() if isinstance(v, dict) for k in v.keys() if str(k).isdigit()}
    return out or None


_HOOKS = {
    "_SearchChain__search_all_sites": (_TARGET, lambda a: a.get("mediainfo")),
    "_SearchChain__async_search_all_sites": (_TARGET, lambda a: a.get("mediainfo")),
    "_SearchChain__async_search_all_sites_stream": (_TARGET, lambda a: a.get("mediainfo")),
    "search_by_id": (_SEASONS, _seasons_of), "async_search_by_id": (_SEASONS, _seasons_of),
    "async_search_by_id_stream": (_SEASONS, _seasons_of),
    "process": (_SEASONS, _seasons_of), "async_process": (_SEASONS, _seasons_of),
    "async_process_stream": (_SEASONS, _seasons_of),
}


def _wrap(orig, var: ContextVar, extract):
    """包装 SearchChain 方法：从参数里取值放进 ContextVar 再调用原方法（同步 / 协程 / 异步生成器）。"""
    sig = inspect.signature(orig)

    def value(a, kw):
        try:
            b = sig.bind_partial(*a, **kw)
            return extract(dict(b.arguments))
        except Exception:  # noqa: BLE001 取不到就当没有
            return None

    if inspect.isasyncgenfunction(orig):
        async def agen(*a, **kw):
            token = var.set(value(a, kw))
            try:
                async for ev in orig(*a, **kw):
                    yield ev
            finally:
                try:
                    var.reset(token)
                except ValueError:
                    pass
        fn = agen
    elif inspect.iscoroutinefunction(orig):
        async def coro(*a, **kw):
            token = var.set(value(a, kw))
            try:
                return await orig(*a, **kw)
            finally:
                var.reset(token)
        fn = coro
    else:
        def sync(*a, **kw):
            token = var.set(value(a, kw))
            try:
                return orig(*a, **kw)
            finally:
                var.reset(token)
        fn = sync
    fn.__wrapped_orig__ = orig
    return fn


# TMDb 把多季合成一季（文豪野犬 S1=60 集）时，字幕组的「S3」「第四季」合集会被 MP 的季号过滤丢掉。
# _search_target 把确认是这部作品的这类种子记在这里（enclosure -> TMDb 合并季号），match_season_episodes 放行，
# 再由 policy.pick 按播出间隔推出的各季起点换算集号。
_MERGED_ENCL: Dict[str, int] = {}


def _merged_season(media: Any) -> Optional[int]:
    """TMDb 里唯一一个 >=30 集的正片季（合并季）；没有返回 None。"""
    big = [int(k) for k, v in (getattr(media, "seasons", None) or {}).items() if int(k) > 0 and len(v or []) >= 30]
    return big[0] if len(big) == 1 else None


def _match_season_episodes_hook(orig):
    def fn(torrent, meta, season_episodes):
        m = _MERGED_ENCL.get(getattr(torrent, "enclosure", None) or "")
        if m is not None and season_episodes and m in season_episodes:
            return True
        return orig(torrent, meta, season_episodes)
    fn.__wrapped_orig__ = orig
    return fn


def _sources_fetch_hook(orig):
    """MP v3.1.2+：网页搜索（渐进式/分页）和自动订阅不再经过 SearchChain.__search_all_sites，
    而是 SearchSources.fetch 直接调插件——在这里放入目标作品、要搜的季和本轮标识。"""
    def fn(self, key, page, *a, **kw):
        q = (getattr(self, "queries", None) or {}).get(key) or {}
        if q.get("site") != "plugin":
            return orig(self, key, page, *a, **kw)
        se = getattr(self, "season_episodes", None)
        seasons = {int(k) for k in se if str(k).isdigit() and int(k) > 0} if isinstance(se, dict) else None
        tokens = [(v, v.set(x)) for v, x in ((_TARGET, getattr(self, "media", None)), (_SEASONS, seasons or None),
                                              (_ROUND, self))]
        try:
            return orig(self, key, page, *a, **kw)
        finally:
            for v, t in reversed(tokens):
                v.reset(t)
    fn.__wrapped_orig__ = orig
    return fn


def _install_hooks() -> None:
    """给 SearchChain 的搜索入口、SearchSources.fetch、TorrentHelper.match_season_episodes 装上包装（幂等）。"""
    from app.chain.search import SearchChain
    for name, (var, extract) in _HOOKS.items():
        fn = SearchChain.__dict__.get(name)
        if fn is not None and callable(fn) and not hasattr(fn, "__wrapped_orig__"):
            setattr(SearchChain, name, _wrap(fn, var, extract))
    try:
        from app.chain.search.scan import SearchSources
        fn = SearchSources.__dict__.get("fetch")
        if fn is not None and not hasattr(fn, "__wrapped_orig__"):
            SearchSources.fetch = _sources_fetch_hook(fn)
    except ImportError:
        pass                      # MP 旧版没有 SearchSources，靠上面的 SearchChain 钩子
    except Exception as err:  # noqa: BLE001
        logger.warning(f"【Prowlarr115】SearchSources 钩子没装上：{err}")
    try:
        from app.application.torrent.download import TorrentHelper
        fn = TorrentHelper.__dict__.get("match_season_episodes")
        orig = getattr(fn, "__func__", fn)
        if orig is not None and not hasattr(orig, "__wrapped_orig__"):
            TorrentHelper.match_season_episodes = staticmethod(_match_season_episodes_hook(orig))
    except Exception as err:  # noqa: BLE001
        logger.warning(f"【Prowlarr115】合并季过滤钩子没装上：{err}")


def _remove_hooks() -> None:
    """还原 SearchChain 的搜索入口、SearchSources 和 TorrentHelper。"""
    from app.chain.search import SearchChain
    for name in _HOOKS:
        fn = SearchChain.__dict__.get(name)
        if fn is not None and hasattr(fn, "__wrapped_orig__"):
            setattr(SearchChain, name, fn.__wrapped_orig__)
    try:
        from app.chain.search.scan import SearchSources
        fn = SearchSources.__dict__.get("fetch")
        if hasattr(fn, "__wrapped_orig__"):
            SearchSources.fetch = fn.__wrapped_orig__
    except Exception:  # noqa: BLE001
        pass
    try:
        from app.application.torrent.download import TorrentHelper
        fn = TorrentHelper.__dict__.get("match_season_episodes")
        orig = getattr(fn, "__func__", fn)
        if hasattr(orig, "__wrapped_orig__"):
            TorrentHelper.match_season_episodes = staticmethod(orig.__wrapped_orig__)
    except Exception:  # noqa: BLE001
        pass


CN_NUM = "零一二三四五六七八九十"
_ROMAN = {"Ⅱ": 2, "Ⅲ": 3, "Ⅳ": 4, "Ⅴ": 5}


def _clean_title(t: str, tv: bool) -> str:
    """把 MP 解析会出错的写法改成它认得的（实测于 MP v3.1.2 的 MetaInfo）：
    「10-bit」被当成第 10 集；「[00-12Fin]」只认出第 0 集；剧集的「Ⅱ / II / 2期」认不出季号。"""
    t = re.sub(r"(?i)(\d{1,2})-bit", r"\1bit", t or "")
    t = re.sub(r"(?i)(\d{1,3})\s*[-~～]\s*(\d{1,3})\s*(fin|end|完)", r"\1-\2 \3", t)
    if tv:
        for k, v in _ROMAN.items():
            t = re.sub(rf"\s*{k}\s*", f" S{v} ", t, count=1)
        t = re.sub(r"(?<=[A-Za-z])\s+(II|III|IV)(?=\s|$|[～~:：\]/|(])",
                   lambda m: f" S{['II', 'III', 'IV'].index(m.group(1)) + 2}", t, count=1)
        t = re.sub(r"(?<![\d第])(\d{1,2})\s*期", r" S\1 ", t, count=1)
        t = re.sub(r"△\s*(\d)(?!\d)", r"△ S\1 ", t, count=1)          # 「ゆるキャン△2」
    return t


def _norm(text: str) -> str:
    """标题规范化：NFKC、小写、去掉空白和标点（保留中日文字符）。"""
    return re.sub(r"[\W_]+", "", unicodedata.normalize("NFKC", text or "").lower())


_SEASON_SUFFIX = re.compile(r"(?i)\s*[(（]?(?:第\s*[一二三四五六七八九十\d]+\s*(?:季|期|部分|部|クール)|season\s*\d+|\d+(?:st|nd|rd|th)\s*season|"
                            r"s\d{1,2}|part\s*\d+|cour\s*\d+|\d+期)[)）]?\s*$")


def _base_name(n: str) -> str:
    """去掉名字末尾的季/篇标记（Bangumi 条目名「アオのハコ Season 2」「夜樱家的大作战 第二季 第2部分」）。
    发布标题大多只写作品名，带着「Season 2」去搜会漏掉，也认不出身份。"""
    prev = None
    while n and n != prev:
        prev, n = n, _SEASON_SUFFIX.sub("", n).strip()
    return n


_EP_TOKEN = (r"(?<=\[)0*{n}(?=(?:v\d)?\])", r"(?<=\s-\s)0*{n}(?=(?:v\d)?(?:\s|\[|\(|\.|$))", r"(?<=第)0*{n}(?=[集话話])",
             r"(?<=[Ee])0*{n}(?!\d)")


def _relabel_abs(title: str, ep: int, rel: int, season: int) -> str:
    """绝对集号改成本季集号（「青之箱 第二季 [27]」-> S02E02，「Black Clover Season 2 - 172」-> S02E02），
    让 MP 按本季缺的集挑选。只改第一处集号。"""
    for rx in _EP_TOKEN:
        t, k = re.subn(rx.format(n=ep), f"{rel:02d}", title, count=1)
        if k:
            if not re.search(r"(?i)\bS\d{1,2}(?:E\d+)?\b|season\s*\d|第.{1,2}季|\d+(?:st|nd|rd|th)\s*season", t):
                t = f"{t} S{season:02d}"
            return t
    return title


def _bdecode(data: bytes, i: int = 0):
    """最小 bencode 解析，返回 (值, 结束位置)；只用于从种子文件里定位 info 字典。"""
    c = data[i:i + 1]
    if c == b"i":
        j = data.index(b"e", i)
        return int(data[i + 1:j]), j + 1
    if c == b"l":
        i, out = i + 1, []
        while data[i:i + 1] != b"e":
            v, i = _bdecode(data, i)
            out.append(v)
        return out, i + 1
    if c == b"d":
        i, out = i + 1, {}
        while data[i:i + 1] != b"e":
            k, i = _bdecode(data, i)
            start = i
            v, i = _bdecode(data, i)
            out[k] = v
            if k == b"info":
                out[b"__info_span__"] = (start, i)
        return out, i + 1
    j = data.index(b":", i)
    n = int(data[i:j])
    return data[j + 1:j + 1 + n], j + 1 + n


def _torrent_to_magnet(content: bytes) -> Optional[str]:
    """种子文件内容 -> 磁力链接（info 字典的 SHA1）。"""
    try:
        meta, _ = _bdecode(content)
        start, end = meta[b"__info_span__"]
        h = hashlib.sha1(content[start:end]).hexdigest()
        name = meta.get(b"info", {}).get(b"name", b"").decode("utf-8", "ignore")
        return _magnet(h, name)
    except Exception as err:  # noqa: BLE001 种子格式异常时让调用方报错
        logger.warning(f"【Prowlarr115】解析种子失败：{err}")
        return None


def _magnet(info_hash: str, name: str = "") -> str:
    """用 info hash 拼磁力链接，带几个公共 tracker。"""
    q = [("xt", f"urn:btih:{info_hash.lower()}")]
    if name:
        q.append(("dn", name))
    q += [("tr", t) for t in TRACKERS]
    return "magnet:?" + urllib.parse.urlencode(q, safe=":/")


def _safe(name: str) -> str:
    """去掉路径非法字符。"""
    return re.sub(r'[\\/:*?"<>|]', " ", name or "").strip()


class Prowlarr115(_PluginBase):
    """Prowlarr 资源源 + 115 离线下载。"""

    plugin_name = "115 媒体入库（Prowlarr 资源源 + 115 离线）"
    plugin_desc = ("未认证也能用：多关键词资源源 + 下载直接 115 离线（失败转 NAS 缓冲）+ strm 入 Emby + 刮削确认通知 + 批量入库 API；"
                   "AV（番号 → 115 → MDC 刮削）和里番（追更目录 + sukebei RSS → 115 → Bangumi）也在这里。")
    plugin_icon = "https://raw.githubusercontent.com/Prowlarr/Prowlarr/develop/Logo/256.png"
    plugin_version = "2.23.0"
    plugin_label = "资源搜索,下载器"
    plugin_author = "mediahub"
    author_url = ""
    plugin_config_prefix = "prowlarr115_"
    plugin_order = 5
    auth_level = 1

    _enabled = False
    _prowlarr_url = ""
    _prowlarr_key = ""
    _indexers: List[int] = []
    _exclude_indexers: List[int] = []
    _min_seeders = 1
    _max_results = 100
    _timeout = 60
    _offline = False
    _conf: Dict[str, Any] = {}
    _pending_meta: Dict[tuple, dict] = {}
    _overrides: Dict[tuple, dict] = {}      # 批量入库给某作品某季的附加参数（ep_offset 等）
    _hash_overrides: Dict[str, dict] = {}   # 按种子 hash 的附加参数（合并季的分季合集偏移）

    @staticmethod
    def _btih(link: str) -> str:
        """磁力的 info hash（十六进制小写；base32 自动转换）。"""
        return _pipe_btih(link or "") or ""
    def _take_meta(self, path: str, h: str) -> Optional[dict]:
        """取下载事件记下的作品信息：先按 (目录, hash)；enclosure 是种子 URL（算不出 hash）时，同目录只有一条才用它。"""
        now_ = time.time()
        for k in [k for k, v in self._pending_meta.items() if now_ - v.get("_at", now_) > 3600]:
            self._pending_meta.pop(k, None)
        hit = self._pending_meta.pop((path, h), None)
        if hit is None:
            same = [k for k in self._pending_meta if k[0] == path and not k[1]]
            hit = self._pending_meta.pop(same[0]) if len(same) == 1 else None
        if hit is not None:
            hit.pop("_at", None)
        return hit

    _pipe = None
    _adult = None
    _adult_hints: Dict[str, dict] = {}      # MP 搜索框里搜出来的 AV/里番 结果：btih -> {kind, title}，下载时据此分流
    _notify = True
    _root = "/115/Emby"
    _lock = threading.Lock()

    # ---------------- 生命周期 ----------------
    def init_plugin(self, config: dict = None) -> None:
        """读取插件配置。"""
        config = config or {}
        try:   # 作品级 override 持久化（订阅会在几周里陆续下载，不能重载就丢）
            saved = self.get_data("overrides") or {}
            self._overrides = {(k.split("|")[0], int(k.split("|")[1]) if k.split("|")[1] not in ("", "None") else None): v
                               for k, v in saved.items()}
        except Exception:  # noqa: BLE001
            self._overrides = {}
        self._enabled = bool(config.get("enabled"))
        self._prowlarr_url = str(config.get("prowlarr_url") or "http://prowlarr:9696").rstrip("/")
        self._prowlarr_key = str(config.get("prowlarr_key") or "")
        self._indexers = self._ids(config.get("indexers"))
        self._exclude_indexers = self._ids(config.get("exclude_indexers"))
        self._min_seeders = int(config.get("min_seeders") or 0)
        self._max_results = int(config.get("max_results") or 200)
        self._timeout = int(config.get("timeout") or 60)
        self._offline = bool(config.get("offline"))
        self._root = "/" + str(config.get("root") or "/115/Emby").strip("/")
        self._notify = config.get("notify", True) not in (False, "false", 0)
        self._conf = dict(self._defaults(), **{k: v for k, v in config.items() if v not in (None, "")})
        self._conf["root"] = self._root
        self._pipe = None
        if self._enabled and self._offline:
            try:
                self._pipe = Pipeline(self._conf, self._load_tasks, self._save_tasks, self._post, self._log,
                                      lambda: self.get_data("events") or {}, lambda ev: self.save_data("events", ev))
                self._pipe.on_fail = self._on_task_failed
                self._pipe.on_ok = self._blacklist_drop
                # 动漫库按 TMDb 编号（2026-10-27 起；之前按 TVDB，映射只留给 /anime/tmdb_renumber 迁移用）
            except Exception as err:  # noqa: BLE001 配置不全时不接管下载，免得原片落错地方
                logger.error(f"【Prowlarr115】流水线初始化失败，下载不会被接管：{err}")
        self._adult = None
        if self._pipe and config.get("adult", True) not in (False, "false", 0):
            self._adult = Adult(self._pipe, self._conf, self.get_data, self.save_data, self._post, self._log)
            self._pipe.adult = self._adult
            inbox = {k: str(config.get(k) or "").strip() for k in ("av_inbox", "hentai_inbox")}
            if any(inbox.values()):     # 设置页里填的待入库清单：清空字段后在后台处理
                self.update_config(dict(config, av_inbox="", hentai_inbox=""))
                threading.Thread(target=self._drain_inbox, args=(inbox,), name="prowlarr115-inbox", daemon=True).start()
        self._multi = config.get("multi_keyword", True) not in (False, "false", 0)
        if self._enabled and self._multi:
            try:
                _install_hooks()
            except Exception as err:  # noqa: BLE001 宿主结构变化时退回单关键词
                logger.warning(f"【Prowlarr115】安装搜索目标钩子失败，只用 MP 给的关键词：{err}")

    @staticmethod
    def _ids(value: Any) -> List[int]:
        """把 "1, 3,15" 解析成整数列表。"""
        return [int(x) for x in re.findall(r"\d+", str(value or ""))]

    @staticmethod
    def _defaults() -> Dict[str, Any]:
        """流水线配置默认值（地址按你的部署填写）。"""
        return {"openlist_url": "http://openlist:5244", "openlist_public": "http://openlist:5244",
                "openlist_user": "", "openlist_pass": "", "cookie_115": "", "proxy_115": "",
                "qb_url": "http://qbittorrent:8080", "qb_user": "admin", "qb_pass": "",
                "emby_url": "http://emby:8096", "emby_key": "", "emby_lib_root": "/media/library",
                "lib_ol_root": "/media/媒体库", "buffer_ol": "/media/.mp115-buffer",
                "buffer_local": "/media/.mp115-buffer", "buffer_max_gb": 20, "root": "/115/Emby"}

    def _load_tasks(self) -> dict:
        return self.get_data("tasks") or {}

    def _save_tasks(self, tasks: dict) -> None:
        # 只保留最近 1000 条（订阅每周都会进新任务）
        items = sorted(tasks.items(), key=lambda kv: -kv[1].get("added", 0))[:1000]
        self.save_data("tasks", dict(items))

    def _log(self, msg: str) -> None:
        logger.info(f"【Prowlarr115】{msg}")

    def _post(self, title: str, text: str) -> None:
        """进度通知走 MP 自己的消息渠道（服务通知群 bot）。"""
        self._log(f"{title}：{text}")
        if self._notify:
            self.post_message(mtype=MessageType.Organize, title=title, text=text)

    # ---------------- 黑名单与失败回滚 ----------------
    # 下不动 / 没有可入库视频 / 用户换掉的资源记进黑名单：订阅搜索不再返回它、MP 选中它时下载事件里拦掉，
    # MP 才会去选同一集的下一个候选。插件数据 blacklist = {hash: {at, reason, title, dir}}
    def _blacklist(self) -> Dict[str, dict]:
        return self.get_data("blacklist") or {}

    def _blacklist_add(self, h: str, reason: str, t: Optional[dict] = None) -> None:
        if not h:
            return
        bl = self._blacklist()
        bl[h.lower()] = {"at": int(time.time()), "reason": reason[:120], "title": ((t or {}).get("name") or (t or {}).get("title") or "")[:200],
                         "dir": (t or {}).get("dir") or ""}
        if len(bl) > 3000:
            for k in sorted(bl, key=lambda k: bl[k].get("at", 0))[:len(bl) - 3000]:
                bl.pop(k, None)
        self.save_data("blacklist", bl)

    def _blacklist_drop(self, h: str) -> None:
        bl = self._blacklist()
        if bl.pop((h or "").lower(), None) is not None:
            self.save_data("blacklist", bl)

    def _on_task_failed(self, h: str, t: dict, reason: str) -> None:
        """流水线判定资源不可用（no-video / dead / too-big）或被用户换掉时：拉黑，并把这几集从 MP 订阅的
        「已下载」里去掉（MP 按订阅 note 记已下载集，不看入库结果；不回滚的话订阅会以为下好了直接结束）。"""
        self._blacklist_add(h, reason, t)
        meta = t.get("meta") or {}
        sid, eps = meta.get("sub_id"), [int(e) for e in meta.get("episodes") or [] if str(e).isdigit()]
        if not sid:
            return
        try:
            from app.db.oper.subscribe import SubscribeOper
            oper = SubscribeOper()
            sub = oper.get(int(sid))
            if not sub:
                self._pipe.event(h, "manual", f"订阅 {sid} 已结束，没法回滚已下载集；请在影库 App 里换资源", "warn")
                self._post("⚠️ " + (t.get("dir") or "").split("/")[-2 if "/Season " in (t.get("dir") or "") else -1],
                           f"{reason}，但对应订阅已结束：请在影库 App 任务详情里「换一个资源」")
                return
            note = [e for e in (sub.note or []) if not eps or int(e) not in eps] if isinstance(sub.note, list) else sub.note
            prio = {k: v for k, v in (sub.episode_priority or {}).items() if not eps or int(k) not in eps}
            oper.update(int(sid), {"note": note, "episode_priority": prio})
            self._pipe.event(h, "manual", f"已从订阅 {sub.name} 的已下载集里去掉 {eps or '全部'}，MP 下一轮会换资源")
        except Exception as err:  # noqa: BLE001
            logger.warning(f"【Prowlarr115】回滚订阅 {sid} 失败：{err}")

    def _vetoed(self, title: str, h: str = "", pol: Optional[dict] = None, bl: Optional[dict] = None) -> Optional[str]:
        """不该交给 MP 的资源：黑名单或选片策略硬性排除（硬字幕、REMUX…）。批量判断时传入 pol/bl 免得每条都读一次。"""
        bl = self._blacklist() if bl is None else bl
        if h and h.lower() in bl:
            return "已拉黑：" + (bl[h.lower()].get("reason") or "")
        return veto(title, pol or self._policy())

    def _ended_key(self, sub: Any) -> str:
        src = getattr(sub, "media_source", None) or "themoviedb"
        mid = getattr(sub, "media_id", None) or getattr(sub, "tmdbid", None) or ""
        return f"{src}:{mid}:{getattr(sub, 'season', None) or ''}"

    @eventmanager.register(EventType.SubscribeComplete)
    def on_subscribe_complete(self, event: Event) -> None:
        self._remember_ended(event, "完成")

    @eventmanager.register(EventType.SubscribeDeleted)
    def on_subscribe_deleted(self, event: Event) -> None:
        self._remember_ended(event, "删除")

    def _remember_ended(self, event: Event, how: str) -> None:
        """结束（完成/删除）的订阅记进「已结束」名单：自动订阅助手每天会把季度新番重新加一遍，
        守卫据此删掉重复加回来的订阅（手动订阅不受影响）。插件数据 ended_subs = {key: {at, how, name}}"""
        if not self._enabled or not event or not event.event_data:
            return
        try:
            d = event.event_data or {}
            info = (d.get("subscribe_info") if isinstance(d, dict) else getattr(d, "subscribe_info", None)) or {}
            if not isinstance(info, dict):
                info = getattr(info, "__dict__", {}) or {}
            class _S:   # noqa: N801
                pass
            sub = _S()
            for k in ("media_source", "media_id", "tmdbid", "season", "name"):
                setattr(sub, k, info.get(k))
            if not (sub.media_id or sub.tmdbid):
                return
            ended = self.get_data("ended_subs") or {}
            ended[self._ended_key(sub)] = {"at": int(time.time()), "how": how, "name": sub.name}
            self.save_data("ended_subs", ended)
        except Exception as err:  # noqa: BLE001
            logger.warning(f"【Prowlarr115】记录已结束订阅失败：{err}")

    # ---------------- 订阅守卫 ----------------
    GUARD_USERS = ("自动订阅助手",)
    BLOCKED_TITLES = ("暗芝居",)  # 用户不要的作品：自动订阅助手加了就删（配置 subscribe_block 可追加，逗号分隔）

    @eventmanager.register(EventType.SubscribeAdded)
    def on_subscribe_added(self, event: Event) -> None:
        """自动订阅助手（Mikan 季度新番）会把柯南、面包超人这类上千集的长篇也加进来，一搜就是几千个下载：立即删掉。"""
        if not self._enabled or not event or not event.event_data:
            return
        try:
            self._guard_subscribe((event.event_data or {}).get("subscribe_id"))
        except Exception as err:  # noqa: BLE001
            logger.warning(f"【Prowlarr115】订阅守卫出错：{err}")

    def _guard_subscribe(self, sid: Any = None) -> int:
        """sid=None：扫一遍全部订阅。返回删掉的个数。"""
        from app.db.oper.subscribe import SubscribeOper
        limit = int(self._conf.get("subscribe_max_total") or 100)
        blocked = list(self.BLOCKED_TITLES) + [x.strip() for x in str(self._conf.get("subscribe_block") or "").split(",")]
        oper = SubscribeOper()
        ended = self.get_data("ended_subs") or {}
        subs = [oper.get(int(sid))] if sid else oper.list()
        n = 0
        for sub in subs:
            if not sub or getattr(sub, "username", "") not in self.GUARD_USERS:
                continue
            name = getattr(sub, "name", "") or ""
            if self._ended_key(sub) in ended:
                # 已结束（完成或被删）的订阅被自动订阅助手重新加回来：删掉，不发通知（10-11~10-27 每天循环过）
                oper.delete(sub.id)
                n += 1
                self._log(f"订阅守卫：{name} S{sub.season} 已结束过（{ended[self._ended_key(sub)].get('how')}），删掉重新加回来的订阅")
                continue
            if getattr(sub, "type", "") == MediaType.TV.value and getattr(sub, "season", None) is None:
                oper.delete(sub.id)
                n += 1
                self._post("🛑 已删除无法追更的订阅", f"{name}：没有季号（多半是剧场版/短片被当成剧集），自动订阅助手加的订阅已删除")
                continue
            if any(b and b in name for b in blocked):
                oper.delete(sub.id)
                n += 1
                self._post("🛑 已拦截屏蔽作品订阅", f"{name} S{sub.season}：在屏蔽名单里，订阅已删除")
                continue
            total = int(getattr(sub, "total_episode", 0) or 0)
            if total > limit and not getattr(sub, "start_episode", None):
                oper.delete(sub.id)
                n += 1
                self._post("🛑 已拦截长篇订阅", f"{sub.name} S{sub.season}：共 {total} 集（>{limit}），自动订阅助手加的订阅已删除；"
                                            f"需要追的话手动订阅并设起始集")
        return n

    def track(self) -> None:
        """定时推进任务：115 进度 → 缓冲 → strm → Emby 刮削确认。"""
        if not self._pipe:
            return
        # 文件锁：插件热重载后旧实例的线程可能还在跑，进程内的锁拦不住；两轮并行会互相覆盖状态、重复发通知
        import fcntl
        with open("/tmp/prowlarr115-track.lock", "w") as fh:
            try:
                fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                logger.info("【Prowlarr115】上一轮跟踪还没结束，跳过本轮")
                return
            with self._lock:
                try:
                    self._guard_subscribe()
                except Exception as err:  # noqa: BLE001
                    logger.warning(f"【Prowlarr115】订阅守卫出错：{err}")
                self._pipe.run()

    def get_service(self) -> List[Dict[str, Any]]:
        """每 5 分钟推进一次影视下载任务；AV/里番 单独一个服务（里番每天的全量搜索要几分钟，不能卡住影视入库）。"""
        if not self._pipe:
            return []
        svc = [{"id": "Prowlarr115Track", "name": "Prowlarr115 下载跟踪", "trigger": "interval",
                "func": self.track, "kwargs": {"minutes": 5}}]
        if self._adult:
            svc.append({"id": "Prowlarr115Adult", "name": "AV / 里番 入库", "trigger": "interval",
                        "func": self.adult_track, "kwargs": {"minutes": 5}})
        return svc

    def adult_track(self, quick: bool = False) -> None:
        """AV（115 → MDC → 整理）和里番（RSS/catalog/strm）。quick：只推进 AV 和里番入库（提交后的快速跟踪）。"""
        if not self._adult:
            return
        import fcntl
        with open("/tmp/prowlarr115-adult.lock", "w") as fh:
            try:
                fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                return
            if quick:
                for fn in (self._adult.av_run, self._adult.scan):
                    try:
                        fn()
                    except Exception as err:  # noqa: BLE001
                        logger.warning(f"【Prowlarr115】AV/里番快速跟踪出错（{fn.__name__}）：{err}")
            else:
                self._adult.run()

    _adult_kick_until = 0.0

    def _adult_kick(self, minutes: int = 180) -> None:
        """AV/里番提交后只在有活要干时主动推进：前 20 分钟每 20 秒（115 秒传 + MDC 刮削，一两分钟进库），之后每分钟，最长 minutes 分钟。"""
        busy = self._adult_kick_until > time.time()
        self._adult_kick_until = time.time() + minutes * 60
        if busy:
            return

        def loop():
            t0 = time.time()
            while time.time() < self._adult_kick_until:
                time.sleep(20 if time.time() - t0 < 1200 else 60)
                self.adult_track(quick=True)
        threading.Thread(target=loop, name="prowlarr115-adult-kick", daemon=True).start()

    def _drain_inbox(self, inbox: Dict[str, str]) -> None:
        """设置页「待入库」清单：AV 番号/磁力、里番标题（每行一个）。"""
        lines = lambda k: [x.strip() for x in re.split(r"[\r\n]+", inbox.get(k) or "") if x.strip()]  # noqa: E731
        if lines("av_inbox"):
            res = self._adult.av_add(lines("av_inbox"))
            ok = [r.get("code") or r["item"][:30] for r in res if r.get("ok")]
            bad = [f"{r.get('code') or r['item'][:30]}（{r.get('error')}）" for r in res if not r.get("ok")]
            self._post("🔞 AV 待入库", f"已提交 {len(ok)} 个：{' '.join(ok)}" + (f"；未提交：{'、'.join(bad)}" if bad else ""))
            self._adult_kick()
        if lines("hentai_inbox"):
            titles = lines("hentai_inbox")
            self._adult.catalog_add(titles)
            rep = self._adult.ingest(only=titles)
            self._post("🔞 里番待入库", "\n".join(rep) or "没有搜到新的资源（已加进追更目录，每天会再搜）")
            self._adult_kick()

    def get_state(self) -> bool:
        """插件是否启用。"""
        return self._enabled

    @staticmethod
    def get_command() -> List[Dict[str, Any]]:
        """无远程命令。"""
        return []

    def get_api(self) -> List[Dict[str, Any]]:
        """插件 API：运维（测试、任务、重试、批量、AV/里番）+ App 聚合接口 /hub/*。"""
        return [
            {"path": "/test", "endpoint": self.api_test, "methods": ["GET"], "summary": "测试 Prowlarr/OpenList/115/qB/Emby 连通"},
            {"path": "/tasks", "endpoint": self.api_tasks, "methods": ["GET"], "summary": "下载任务（115 离线/缓冲/入库/刮削）"},
            {"path": "/run", "endpoint": self.api_run, "methods": ["POST"], "summary": "立即推进一次任务"},
            {"path": "/retry", "endpoint": self.api_retry, "methods": ["POST"], "summary": "重试任务：hash，mode=offline|buffer|strm"},
            {"path": "/retry_status", "endpoint": self.api_retry_status, "methods": ["POST"], "summary": "按状态批量重试入库：status=no-video"},
            {"path": "/cancel", "endpoint": self.api_cancel, "methods": ["POST"], "summary": "取消任务并删除 115 上已下的文件：{hashes:[..]} 或 {match:'正则', dir:'目录片段'}"},
            {"path": "/batch", "endpoint": self.api_batch, "methods": ["POST"], "summary": "批量入库（见 batch.py 说明）"},
            {"path": "/batch", "endpoint": self.api_batch_status, "methods": ["GET"], "summary": "批量作业进度：job="},
            {"path": "/policy", "endpoint": self.api_policy_get, "methods": ["GET"], "summary": "当前选片策略和关键词模板"},
            {"path": "/policy", "endpoint": self.api_policy_set, "methods": ["POST"], "summary": "更新选片策略/关键词模板（合并更新）"},
            {"path": "/queries", "endpoint": self.api_queries, "methods": ["GET"], "summary": "预览某作品会用哪些关键词：tmdbid,type,season"},
            {"path": "/submit", "endpoint": self.api_submit, "methods": ["POST"], "summary": "指定资源入库：{magnet|hash, tmdbid, type, season, meta, dry_run}"},
            {"path": "/rename_folder", "endpoint": self.api_rename_folder, "methods": ["POST"], "summary": "作品目录改成标准名「名称 (年份) [tmdbid=N]」：{lib, old, tmdbid, type, dry_run}（115 和媒体库一起改、合并、改写 strm）"},
            {"path": "/anime/tmdb_renumber", "endpoint": self.api_tmdb_renumber, "methods": ["POST"], "summary": "动漫库 TVDB 编号改回 TMDb：{dry_run, tmdbid}"},
            {"path": "/retarget", "endpoint": self.api_retarget, "methods": ["POST"], "summary": "任务认错作品时改到另一部：{hash, tmdbid, type, season, dry_run}（移动 115 文件、重建 strm）"},
            {"path": "/task_meta", "endpoint": self.api_task_meta, "methods": ["POST"], "summary": "改已提交任务的入库参数：{hash, meta:{merged_season, ep_offset, season_starts}}"},
            {"path": "/override", "endpoint": self.api_override, "methods": ["POST"], "summary": "给某作品某季的下一次下载附加参数：{tmdbid, season, ep_offset}"},
            {"path": "/av/add", "endpoint": self.api_av_add, "methods": ["POST"], "summary": "AV 入库：{items:[番号或磁力], dry_run, force}"},
            {"path": "/av/retry", "endpoint": self.api_av_retry, "methods": ["POST"], "summary": "MDC 刮削失败的 AV 重新刮削：{name}（空=全部失败的）"},
            {"path": "/hentai/add", "endpoint": self.api_hentai_add, "methods": ["POST"], "summary": "里番加入追更并立即搜索入库：{titles:[..], search:true}"},
            {"path": "/hentai/submit", "endpoint": self.api_hentai_submit, "methods": ["POST"], "summary": "指定里番资源入库：{magnet|hash, title, ep}"},
            {"path": "/hentai/scan", "endpoint": self.api_hentai_scan, "methods": ["POST"], "summary": "里番：扫描 115 上所有系列，补生成缺的 strm"},
            {"path": "/hentai/fix", "endpoint": self.api_hentai_fix, "methods": ["POST"], "summary": "Emby 里番按目录名里的 bangumiid 重新识别"},
            {"path": "/adult/status", "endpoint": self.api_adult_status, "methods": ["GET"], "summary": "AV/里番 状态"},
            {"path": "/adult/run", "endpoint": self.api_adult_run, "methods": ["POST"], "summary": "立即推进 AV/里番（full=true 含 RSS 和全量搜索）"},
            {"path": "/adult/import", "endpoint": self.api_adult_import, "methods": ["POST"], "summary": "导入旧 NAS 脚本状态：{av, hentai, catalog}"},
        ] + self._hub_api().routes()

    _hub = None

    def _hub_api(self) -> Hub:
        """App（影库）用的 /hub/* 接口，见 hub.py。"""
        if self._hub is None:
            self._hub = Hub(self)
        return self._hub

    def stop_service(self) -> None:
        """还原 SearchChain 包装，停掉快速跟踪和后台补字幕线程。"""
        self._kick_until = 0      # 不然插件重载后旧实例的快速跟踪线程还会用旧代码跑满 15 分钟
        self._adult_kick_until = 0
        try:
            _remove_hooks()
        except Exception:  # noqa: BLE001
            pass
        try:
            if self._pipe:
                self._pipe._subs_pool.shutdown(wait=False, cancel_futures=True)
        except Exception:  # noqa: BLE001
            pass

    def get_module(self) -> Dict[str, Any]:
        """接管资源搜索（插件资源源）和下载（115 离线）。"""
        if not self._enabled:
            return {}
        mods: Dict[str, Any] = {
            "search_torrents": self.search_torrents,
            "async_search_torrents": self.async_search_torrents,
        }
        if self._offline:
            mods["download"] = self.download
        return mods

    # ---------------- 搜索 ----------------
    def search_torrents(self, site: dict = None, keyword: str = None, mtype: MediaType = None,
                        page: Optional[int] = 0, **_: Any) -> List[TorrentInfo]:
        """MP 每次搜索都会调用；site 非空时是内置站点搜索，本插件不参与。"""
        if not self._enabled or site or int(page or 0) > 0 or not (keyword or "").strip():
            return []
        try:
            target = _TARGET.get() if self._multi else None
            kind, kw = self._adult_query(keyword)
            if kind and self._adult and (target is None or not getattr(target, "title", None)):
                return self._search_adult(kind, kw)
            if target is None or not getattr(target, "title", None):
                pol, bl = self._policy(), self._blacklist()
                return [t for t in self._search(keyword.strip(), mtype)
                        if not self._vetoed(t.title or "", self._btih(t.enclosure or ""), pol, bl)]
            rnd = _ROUND.get()
            if rnd is not None:
                if getattr(rnd, "_prowlarr115_done", False):
                    return []
                rnd._prowlarr115_done = True
            return self._search_target(getattr(target, "title", None) or keyword.strip(), mtype, target)
        except Exception as err:  # noqa: BLE001 搜索失败不能影响 MP 其他来源
            logger.warning(f"【Prowlarr115】搜索 {keyword} 失败：{err}")
            return []

    @staticmethod
    def _adult_query(keyword: str) -> Tuple[Optional[str], str]:
        """MP 搜索框：「SSIS-001」「av 关键词」→ AV；「里番 名字」「h 名字」→ 里番；其他照常。"""
        m = re.match(r"^\s*(av|里番|hentai|h)\s*[:：]?\s+(.+)$", keyword or "", re.I)
        if m:
            return ("av" if m.group(1).lower() == "av" else "hentai"), m.group(2).strip()
        return ("av", keyword.strip()) if CODE_ONLY.match(keyword or "") else (None, keyword)

    def _search_adult(self, kind: str, kw: str) -> List[TorrentInfo]:
        """sukebei（直连）：AV 搜真人区，里番搜动画区；结果记下 hash，点下载时分流到 AV/里番 流水线。"""
        from email.utils import parsedate_to_datetime
        out = []
        for r in self._adult.sukebei(kw, CAT_REAL if kind == "av" else CAT_ANIME):
            t = r["title"]
            if len(r["hash"]) != 40 or (AV_REJECT.search(t) if kind == "av" else (rejected(t) or JUNK_RX.search(t))):
                continue
            if len(self._adult_hints) > 2000:
                self._adult_hints.clear()
            self._adult_hints[r["hash"]] = {"kind": kind, "title": t}
            try:
                pub = parsedate_to_datetime(r["pub"]).astimezone().strftime("%Y-%m-%d %H:%M:%S")
            except (TypeError, ValueError):
                pub = ""
            out.append(TorrentInfo(site_name="sukebei", title=t, description="AV" if kind == "av" else "里番",
                                   enclosure=adult_magnet(r["hash"]), page_url=f"https://sukebei.nyaa.si/view?q={r['hash']}",
                                   size=r["size"], seeders=r["seeders"], peers=0, grabs=0, pubdate=pub,
                                   downloadvolumefactor=1.0, uploadvolumefactor=1.0))
        logger.info(f"【Prowlarr115】{'AV' if kind == 'av' else '里番'}搜索 {kw}：{len(out)} 条")
        return out

    def _search_target(self, keyword: str, mtype: Optional[MediaType], target: Any) -> List[TorrentInfo]:
        """已知搜索目标时：用中文名、原名、英文名和拉丁字母别名各搜一次，并给确认是这部作品的结果声明 IMDb 身份。

        MP 只拿中文名调一次插件；Nyaa 等站的发布大多只写英文/罗马音名，既搜不到也会被 MP 判为身份不匹配。
        """
        twin = self._tmdb_twin(target) if getattr(target, "type", None) == MediaType.TV else None
        names = [n for n in [target.title, getattr(target, "original_title", None), getattr(target, "en_title", None)]
                 + list(getattr(target, "names", None) or []) if n]
        if twin is not None:
            # Bangumi / 豆瓣条目：MP 只认 IMDb 身份，补上 TMDb 对应条目的 IMDb 和名字（英文名、罗马音）
            names += [n for n in [twin.title, twin.original_title, twin.en_title] + list(twin.names or []) if n]
        names = list(dict.fromkeys(names + [b for b in (_base_name(n) for n in names) if b]))
        latin = [n for n in names if re.fullmatch(r"[\x20-\x7e]+", n) and len(_norm(n)) >= 4]
        seasons = sorted(int(x) for x in (_SEASONS.get() or {getattr(target, "season", None)}) if x)
        ctx = query_context(keyword, target, seasons)
        queries = render_queries(self._conf.get("query_templates") or DEFAULT_QUERY_TEMPLATES, ctx,
                                 int(self._conf.get("max_queries") or 9))
        anime = getattr(target, "type", None) == MediaType.TV and (
            ANIMATION_GENRE in (getattr(target, "genre_ids", None) or []) or bool(getattr(target, "bangumi_id", None))
            or (twin is not None and ANIMATION_GENRE in (twin.genre_ids or [])))
        if anime and self._conf.get("anime_direct", True):
            # 番剧：直连 Nyaa（按做种数 2 页 + 最新 1 页，名字用 | 合并）+ Mikan，一次覆盖所有季，1–2 秒。
            # 用去掉季标记的作品名搜（季由 MP 按标题过滤）
            jp_latin = [n for n in [getattr(target, "original_title", None), ctx.get("en_title")] + ctx["latin_names"]
                        + [ctx.get("en_head"), ctx.get("short_original")]
                        + ([twin.original_title, twin.en_title] if twin is not None else []) if n]
            jp_latin = list(dict.fromkeys(b for b in (_base_name(n) for n in jp_latin) if b))
            zh = list(dict.fromkeys(b for b in (_base_name(n) for n in [target.title, ctx.get("short_title")] if n) if b))
            batches = [self._search_anime(jp_latin, zh)]
            queries = [f"[直连] {' | '.join(dict.fromkeys(jp_latin + zh))}"]
        else:
            with ThreadPoolExecutor(max_workers=4) as pool:  # Prowlarr 每个查询会扇出到全部索引器，别开太多
                batches = list(pool.map(lambda q: self._search(q, mtype), queries))
        out, seen = [], set()
        # 剧集可以用英文名冒号前的短名（「Mushoku Tensei: Jobless Reincarnation」->「Mushoku Tensei」）；
        # 电影不行：「Evangelion」「Demon Slayer」这种系列名会把同系列的其他电影/TV 合集都认成这一部
        heads = [re.split(r"\s*[:：]\s*", n)[0] for n in latin] if getattr(target, "type", None) == MediaType.TV else []
        keys = {k for k in (_norm(n) for n in names + heads) if len(k) >= 2 and (len(k) >= 4 or not k.isascii())}
        imdb = getattr(target, "imdb_id", None) or (twin.imdb_id if twin is not None else None)
        if imdb and not getattr(target, "imdb_id", None):
            try:
                target.imdb_id = imdb      # MP 用 mediainfo.imdb_id 核对插件声明的身份
            except Exception:  # noqa: BLE001
                pass
        year = str(getattr(target, "year", "") or "")
        if twin is not None and getattr(target, "bangumi_id", None):
            year = ""                      # Bangumi 续作的年份是本季的，标题里的年份常是首季的
        abs_off, abs_len = self._abs_offset(target, twin, seasons)
        # Bangumi 条目是「一季 / 一部分」：本季开播前 3 天以前发布的资源不可能是本季的集。挡掉前几季不带季号的发布
        # （「露露特莉莉 第2部分」把第一部分的 [01-12 合集] 当成 1-12 集，「乱马 2024年版 - 01」当成第三季第 1 集）
        start = str(getattr(target, "release_date", "") or "")[:10] if getattr(target, "bangumi_id", None) else ""
        cut = (datetime.strptime(start, "%Y-%m-%d") - timedelta(days=3)).strftime("%Y-%m-%d") \
            if re.fullmatch(r"\d{4}-\d{2}-\d{2}", start) else ""
        declared = relabeled = early = wrong_year = 0
        merged = _merged_season(target) if getattr(target, "type", None) == MediaType.TV else None
        if len(_MERGED_ENCL) > 5000:
            _MERGED_ENCL.clear()
        pol, vetoed, bl = self._policy(), {}, self._blacklist()
        for t in (x for b in batches for x in b):
            h = (re.search(r"btih:([0-9a-fA-F]{40})", t.enclosure or "") or [None, t.enclosure])[1]
            if h in seen:
                continue
            seen.add(h)
            bad = self._vetoed(t.title or "", h if isinstance(h, str) and len(h) == 40 else "", pol, bl)
            if bad:
                key = bad.split("：")[0]
                vetoed[key] = vetoed.get(key, 0) + 1
                continue
            if cut and str(t.pubdate or "")[:10] and str(t.pubdate)[:10] < cut:
                early += 1
                continue
            if abs_off and len(seasons) == 1:
                se = ep_of(t.title)
                # 绝对集号的判断：超出本季集数，或超出发布时本季最多能播到的集数（开播后每周一集，+2 容首播连播）。
                # 「杀手旅店 第二季」Bangumi 写 15 集，「2nd Season - 14」没超出集数，但开播才一周不可能有第 14 集
                cap = abs_len
                if start and str(t.pubdate or "")[:10] >= start:
                    weeks = (datetime.strptime(str(t.pubdate)[:10], "%Y-%m-%d") - datetime.strptime(start, "%Y-%m-%d")).days // 7
                    cap = min(abs_len, weeks + 2)
                if se and se[0] in (None, seasons[0]) and se[1] > cap and 1 <= se[1] - abs_off <= abs_len:
                    t.title = _relabel_abs(t.title, se[1], se[1] - abs_off, seasons[0])
                    relabeled += 1
            if getattr(target, "type", None) == MediaType.MOVIE and year_conflict(t.title, year, names):
                wrong_year += 1
                continue                   # 另一年的那一部（年度演唱会、重制版），交给 MP 也会被当成这一部下载
            if imdb and self._name_ok(t.title, keys) and self._year_ok(t.title, year, getattr(target, "type", None)):
                t.media_source, t.media_id = "imdb", str(imdb)   # MP 会按 IMDb 身份直接认可
                declared += 1
                if merged is not None:
                    _MERGED_ENCL[t.enclosure] = merged
            out.append(t)
        out, heavy = self._drop_heavy(out, target, pol)
        logger.info(f"【Prowlarr115】{target.title}：{len(queries)} 个关键词 {queries} 共 {len(out)} 条，"
                    f"{declared} 条按 IMDb {imdb} 声明身份" + (f"，{relabeled} 条绝对集号按偏移 {abs_off} 换算" if relabeled else "")
                    + (f"，{early} 条早于本季开播（{start}）丢弃" if early else "")
                    + (f"，{wrong_year} 条年份对不上丢弃" if wrong_year else "")
                    + ("，策略排除 " + "、".join(f"{k} {v}" for k, v in vetoed.items()) if vetoed else "")
                    + (f"，{heavy} 条码率过高（同集有更合适的版本）去掉" if heavy else "")
                    + (f"（TMDb 对应 {twin.tmdb_id}）" if twin is not None else ""))
        return out

    @staticmethod
    def _drop_heavy(items: List[TorrentInfo], target: Any, pol: dict) -> Tuple[List[TorrentInfo], int]:
        """码率扣分落实到 MP：同一集（同样的集数范围）或同一部电影里，有每小时不超过 max_gb_per_hour 的版本时，
        把超过的去掉（MP 规则组只认 4K/H265 这类标签，不看体积）；没有替代就保留，宁可大也不缺。"""
        mins = runtime_minutes(target)
        if not mins:
            return items, 0
        cap = float(pol.get("max_gb_per_hour") or 10)
        from app.domain.metainfo import MetaInfo
        info = []
        for t in items:
            try:
                eps = tuple(MetaInfo(t.title).episode_list or []) if getattr(target, "type", None) == MediaType.TV else ()
            except Exception:  # noqa: BLE001
                eps = ()
            g = gb_per_hour(float(t.size or 0), len(eps) or 1, mins)
            info.append((t, eps, g is not None and g > cap))
        ok_keys = {eps for _, eps, heavy in info if not heavy}
        keep = [t for t, eps, heavy in info if not (heavy and eps in ok_keys)]
        return keep, len(items) - len(keep)

    _twin_cache: Dict[str, tuple] = {}

    def _tmdb_twin(self, target: Any, force: bool = False) -> Any:
        """没有 IMDb 的剧集目标（Bangumi / 豆瓣来源的订阅）：找 TMDb 对应条目（有 tmdb_id 直接用，否则按去掉季标记的名字识别，
        并核对名字），返回 MediaInfo；已有 IMDb（force=False 时）或找不到返回 None。缓存 6 小时。"""
        if getattr(target, "imdb_id", None) and not force:
            return None
        key = f"{getattr(target, 'tmdb_id', None)}|{getattr(target, 'bangumi_id', None)}|{getattr(target, 'douban_id', None)}|{target.title}"
        hit = self._twin_cache.get(key)
        if hit and time.time() - hit[0] < 6 * 3600:
            return hit[1]
        twin = None
        try:
            from app.chain.media import MediaChain
            from app.domain.metainfo import MetaInfo
            from app.schemas.types import MediaSource
            if getattr(target, "tmdb_id", None):
                twin = MediaChain().recognize_media(mtype=MediaType.TV, media_source=MediaSource.TMDB,
                                                    media_id=str(target.tmdb_id))
            else:
                mine = {_norm(_base_name(n)) for n in [target.title, getattr(target, "original_title", None)]
                        + list(getattr(target, "names", None) or []) if n and len(_norm(_base_name(n))) >= 2}
                for n in [target.title, getattr(target, "original_title", None)]:
                    if not n:
                        continue
                    m = MediaChain().recognize_media(meta=MetaInfo(title=_base_name(n), mtype=MediaType.TV), mtype=MediaType.TV)
                    theirs = {_norm(x) for x in [getattr(m, "title", None), getattr(m, "original_title", None)]
                              + list(getattr(m, "names", None) or []) if x} if m else set()
                    if m and m.tmdb_id and mine & theirs:
                        twin = m
                        break
            if twin is not None and not twin.tmdb_id:
                twin = None
        except Exception as err:  # noqa: BLE001
            logger.warning(f"【Prowlarr115】{target.title} 找 TMDb 对应条目失败：{err}")
        self._twin_cache[key] = (time.time(), twin)
        return twin

    def _abs_offset(self, target: Any, twin: Any, seasons: List[int]) -> Tuple[int, int]:
        """(本季开播前已播的总集数, 本季集数)，用于把绝对集号（「青之箱 第二季 [27]」「Black Clover Season 2 - 172」）
        换成本季集号。Bangumi 条目按本季首播日期数 TMDb 里更早播出的正片（TMDb 合并季也适用）；
        TMDb 条目用前几季集数之和。算不出返回 (0, 0)。"""
        if len(seasons) != 1:
            return 0, 0
        sn = seasons[0]
        n_here = len((getattr(target, "seasons", None) or {}).get(sn) or [])
        start = str(getattr(target, "release_date", "") or "")[:10]
        # Bangumi 的「第2部分」也是 S1，所以 Bangumi 条目不限季号
        if getattr(target, "bangumi_id", None) and twin is not None and re.fullmatch(r"\d{4}-\d{2}-\d{2}", start):
            eps = self._tmdb_air(twin.tmdb_id)
            cut = (datetime.strptime(start, "%Y-%m-%d") - timedelta(days=3)).strftime("%Y-%m-%d")
            prev = sum(1 for _s, _e, d in eps if d and d < cut)
            later = sum(1 for _s, _e, d in eps if d and d >= cut)
            return (prev, n_here or later) if prev and (n_here or later) else (0, 0)
        if sn < 2:
            return 0, 0
        eps = getattr(twin if twin is not None else target, "seasons", None) or {}
        if not eps.get(sn):
            return 0, 0
        prev = sum(len(v or []) for k, v in eps.items() if 0 < int(k) < sn)
        return prev, len(eps.get(sn) or [])

    _air_cache: Dict[str, tuple] = {}

    def _tmdb_air(self, tmdbid: Any) -> List[Tuple[int, int, str]]:
        """TMDb 全部正片 (季, 集, 播出日期)，缓存 6 小时。"""
        key = str(tmdbid)
        hit = self._air_cache.get(key)
        if hit and time.time() - hit[0] < 6 * 3600:
            return hit[1]
        out: List[Tuple[int, int, str]] = []
        try:
            from app.chain.tmdb import TmdbChain
            tc = TmdbChain()
            for sn in sorted(int(getattr(x, "season_number", 0) or 0) for x in tc.tmdb_seasons(tmdbid=int(tmdbid)) or []):
                if sn > 0:
                    out += [(sn, int(getattr(e, "episode_number", 0) or 0), str(getattr(e, "air_date", "") or ""))
                            for e in tc.tmdb_episodes(tmdbid=int(tmdbid), season=sn) or []]
        except Exception as err:  # noqa: BLE001
            logger.warning(f"【Prowlarr115】取 TMDb {tmdbid} 分集失败：{err}")
        self._air_cache[key] = (time.time(), out)
        return out

    @staticmethod
    def _name_ok(title: str, keys: set) -> bool:
        """作品名必须出现在标题某一段的开头（按 / | [] () 【】「」 切段，去掉字幕组标签）。
        只做子串匹配会把「Call Me by Your Name」「...Knows Your Name」当成《你的名字》。"""
        for seg in re.split(r"[/|\[\]()（）【】「」『』]+", title or ""):
            n = _norm(seg)
            if n and any(n.startswith(k) and not (k.isascii() and n[len(k):len(k) + 1].isalpha() and
                                                    not re.match(r"(the|movie|bd|web|tv|ova|s\d|season|part|x26|hevc|avc|blu|uhd|remux|dual|multi|jap|chs|cht|gb|big)",
                                                                 n[len(k):]))
                         for k in keys):
                return True
        return False

    @staticmethod
    def _year_ok(title: str, year: str, mtype: Any) -> bool:
        """标题里写了年份时必须对得上（电影 ±1 年）；没写年份的放行（BD 发布常不带年份）。剧集不按年份判断。"""
        if not year or mtype == MediaType.TV:
            return True
        years = re.findall(r"(?<!\d)(19\d\d|20\d\d)(?!\d)", title or "")
        return not years or any(abs(int(y) - int(year)) <= 1 for y in years)

    async def async_search_torrents(self, **kwargs: Any) -> List[TorrentInfo]:
        """异步入口，放到线程里跑同步搜索。"""
        return await asyncio.to_thread(self.search_torrents, **kwargs)

    _cache: Dict[str, tuple] = {}
    CACHE_TTL = 1200

    def _search(self, keyword: str, mtype: Optional[MediaType]) -> List[TorrentInfo]:
        """带缓存的 Prowlarr 查询：同一关键词 20 分钟内复用（订阅定时搜索、批量入库会反复查同一部，Prowlarr 在 2G 内存的 NAS 上）。"""
        import copy
        key = f"{mtype.value if mtype else ''}|{keyword}"
        hit = self._cache.get(key)
        if hit and time.time() - hit[0] < self.CACHE_TTL:
            return copy.deepcopy(hit[1])
        res = self._search_raw(keyword, mtype)
        if len(self._cache) > 300:
            self._cache.clear()
        self._cache[key] = (time.time(), res)
        return copy.deepcopy(res)

    def _search_anime(self, jp_latin: List[str], zh: List[str]) -> List[TorrentInfo]:
        """番剧直连源（sources.py），20 分钟缓存。"""
        import copy
        from .sources import anime_search
        key = "anime|" + "|".join(jp_latin + zh)
        hit = self._cache.get(key)
        if hit and time.time() - hit[0] < self.CACHE_TTL:
            return copy.deepcopy(hit[1])

        def get(url):
            r = RequestUtils(headers={"User-Agent": "Mozilla/5.0"}, timeout=20).get_res(url)
            return r.text if r is not None and r.status_code == 200 else ""
        t0 = time.time()
        out = []
        for r in anime_search(get, jp_latin, zh):
            if JUNK.search(r["title"]) or r["seeders"] < self._min_seeders:
                continue
            pub = r.get("pub") or (datetime.fromtimestamp(r["ts"]).strftime("%Y-%m-%d %H:%M:%S") if r.get("ts") else "")
            out.append(TorrentInfo(site_name=f"直连·{r['site']}", title=_clean_title(r["title"], True), description=r["site"],
                                   enclosure=r["magnet"], page_url=r["magnet"], size=r["size"], seeders=r["seeders"],
                                   peers=r["peers"], grabs=0, pubdate=pub, downloadvolumefactor=1.0,
                                   uploadvolumefactor=1.0, category=MediaType.TV.value))
        logger.info(f"【Prowlarr115】番剧直连 {zh[:1]}：{len(out)} 条，{time.time() - t0:.1f} 秒")
        self._cache[key] = (time.time(), out)
        return copy.deepcopy(out)

    def _search_raw(self, keyword: str, mtype: Optional[MediaType]) -> List[TorrentInfo]:
        """调用 Prowlarr /api/v1/search 并映射成 TorrentInfo。"""
        params: List[Tuple[str, Any]] = [("query", keyword), ("type", "search"), ("limit", self._max_results)]
        params += [("indexerIds", i) for i in self._indexers]
        with _PROWLARR_SEM:   # 全局限流：批量入库多线程 × 每季多关键词，别把 NAS 上的 Prowlarr 压垮
            res = RequestUtils(headers={"X-Api-Key": self._prowlarr_key}, timeout=self._timeout).get_res(
                f"{self._prowlarr_url}/api/v1/search", params=params)
        if res is None or res.status_code != 200:
            logger.warning(f"【Prowlarr115】Prowlarr 返回 {getattr(res, 'status_code', '无响应')}")
            return []
        out, skipped = [], 0
        for r in res.json() or []:
            if r.get("protocol") not in (None, "torrent"):
                continue
            if r.get("indexerId") in self._exclude_indexers:
                continue
            cats = [c.get("id") for c in r.get("categories") or [] if isinstance(c, dict)]
            if any(isinstance(c, int) and c in ADULT_CAT for c in cats):
                continue
            # 影视搜索不要音频（原声碟）、书籍（小说/漫画/有声书）：分类全在 3000 / 7000 段的丢掉
            top = {c // 1000 for c in cats if isinstance(c, int) and c < 100000}
            if top and top <= {3, 7}:
                continue
            if JUNK.search(r.get("title") or ""):
                continue
            seeders = int(r.get("seeders") or 0)
            if seeders < self._min_seeders:
                continue
            info_hash = (r.get("infoHash") or "").strip()
            magnet = r.get("magnetUrl") if str(r.get("magnetUrl") or "").startswith("magnet:") else None
            if re.fullmatch(r"[0-9a-fA-F]{40}", info_hash):
                magnet = _magnet(info_hash, r.get("title", ""))
            if not magnet:
                skipped += 1  # 没有 hash 的结果要经 Prowlarr 代理下载种子，115 离线用不了
                continue
            pub = str(r.get("publishDate") or "")
            try:
                pub = datetime.fromisoformat(pub.replace("Z", "+00:00")).strftime("%Y-%m-%d %H:%M:%S")
            except ValueError:
                pass
            out.append(TorrentInfo(
                site_name=f"Prowlarr·{r.get('indexer') or ''}",
                title=_clean_title(r.get("title"), mtype == MediaType.TV),
                description=r.get("indexer"),
                enclosure=magnet,
                page_url=r.get("infoUrl") or r.get("guid") or r.get("commentUrl"),
                size=float(r.get("size") or 0),
                seeders=seeders,
                peers=int(r.get("leechers") or 0),
                grabs=int(r.get("grabs") or 0),
                pubdate=pub,
                downloadvolumefactor=1.0,
                uploadvolumefactor=1.0,
                category=mtype.value if mtype else None,
            ))
        logger.info(f"【Prowlarr115】{keyword}：Prowlarr 返回 {len(out)} 条可用资源"
                    + (f"，跳过 {skipped} 条无 hash 的" if skipped else ""))
        return out

    # ---------------- 下载 ----------------
    @eventmanager.register(ChainEventType.ResourceDownload)
    def on_resource_download(self, event: Event) -> None:
        """按识别结果把保存路径改到 115 规范目录（名 (年) [tmdbid=N]/Season N）。"""
        if not self._enabled or not self._offline or not event or not event.event_data:
            return
        data: ResourceDownloadEventData = event.event_data
        if data.cancel:
            return
        try:
            ctx = data.context
            hint = self._adult_hints.get(self._btih(getattr(getattr(ctx, "torrent_info", None), "enclosure", "") or ""))
            if hint and self._adult:     # MP 搜索框搜出来的 AV/里番：存到 下载/ 或 里番/，download 钩子再分流
                data.options = dict(data.options or {}, save_path=f"{self._root}/{'下载' if hint['kind'] == 'av' else '里番'}")
                return
            media, meta = ctx.media_info, ctx.meta_info
            if not media or media.type not in (MediaType.MOVIE, MediaType.TV):
                return
            tinfo = getattr(ctx, "torrent_info", None)
            bad = self._vetoed(getattr(tinfo, "title", "") or "", self._btih(getattr(tinfo, "enclosure", "") or ""))
            if bad:
                # 最后一道关：MP 自己的规则选中了策略排除或已拉黑的资源（比如订阅搜索结果缓存里的旧候选），不下载
                data.cancel, data.source, data.reason = True, "Prowlarr115", bad
                logger.info(f"【Prowlarr115】拦截下载 {getattr(tinfo, 'title', '')}：{bad}")
                return
            path, info = self._plan(media, list(getattr(meta, "season_list", None) or []),
                                    getattr(meta, "begin_season", None), getattr(ctx.torrent_info, "enclosure", "") or "")
            data.options = dict(data.options or {}, save_path=path)
            # 按 (目录, hash) 记：同一目录同时进两个种子（批量选了几个合集）时各自的 ep_offset 不会串
            origin = str(data.origin or "")
            m_sid = re.search(r'"id"\s*:\s*(\d+)', origin) if origin.startswith("Subscribe") else None
            if m_sid:
                info["sub_id"] = int(m_sid.group(1))     # 入库失败时据此回滚订阅的「已下载集」
            eps = sorted(int(e) for e in (data.episodes or getattr(meta, "episode_list", None) or []) if str(e).isdigit())
            if eps:
                info["episodes"] = eps
            self._pending_meta[(path, self._btih(getattr(ctx.torrent_info, "enclosure", "") or ""))] = dict(info, _at=time.time())
            logger.info(f"【Prowlarr115】{media.title_year} 保存到 {path}")
        except Exception as err:  # noqa: BLE001 路径计算失败时让 MP 用默认目录（会落到下载钩子里报错）
            logger.error(f"【Prowlarr115】计算保存路径失败：{err}")

    def _plan(self, media: Any, season_list: List[int], begin_season: Optional[int], enclosure: str) -> Tuple[str, dict]:
        """作品 + 种子的季信息 -> (115 保存目录, 入库用的作品信息)。下载事件和 /submit 共用。"""
        if media.type == MediaType.TV and not media.tmdb_id and (getattr(media, "bangumi_id", None) or getattr(media, "douban_id", None)):
            # MP 没认出种子对应的 TMDb（「乱马 1/2」被解析成「2」）时 media 是原始 Bangumi 条目：补上 TMDb id，
            # 否则会存进「乱马1 2 第三季 (2026)」这种没有 tmdbid 的新目录
            tw = self._tmdb_twin(media, force=True)
            if tw is not None:
                media.tmdb_id = tw.tmdb_id
        name, year = media.title or getattr(media, "original_title", "") or "未知", media.year
        tm = self._tmdb_media(media) if (getattr(media, "bangumi_id", None) or getattr(media, "douban_id", None)) else None
        if tm is not None and tm.title:
            # Bangumi / 豆瓣条目名是「青之箱 第二季 (2026)」：目录用 TMDb 的「青之箱 (2024)」，和前几季同一个条目
            name, year = tm.title, tm.year or year
        name = _safe(name)
        folder = f"{name} ({year})" if year else name
        if media.tmdb_id:
            folder += f" [tmdbid={media.tmdb_id}]"
        else:
            # 没有 TMDb 条目：不放进按 TMDb 刮削的库（只有名字的目录 Emby 会按名字乱认），先下到「待识别」，
            # 不生成 strm、发通知，在 App 任务详情里「改为另一部」选定作品后再入库
            path = f"{self._root}/待识别/{folder}"
            logger.warning(f"【Prowlarr115】{name} 没有 TMDb 条目，下到待识别：{path}")
            return path, {"title": name, "year": year, "needs_id": True,
                          "bangumi_id": getattr(media, "bangumi_id", None), "douban_id": getattr(media, "douban_id", None),
                          "type": media.type.value if media.type else "", "season": None}
        # Bangumi 来源（Mikan 订阅助手）的条目没有 TMDb 类型，按动画处理（Bangumi 只收 ACG）
        anime = ANIMATION_GENRE in (media.genre_ids or []) or (media.category or "") in ("日番", "国漫") \
            or bool(getattr(media, "bangumi_id", None))
        lib = "电影" if media.type == MediaType.MOVIE else ("动漫" if anime else "剧集")
        # 库里已有同一 TMDb 条目（目录名可能不带 [tmdbid]）就写进原目录，避免一部剧分两份
        try:
            hit = Emby(self._conf["emby_url"], self._conf["emby_key"], self._conf["emby_lib_root"]).folder_by_tmdb(
                media.tmdb_id, media.type == MediaType.MOVIE, LIBS) if media.tmdb_id and self._conf.get("emby_key") else None
        except Exception:  # noqa: BLE001
            hit = None
        if hit:
            lib, folder = hit
        path = f"{self._root}/{lib}/{folder}"
        ho = dict(self._hash_overrides.get(self._btih(enclosure)) or {})
        ov = self._overrides.get((str(media.tmdb_id), (sorted(set(season_list))[0] if len(set(season_list or [])) == 1
                                                         else begin_season))) or {}
        if ov.get("merge_into"):
            # 续作并进前作当第 N 季（命运石之门 0 -> 命运石之门 S2，mediactl.py merge）：{"merge_into": "动漫/<目录>", "merged_season": 2}
            lib, folder = str(ov["merge_into"]).split("/", 1)
            path = f"{self._root}/{lib}/{folder}"
        if media.type == MediaType.TV and not ho and not ov:
            am = self._season_by_airdate(media, sorted(set(season_list))[0] if season_list else begin_season)
            if am:
                ho.update(merged_season=am[0], **({"ep_offset": am[1]} if am[1] else {}))
        merged = ho.get("merged_season") or ov.get("merged_season") or \
            (_merged_season(media) if media.type == MediaType.TV else None)
        have = {int(k) for k in (getattr(media, "seasons", None) or {})}
        season_no = None
        if media.type == MediaType.TV:
            seasons = sorted(set(season_list or []))
            if merged is not None and (not set(seasons) <= have or ho.get("merged_season") or ov.get("merged_season")):
                seasons = [merged]           # 字幕组的「S3」在 TMDb 合并季里：放进合并季目录，集号由 ep_offset/season_starts 换算
            if len(seasons) <= 1:  # 多季合集放剧集根目录，按文件名里的 SxxEyy 分季
                path += f"/Season {seasons[0] if seasons else (begin_season or 1)}"
            season_no = seasons[0] if len(seasons) == 1 else (begin_season or None)
        info = {
            "title": media.title, "original_title": getattr(media, "original_title", None),
            "short_title": re.split(r"\s*[～~:：\-－—]\s*", media.title or "")[0],
            "year": media.year, "tmdbid": media.tmdb_id, "type": media.type.value, "season": season_no,
            "season_year": (getattr(media, "season_years", None) or {}).get(season_no) if season_no else media.year,
            "ep_count": len((getattr(media, "seasons", None) or {}).get(season_no or 1) or []) or None,
            **self._abs_meta(media, season_no, merged),
            **ov, **(self._overrides.get((str(media.tmdb_id), season_no)) or {}),
            **ho}
        return path, info

    _tmdb_media_cache: Dict[str, tuple] = {}

    def _tmdb_media(self, media: Any) -> Any:
        """media 的 TMDb 条目（按 tmdb_id 识别，缓存 6 小时）；没有 tmdb_id 或失败返回 None。"""
        tid = str(getattr(media, "tmdb_id", "") or "")
        if not tid:
            return None
        key = f"{media.type}|{tid}"
        hit = self._tmdb_media_cache.get(key)
        if hit and time.time() - hit[0] < 6 * 3600:
            return hit[1]
        m = None
        try:
            from app.chain.media import MediaChain
            from app.schemas.types import MediaSource
            m = MediaChain().recognize_media(mtype=media.type, media_source=MediaSource.TMDB, media_id=tid)
        except Exception as err:  # noqa: BLE001
            logger.warning(f"【Prowlarr115】取 TMDb {tid} 失败：{err}")
        self._tmdb_media_cache[key] = (time.time(), m)
        return m

    def _abs_meta(self, media: Any, season_no: Optional[int], merged: Optional[int]) -> dict:
        """第 2 季及以后：记下前面各季总集数（abs_offset）和本季集数，入库时把文件名里的绝对集号换回本季集号
        （今晚月色真美「青之箱 第二季 [27]」= S2E02）。Bangumi 来源的 media 可能没带 TMDb 分季，按 tmdb_id 再取一次。"""
        if media.type != MediaType.TV or not season_no or season_no < 2 or merged is not None:
            return {}
        eps = getattr(media, "seasons", None) or {}
        if not eps.get(season_no) and media.tmdb_id:
            eps = getattr(self._tmdb_media(media), "seasons", None) or {}
        if not eps.get(season_no):
            return {}
        prev = sum(len(v or []) for k, v in eps.items() if 0 < int(k) < season_no)
        return {"abs_offset": prev, "ep_count": len(eps[season_no])} if prev else {}

    _tvdb_cache: Dict[str, tuple] = {}
    _tvdb_client = None

    def _tvdb_map(self, tmdbid: Any) -> Dict[tuple, tuple]:
        """TMDb (季,集) -> TheTVDB (季,集)，缓存 6 小时。动漫库按 TVDB 分季（见 tvdbmap.py）。"""
        key = str(tmdbid)
        hit = self._tvdb_cache.get(key)
        if hit and time.time() - hit[0] < 6 * 3600:
            return hit[1]
        from app.chain.media import MediaChain
        from app.chain.tmdb import TmdbChain
        from app.schemas.types import MediaSource
        from .tvdbmap import TvdbClient, build
        if not self._tvdb_client:
            def get(u, h, p):
                r = RequestUtils(headers=h, timeout=30).get_res(u, params=p)
                return r.json() if r is not None and r.status_code == 200 else {}

            def post(u, b):
                r = RequestUtils(content_type="application/json", timeout=30).post_res(u, json=b)
                return r.json() if r is not None else {}
            self._tvdb_client = TvdbClient(get, post)
        res: Dict[tuple, tuple] = {}
        media = MediaChain().recognize_media(mtype=MediaType.TV, media_source=MediaSource.TMDB, media_id=key)
        tvdb_id = getattr(media, "tvdb_id", None) if media else None
        if tvdb_id:
            tc, tm = TmdbChain(), []
            for sn in sorted(int(k) for k in (media.seasons or {}) if int(k) > 0):
                for e in tc.tmdb_episodes(tmdbid=int(key), season=sn) or []:
                    tm.append((sn, int(e.episode_number), str(getattr(e, "air_date", "") or "")))
            res = build(tm, self._tvdb_client.episodes(int(tvdb_id)))
        self._tvdb_cache[key] = (time.time(), res)
        if res:
            logger.info(f"【Prowlarr115】{getattr(media, 'title', key)}：TMDb 与 TVDB 分季不同，入库按 TVDB 编号（{len(res)} 集）")
        return res

    _airmap_cache: Dict[tuple, tuple] = {}

    def _season_by_airdate(self, media: Any, season_no: Optional[int]) -> Optional[Tuple[int, int]]:
        """Bangumi 来源的订阅（Mikan 订阅助手）常把「篇章」当成新的 S1：「死神 千年血战篇-祸进谭」(2026) 在 TMDb 里是
        BLEACH S2 第 41-50 集。TMDb 本季首播年份和番剧年份差 >1 年时，按 TMDb 分集播出日期找出真正的 (季, 集号偏移)。
        对不上返回 None（不改）。"""
        if not getattr(media, "bangumi_id", None) or not media.tmdb_id or not media.year:
            return None
        start = str(getattr(media, "release_date", "") or "")[:10]
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", start):
            # 有本季首播日期时按日期定位：TMDb 里第一个在开播前 3 天之后播出的正片就是本季第 1 集。
            # 按年份判断对跨年的季会错（弹珠汽水 第一部分 2025-10 ~ 2026-01，第二部分被算成偏移 10）
            cut = (datetime.strptime(start, "%Y-%m-%d") - timedelta(days=3)).strftime("%Y-%m-%d")
            after = sorted((sn, e, d) for sn, e, d in self._tmdb_air(media.tmdb_id) if d and d >= cut)
            if after:
                sn, e0 = min(after, key=lambda x: (x[2], x[0], x[1]))[:2]
                if sn == (season_no or 1) and e0 == 1:
                    return None
                logger.info(f"【Prowlarr115】{media.title}（{start} 开播）在 TMDb {media.tmdb_id} 里是第 {sn} 季、集号偏移 {e0 - 1}")
                return sn, e0 - 1
        year = int(str(media.year)[:4])
        sy = (getattr(media, "season_years", None) or {}).get(season_no or 1)
        if sy and abs(int(str(sy)[:4]) - year) <= 1:
            return None
        key = (str(media.tmdb_id), year)
        hit = self._airmap_cache.get(key)
        if hit and time.time() - hit[0] < 3600:
            return hit[1]
        res = None
        try:
            from app.chain.tmdb import TmdbChain
            tc = TmdbChain()
            seasons = sorted(int(getattr(x, "season_number", 0) or 0) for x in tc.tmdb_seasons(tmdbid=media.tmdb_id) or [])
            for sn in reversed([x for x in seasons if x > 0]):
                eps = [(int(getattr(e, "episode_number", 0) or 0), str(getattr(e, "air_date", "") or ""))
                       for e in tc.tmdb_episodes(tmdbid=media.tmdb_id, season=sn) or []]
                first = [n for n, d in sorted(eps) if d[:4] == str(year)]
                if first:
                    res = (sn, first[0] - 1)
                    break
            if res is None and seasons:
                res = (max(seasons) + 1, 0)       # TMDb 还没收录这一篇：先放到下一季，别混进老的 S1
        except Exception as err:  # noqa: BLE001
            logger.warning(f"【Prowlarr115】按播出日期找季失败 {media.title}: {err}")
        self._airmap_cache[key] = (time.time(), res)
        if res:
            logger.info(f"【Prowlarr115】{media.title} ({year}) 在 TMDb {media.tmdb_id} 里是第 {res[0]} 季、集号偏移 {res[1]}")
        return res

    def download(self, content: Any, download_dir: Path, cookie: str = None, episodes: Any = None,
                 category: Optional[str] = None, label: Optional[str] = None, downloader: Optional[str] = None,
                 **_: Any) -> Optional[Tuple[Optional[str], Optional[str], Optional[str], str]]:
        """保存目录在 115 根下时，把磁力交给 NAS 提交 115 离线；否则返回 None 交给其他下载器。"""
        target = str(download_dir or "")
        if not self._offline or not (target == self._root or target.startswith(self._root + "/")):
            return None
        if isinstance(content, Path):
            content = content.read_bytes() if content.exists() else None
        if isinstance(content, bytes):
            content = content.decode() if content.startswith(b"magnet:") else _torrent_to_magnet(content)
        if not isinstance(content, str) or not content.startswith("magnet:"):
            return DOWNLOADER_NAME, None, None, "无法取得磁力链接"
        if not self._pipe:
            return DOWNLOADER_NAME, None, None, "Prowlarr115 流水线未就绪（检查插件配置里的 OpenList/115/Emby）"
        if self._adult and target in (f"{self._root}/下载", f"{self._root}/里番"):
            h = self._btih(content)
            if target.endswith("/下载"):
                hint = self._adult_hints.get(h) or {}
                code = av_code(hint.get("title") or "")
                ok, err = self._adult.submit("av", target, content, hint.get("title") or "", title=code or "AV", code=code)
            else:
                r = self._adult.hentai_submit(content, (self._adult_hints.get(h) or {}).get("title") or "")
                ok, err = r["ok"], r.get("error", "")
            self._adult_kick()
            return DOWNLOADER_NAME, (h if ok else None), ("Original" if ok else None), ("" if ok else f"115 离线失败：{err}")
        ok, h, err = self._pipe.submit(content, target, meta=self._take_meta(target, self._btih(content)))
        if not ok:
            logger.error(f"【Prowlarr115】提交 115 离线失败：{target}：{err}")
            return DOWNLOADER_NAME, None, None, f"115 离线失败：{err}"
        self._kick()
        return DOWNLOADER_NAME, h, "Original", ""

    _kick_until = 0.0

    def _kick(self, minutes: int = 15) -> None:
        """新提交的任务：之后 minutes 分钟内每 15 秒推进一次（115 秒传的几秒就完成，不用等 5 分钟一轮）。"""
        busy = self._kick_until > time.time()
        self._kick_until = time.time() + minutes * 60
        if busy:
            return

        def loop():
            while time.time() < self._kick_until:
                time.sleep(15)
                try:
                    self.track()
                except Exception as err:  # noqa: BLE001
                    logger.warning(f"【Prowlarr115】快速跟踪出错：{err}")
        threading.Thread(target=loop, name="prowlarr115-kick", daemon=True).start()

    # ---------------- API ----------------
    def api_test(self) -> Dict[str, Any]:
        """测试各外部服务是否可达。"""
        out: Dict[str, Any] = {}
        r = RequestUtils(headers={"X-Api-Key": self._prowlarr_key}, timeout=15).get_res(f"{self._prowlarr_url}/api/v1/indexer")
        out["prowlarr"] = (f"OK，{len([i for i in r.json() if i.get('enable')])} 个索引器启用"
                           if r is not None and r.status_code == 200 else f"失败 {getattr(r, 'status_code', '无响应')}")
        p = self._pipe
        if not p:
            out["pipeline"] = "未就绪"
            return out
        for name, fn in (("openlist", lambda: len(p.ol.list(p.root, refresh=False))),
                         ("115", lambda: len(p.c115.tasks(1))),
                         ("qbittorrent", lambda: (f"{len(p.qb.get('/api/v2/torrents/info', {'limit': 1000}) or [])} 个任务" if p.qb else "未配置")),
                         ("emby", lambda: (p.emby.get("/System/Info") or {}).get("Version"))):
            try:
                out[name] = f"OK {fn()}"
            except Exception as err:  # noqa: BLE001
                out[name] = f"失败 {err}"
        return out

    def api_tasks(self, limit: int = 50) -> List[dict]:
        """最近的下载任务。"""
        items = sorted(self._load_tasks().items(), key=lambda kv: -kv[1].get("added", 0))[:int(limit)]
        return [dict(t, hash=h, url=None) for h, t in items]

    def api_run(self) -> Dict[str, Any]:
        """立即推进一次（后台执行，立即返回）。"""
        threading.Thread(target=self.track, name="prowlarr115-run", daemon=True).start()
        if self._adult:   # AV（115 → strm → MDC → 整理）也一起推进，不用等 5 分钟一轮
            threading.Thread(target=self.adult_track, kwargs={"quick": True}, name="prowlarr115-adult-run", daemon=True).start()
        return {"ok": True, "started": True}

    def api_retry(self, hash: str, mode: str = "strm") -> Dict[str, Any]:  # noqa: A002 API 参数名
        """重试：strm=重新生成入库；buffer=改用 NAS 缓冲；offline=删掉 115 上的旧任务、重新提交 115 离线。"""
        p = self._pipe
        h = (hash or "").lower()
        if not p or h not in self._load_tasks():
            return {"ok": False, "error": "任务不存在或流水线未就绪"}
        t = dict(self._load_tasks()[h])
        note = "已在后台推进"
        if mode == "buffer":
            p.buffer_start(h, t, "手动改用 NAS 缓冲")
        elif mode == "offline":
            url = with_trackers(t.get("url") or f"magnet:?xt=urn:btih:{h}")
            try:
                p.c115.task_del(h)
            except Exception:  # noqa: BLE001 旧任务可能已经不在了
                pass
            try:
                cid = p.c115.mkdir_p(t["dir"][len("/115"):] if t["dir"].startswith("/115/") else t["dir"])
                ok, err = p.c115.offline_add(url, cid)
            except Exception as e:  # noqa: BLE001
                ok, err = False, str(e)
            if not ok:
                return {"ok": False, "error": f"115 离线提交失败：{err}"}
            if p.qb and t.get("buffer"):
                p.qb.post("/api/v2/torrents/delete", {"hashes": h, "deleteFiles": "true"})
            t.pop("buffer", None)
            t.update(status="downloading", added=int(datetime.now().timestamp()), percent=0)
            note = "已重新提交 115 离线"
        else:
            t["status"] = "uploaded"
            for k in ("emby", "done", "identity_warn"):
                t.pop(k, None)
        t.pop("strm_errors", None)
        p.mutate(h, lambda cur: (cur.clear(), cur.update(t)))   # 整个替换：pop 掉的键（emby/done）也要删
        p.event(h, "manual", f"手动重试（{ {'strm': '重新生成 strm', 'buffer': '改用 NAS 缓冲', 'offline': '重新提交 115 离线'}.get(mode, mode) }）")
        threading.Thread(target=self.track, name="prowlarr115-retry", daemon=True).start()
        return {"ok": True, "status": t.get("status"), "note": note}

    def api_retarget(self, payload: dict = Body(...)) -> Dict[str, Any]:
        """任务认错作品时改到另一部（「音律联觉2024」被下进 2026 那一部的目录）：{hash, tmdbid, type, season, dry_run}。
        把这个任务下到 115 的文件夹/文件移到新作品目录，删掉指向它的旧 strm（旧目录空了一并删），
        改任务的目录和作品信息，再重新生成 strm、通知 Emby。"""
        p = self._pipe
        if not p:
            return {"ok": False, "error": "流水线未就绪"}
        tasks = self._load_tasks()
        h = str(payload.get("hash") or "").lower()
        t = tasks.get(h)
        if not t:
            return {"ok": False, "error": "任务不存在"}
        media = batch_mod._recognize({"tmdbid": payload.get("tmdbid"), "type": payload.get("type", "tv")})
        if not media:
            return {"ok": False, "error": "识别失败"}
        season = payload.get("season")
        new, info = self._plan(media, [int(season)] if season not in (None, "") else [], None, t.get("url") or "")
        if payload.get("dir"):
            new = p.check_dir(str(payload["dir"]))     # 指定目标目录（合并到某个已有目录时用，不靠 Emby 现有目录推断）
        old, nm = t.get("dir") or "", t.get("name") or ""
        if new == old:
            return {"ok": False, "error": "已经在这个作品的目录里"}
        if payload.get("dry_run"):
            return {"ok": True, "dry_run": True, "from": old, "dir": new, "name": nm}
        if not nm:
            return {"ok": False, "error": "不知道这个任务在 115 上的文件名，先等它下载完"}
        p.ol.refresh_path(old)
        if not p.ol.get(f"{old}/{nm}"):
            alt = re.sub(r'[\\/:*?"<>|]', "_", nm)       # 115 保存时把文件名里的 : ? 等换成了 _
            if alt != nm and p.ol.get(f"{old}/{alt}"):
                nm = alt
            else:
                return {"ok": False, "error": f"115 上找不到 {old}/{nm}"}
        p.check_dir(new)
        p.c115.mkdir_p(new[len("/115"):] if new.startswith("/115/") else new)
        p.ol.refresh_path(new)
        p.ol.move(old, new, [nm])
        # 旧 strm：只删指向这个任务文件的（同目录别的任务的 strm 不动）
        removed = []
        for rel in t.get("strm") or []:
            stub = rel if rel.startswith("/") else f"{p.lib_ol}/{rel}"
            try:
                if (p.ol.remote_of_strm(stub) or "").startswith(f"{old}/{nm}"):
                    folder, base = stub.rsplit("/", 1)
                    stem = base[:-5]
                    p.ol.remove(folder, [i["name"] for i in p.ol.list(folder, refresh=True) if i["name"].startswith(stem + ".")])
                    removed.append(stub)
            except Exception as err:  # noqa: BLE001
                self._log(f"改作品：删旧 strm {stub[-60:]} 失败：{err}")
        # 旧目录没有别的东西、也没有别的任务时删掉（115 目录和媒体库目录）
        others = [x for k, x in tasks.items() if k != h and x.get("dir") == old and x.get("status") != "cancelled"]
        if not others:
            try:
                if not p.ol.list(old, refresh=True):
                    parent, leaf = old.rsplit("/", 1)
                    p.ol.remove(parent, [leaf])
                lib_folder = f"{p.lib_ol}/{old[len(p.root) + 1:]}"
                if not [i for i in p.ol.list(lib_folder, refresh=True) if i["name"].lower().endswith(".strm")]:
                    parent, leaf = lib_folder.rsplit("/", 1)
                    p.ol.remove(parent, [leaf])
            except Exception as err:  # noqa: BLE001
                self._log(f"改作品：清理旧目录失败：{err}")
        def upd(cur: dict) -> None:
            cur.update(dir=new, meta=info, status="uploaded", strm=[])
            for k in ("emby", "done", "identity_warn"):     # done 不清的话 Emby 确认会按旧时间立刻判「3 小时没刮削」
                cur.pop(k, None)
            cur.setdefault("history", []).append({"at": int(time.time()), "event": "retarget", "from": old, "to": new})
        p.mutate(h, upd)
        self._log(f"改作品 {h[:8]}：{old} -> {new}，删旧 strm {len(removed)} 个")
        p.event(h, "manual", f"改为另一部作品：{old} → {new}，删旧 strm {len(removed)} 个", "warn")
        threading.Thread(target=self.track, name="prowlarr115-retarget", daemon=True).start()
        return {"ok": True, "from": old, "dir": new, "removed": removed}

    def api_rename_folder(self, payload: dict = Body(...)) -> Dict[str, Any]:
        """把一个作品目录改成标准名「名称 (年份) [tmdbid=N]」（Emby 官方命名，身份不再靠名字猜）：
        {"lib": "动漫", "old": "轉生就是劍", "tmdbid": 134667, "type": "tv", "dry_run": true}
        115 目录和媒体库目录一起改名（目标已存在就合并进去），媒体库里指向旧 115 目录的 strm 改写成新路径，
        NFO/图片/字幕随目录走，插件任务的目录一并更新。"""
        p = self._pipe
        if not p:
            return {"ok": False, "error": "流水线未就绪"}
        lib, old = str(payload.get("lib") or ""), str(payload.get("old") or "")
        if lib not in LIBS or not old or "/" in old:
            return {"ok": False, "error": "lib/old 不对"}
        media = batch_mod._recognize({"tmdbid": payload.get("tmdbid"), "type": payload.get("type", "tv")})
        if not media or not media.tmdb_id:
            return {"ok": False, "error": "识别失败"}
        new = f"{_safe(media.title)} ({media.year}) [tmdbid={media.tmdb_id}]" if media.year else f"{_safe(media.title)} [tmdbid={media.tmdb_id}]"
        if new == old:
            return {"ok": True, "same": True, "new": new}
        src115, dst115 = f"{p.root}/{lib}/{old}", f"{p.root}/{lib}/{new}"
        srclib, dstlib = f"{p.lib_ol}/{lib}/{old}", f"{p.lib_ol}/{lib}/{new}"
        p.ol.refresh_path(src115)
        has115, haslib = bool(p.ol.get(src115)), bool(p.ol.get(srclib))
        tasks = self._load_tasks()
        hs = [h for h, t in tasks.items() if (t.get("dir") or "") == src115 or (t.get("dir") or "").startswith(src115 + "/")]
        plan = {"ok": True, "lib": lib, "old": old, "new": new, "has115": has115, "haslib": haslib, "tasks": len(hs),
                "merge115": bool(p.ol.get(dst115)), "mergelib": bool(p.ol.get(dstlib))}
        if payload.get("dry_run"):
            return plan

        def merge(src: str, dst: str) -> None:
            """src 目录并进 dst：dst 不存在直接改名；存在就逐项移动，同名子目录递归合并。"""
            parent, leaf = src.rsplit("/", 1)
            if not p.ol.get(dst):
                p.ol.rename(src, dst.rsplit("/", 1)[1]) if dst.rsplit("/", 1)[0] == parent else p.ol.move(parent, dst.rsplit("/", 1)[0], [leaf])
                return
            have = {i["name"]: i for i in p.ol.list(dst, refresh=True)}
            dup_meta = []
            for it in p.ol.list(src, refresh=True):
                if it["is_dir"] and it["name"] in have:
                    merge(f"{src}/{it['name']}", f"{dst}/{it['name']}")
                elif it["name"] not in have:
                    p.ol.move(src, dst, [it["name"]])
                elif re.search(r"\.(nfo|jpg|jpeg|png|webp)$", it["name"], re.I):
                    dup_meta.append(it["name"])             # Emby 生成的 NFO/图片，目标里已有一份：旧的删掉
            if dup_meta:
                p.ol.remove(src, dup_meta)
            if not p.ol.list(src, refresh=True):
                p.ol.remove(parent, [leaf])

        moved = []
        if has115:
            merge(src115, dst115)
            moved.append("115")
        if haslib:
            merge(srclib, dstlib)
            moved.append("lib")
        # strm 里是 OpenList 签名直链（含路径）：指向旧 115 目录的改写成新路径
        rewritten = 0
        for full, _it in list(p.ol.walk(dstlib)) if (has115 or haslib) and p.ol.get(dstlib) else []:
            if not full.lower().endswith(".strm"):
                continue
            remote = p.ol.remote_of_strm(full) or ""
            if remote == src115 or remote.startswith(src115 + "/"):
                p._write_strm(full, dst115 + remote[len(src115):])
                rewritten += 1

        def upd(cur: dict) -> None:
            cur["dir"] = dst115 + cur["dir"][len(src115):]
            cur["strm"] = [x.replace(f"{lib}/{old}/", f"{lib}/{new}/", 1) for x in cur.get("strm") or []]
            cur.setdefault("history", []).append({"at": int(time.time()), "event": "rename", "from": old, "to": new})
        for h in hs:
            p.mutate(h, upd)
            p.event(h, "manual", f"目录改成标准名：{old} → {new}")
        try:
            # 只通知改动的两个路径（不要整库刷新：38 个目录各刷一次整库，把 NAS 根分区上的 Emby 缓存撑满过，2026-10-27）
            p.emby.updated([p.emby_path(srclib), p.emby_path(dstlib)])
        except Exception:  # noqa: BLE001
            pass
        self._log(f"目录改名 {lib}/{old} -> {new}：{'+'.join(moved)}，改写 strm {rewritten} 个，任务 {len(hs)} 个")
        return dict(plan, done=True, moved=moved, rewritten=rewritten)

    def api_tmdb_renumber(self, payload: dict = Body(...)) -> Dict[str, Any]:
        """动漫库从 TheTVDB 编号改回 TMDb 编号（2026-10-27 用户选定，MP/订阅/集数统计都按 TMDb）：
        {"dry_run": true, "tmdbid": 可选只处理一部}。对每部有 TVDB 映射的动漫，把按 TVDB 命名的 strm
        改成 TMDb 的「Season N/名称 SxxEyy.strm」，外挂字幕跟着改名，旧的分集 NFO/缩略图删掉让 Emby 按 TMDb 重刮。
        目标已有别的文件时跳过并列出（不覆盖）。"""
        p = self._pipe
        if not p:
            return {"ok": False, "error": "流水线未就绪"}
        dry = bool(payload.get("dry_run", True))
        only = str(payload.get("tmdbid") or "")
        lib_root = f"{p.lib_ol}/动漫"
        series = (p.emby.get("/Items", Recursive="true", IncludeItemTypes="Series", Fields="Path,ProviderIds") or {}).get("Items") or []
        want = p.emby_path(lib_root)
        out, total = [], 0
        for it in series:
            path = it.get("Path") or ""
            tid = str((it.get("ProviderIds") or {}).get("Tmdb") or "")
            if not path.startswith(want + "/") or not tid or (only and tid != only):
                continue
            folder = path[len(want) + 1:].split("/", 1)[0]
            try:
                m = self._tvdb_map(tid) or {}
            except Exception as err:  # noqa: BLE001
                out.append({"folder": folder, "error": f"取映射失败：{err}"})
                continue
            inv = {v: k for k, v in m.items() if v != k}
            if not inv:
                continue
            base = f"{lib_root}/{folder}"
            show = re.sub(r"\s*\[tmdbid=\d+\]$", "", folder).rsplit(" (", 1)[0]
            files = [(f, i) for f, i in p.ol.walk(base)]
            names = {f for f, _ in files}
            moves, conflicts = [], []
            for f, _i in files:
                mm = re.search(r"S(\d+)E(\d+)\.strm$", f)
                if not mm:
                    continue
                key = (int(mm.group(1)), int(mm.group(2)))
                if key not in inv:
                    continue
                ts, te = inv[key]
                stem = f[:-5]
                dst_dir = f"{base}/Season {ts}"
                dst_stem = f"{dst_dir}/{show} S{ts:02d}E{te:02d}"
                moves.append((stem, dst_stem, key, (ts, te)))
            srcs = {mv[0] + ".strm" for mv in moves}
            ok_moves = []
            for mv in moves:
                if mv[1] + ".strm" in names and mv[1] + ".strm" not in srcs:
                    conflicts.append(f"{mv[2]}→{mv[3]}：目标已有 {mv[1].rsplit('/', 1)[1]}")
                else:
                    ok_moves.append(mv)
            rec = {"folder": folder, "tmdbid": tid, "renames": len(ok_moves), "conflicts": conflicts,
                   "sample": [f"S{a[0]:02d}E{a[1]:02d}→S{b[0]:02d}E{b[1]:02d}" for _, _, a, b in ok_moves[:6]]}
            out.append(rec)
            total += len(ok_moves)
            if dry or not ok_moves:
                continue
            # 两步走：先全部挪进临时目录（避免 S02E01→S01E25、S01E25→… 链式覆盖），再放到目标位置
            tmp = f"{base}/.renumber"
            p.ol.mkdir(tmp)
            sides = {}
            for stem, dst_stem, _a, _b in ok_moves:
                d, leaf = stem.rsplit("/", 1)
                mine = [f for f in names if f.rsplit("/", 1)[0] == d
                        and (f.rsplit("/", 1)[1].startswith(leaf + ".") or f.rsplit("/", 1)[1].startswith(leaf + "-thumb."))]
                keep = [f for f in mine if not re.search(r"\.(nfo)$|-thumb\.\w+$", f)]
                drop = [f.rsplit("/", 1)[1] for f in mine if f not in keep]
                if drop:
                    p.ol.remove(d, drop)
                p.ol.move(d, tmp, [f.rsplit("/", 1)[1] for f in keep])
                sides[stem] = [f.rsplit("/", 1)[1] for f in keep]
            made_dirs = set()
            for stem, dst_stem, _a, _b in ok_moves:
                leaf = stem.rsplit("/", 1)[1]
                dst_dir, dst_leaf = dst_stem.rsplit("/", 1)
                if dst_dir not in made_dirs:
                    p.ol.mkdir(dst_dir)
                    made_dirs.add(dst_dir)
                for n in sides.get(stem, []):
                    new_n = dst_leaf + n[len(leaf):]
                    p.ol.move(tmp, dst_dir, [n])
                    if new_n != n:
                        p.ol.rename(f"{dst_dir}/{n}", new_n)
            p.ol.remove(base, [".renumber"])
            # 只剩 season.nfo / 季海报的空季目录删掉
            for it2 in p.ol.list(base, refresh=True):
                if it2["is_dir"] and it2["name"].startswith("Season "):
                    rest = [x["name"] for x in p.ol.list(f"{base}/{it2['name']}", refresh=True)]
                    if all(re.search(r"\.(nfo|jpg|png)$", x, re.I) for x in rest):
                        p.ol.remove(base, [it2["name"]])
            try:
                p.emby.updated([p.emby_path(base)])
            except Exception:  # noqa: BLE001
                pass
            self._log(f"动漫改 TMDb 编号：{folder} 改名 {len(ok_moves)} 集，冲突 {len(conflicts)}")
        return {"ok": True, "dry_run": dry, "series": len(out), "renames": total, "items": out}

    def _policy(self) -> Dict[str, Any]:
        return load_policy(self._conf.get("policy"))

    def api_cancel(self, payload: dict = Body(...)) -> Dict[str, Any]:
        """取消下载任务：从 115 离线列表删除、删掉它下到 115 目录里的文件/文件夹、状态置为 cancelled（不会再入库）。
        按 hashes，或按 115 任务名正则 match（可加 dir 限定目录）。已生成的 strm 不动（用 retry 修）。"""
        p = self._pipe
        if not p:
            return {"ok": False, "error": "流水线未就绪"}
        tasks = self._load_tasks()
        names = p.c115.tasks(5)
        hs = set(h.lower() for h in payload.get("hashes") or [])
        if payload.get("match"):
            rx = re.compile(payload["match"], re.I)
            for h, t in tasks.items():
                nm = t.get("name") or (names.get(h) or {}).get("name") or ""
                if rx.search(nm) and payload.get("dir", "") in t.get("dir", ""):
                    hs.add(h)
        done = []
        for h in hs:
            t = tasks.get(h)
            if not t:
                continue
            nm = t.get("name") or (names.get(h) or {}).get("name") or ""
            try:
                p.c115.task_del(h)
            except Exception:  # noqa: BLE001
                pass
            if p.qb and t.get("buffer"):
                p.qb.post("/api/v2/torrents/delete", {"hashes": h, "deleteFiles": "true"})   # NAS 缓冲里的连本地文件一起删
            if nm:
                try:
                    p.ol.refresh_path(t["dir"])
                    if p.ol.get(f"{t['dir']}/{nm}"):
                        p.ol.remove(t["dir"], [nm])
                except Exception as err:  # noqa: BLE001
                    self._log(f"删除 {nm} 失败：{err}")
            p.mutate(h, lambda cur: cur.update(status="cancelled"))
            p.event(h, "manual", "已取消：删除 115 离线任务和已下载的文件", "warn")
            done.append(nm or h)
        return {"ok": True, "cancelled": len(done), "names": done}

    def api_retry_status(self, status: str = "no-video") -> Dict[str, Any]:
        """把某个状态的任务全部改回「待入库」，后台重新生成 strm。"""
        hs = [h for h, t in self._load_tasks().items() if t.get("status") == status]
        for h in hs:
            self._pipe.mutate(h, lambda cur: (cur.update(status="uploaded"), cur.pop("emby", None), cur.pop("strm_errors", None)))
        threading.Thread(target=self.track, name="prowlarr115-retry", daemon=True).start()
        return {"ok": True, "count": len(hs)}

    def api_batch(self, payload: dict = Body(...)) -> Dict[str, Any]:
        """批量入库：{"items":[{"tmdbid"|"title","year","type","seasons"}],"mode","replace","dry_run"}"""
        if not self._pipe:
            return {"ok": False, "error": "流水线未就绪"}
        return batch_mod.start(self, payload or {})

    def api_batch_status(self, job: str = "") -> Any:
        """批量作业进度。"""
        return batch_mod.status(job or None)

    def api_policy_get(self) -> Dict[str, Any]:
        """当前生效的选片策略（与默认值合并后）和关键词模板。"""
        return {"policy": self._policy(), "query_templates": self._conf.get("query_templates") or DEFAULT_QUERY_TEMPLATES,
                "max_queries": int(self._conf.get("max_queries") or 9)}

    def api_policy_set(self, payload: dict = Body(...)) -> Dict[str, Any]:
        """合并更新：{"policy": {...部分字段...}, "query_templates": "...", "max_queries": 9}"""
        conf = dict(self.get_config() or {})
        if "policy" in payload:
            cur = load_policy(conf.get("policy"))
            for k, v in (payload["policy"] or {}).items():
                if isinstance(v, dict) and isinstance(cur.get(k), dict):
                    cur[k].update(v)
                else:
                    cur[k] = v
            conf["policy"] = json.dumps(cur, ensure_ascii=False, indent=1)
        for k in ("query_templates", "max_queries"):
            if k in payload:
                conf[k] = payload[k]
        self.update_config(conf)
        self.init_plugin(conf)
        return self.api_policy_get()

    def api_override(self, payload: dict = Body(...)) -> Dict[str, Any]:
        """给某作品某季之后的下载附加入库参数（持久化）。例：Mikan 把「死神 千年血战篇-祸进谭」当独立 S1，
        TMDb 里是 BLEACH S2 第 41-50 集：{"tmdbid":30984,"season":1,"merged_season":2,"ep_offset":40}。只传 tmdbid+season = 删除。"""
        key = (str(payload["tmdbid"]), int(payload["season"]) if payload.get("season") else None)
        extra = {k: v for k, v in payload.items() if k not in ("tmdbid", "season")}
        if extra:
            self._overrides[key] = extra
        else:
            self._overrides.pop(key, None)
        self.save_data("overrides", {f"{k[0]}|{k[1]}": v for k, v in self._overrides.items()})
        return {"ok": True, "overrides": {f"{k[0]}/S{k[1]}": v for k, v in self._overrides.items()}}

    def api_submit(self, payload: dict = Body(...)) -> Dict[str, Any]:
        """指定资源入库（候选不在 MP 搜索结果里、或要人工挑时）：
        {"magnet": "magnet:?xt=urn:btih:..."（或 "hash"）, "tmdbid": 85937, "type": "tv", "season": 2,
         "title": "种子名（可选）", "meta": {"ep_offset": 0, ...}（可选）, "dry_run": false}
        按与 MP 下载相同的规则算 115 目录，提交离线，后续跟踪、入库、通知都一样。"""
        if not self._pipe:
            return {"ok": False, "error": "流水线未就绪"}
        magnet = payload.get("magnet") or (f"magnet:?xt=urn:btih:{payload['hash']}" if payload.get("hash") else "")
        if not self._btih(magnet):
            return {"ok": False, "error": "需要 magnet 或 40 位 hash"}
        media = batch_mod._recognize({"tmdbid": payload.get("tmdbid"), "title": payload.get("name"),
                                      "year": payload.get("year"), "type": payload.get("type", "tv")})
        if not media:
            return {"ok": False, "error": "识别失败"}
        season = payload.get("season")
        path, info = self._plan(media, [int(season)] if season is not None else [], None, magnet)
        info.update(payload.get("meta") or {})
        warnings = []
        if media.type == MediaType.MOVIE:
            names = [media.title, getattr(media, "original_title", None), getattr(media, "en_title", None)]
            why = year_conflict(payload.get("title") or "", media.year, names)
            if why:
                warnings.append(f"{why}，可能不是这部作品")
            # 同一部电影只有一个 strm：已有别的种子在这个目录时，新的会替换旧的
            others = [t for h, t in self._pipe.load().items() if t.get("dir") == path and h != self._btih(magnet)
                      and t.get("status") not in ("cancelled", "strm-failed")]
            if others:
                warnings.append(f"这部电影已有 {len(others)} 个入库任务（{(others[-1].get('name') or others[-1].get('title') or '')[:60]}），"
                                f"新的会作为另一个版本保存（Emby 里可切换），旧文件保留")
        if payload.get("dry_run"):
            return {"ok": True, "dry_run": True, "dir": path, "meta": info, "warnings": warnings}
        ok, h, err = self._pipe.submit(magnet, path, payload.get("title") or "", meta=info)
        if ok:
            self._kick()
        return {"ok": ok, "hash": h, "dir": path, "error": err or None}

    def api_task_meta(self, payload: dict = Body(...)) -> Dict[str, Any]:
        """改已提交任务的入库参数（下错目录/集号时用，改完 retry）：{"hash": "...", "meta": {"merged_season": 1, "ep_offset": 24}}
        meta 里值为 null 的键会被删除。"""
        p = self._pipe
        if not p:
            return {"ok": False, "error": "流水线未就绪"}
        with p._save_lock:
            tasks = p.load()
            hits = [h for h in tasks if h.startswith(str(payload.get("hash") or "-").lower())]
            if len(hits) != 1:
                return {"ok": False, "error": f"hash 匹配到 {len(hits)} 个任务"}
            meta = tasks[hits[0]].setdefault("meta", {})
            tasks[hits[0]]["api_ts"] = time.time()
            for k, v in (payload.get("meta") or {}).items():
                if v is None:
                    meta.pop(k, None)
                else:
                    meta[k] = v
            p.save(tasks)
        return {"ok": True, "hash": hits[0], "meta": meta}

    def api_queries(self, tmdbid: int, type: str = "tv", season: int = 0) -> Dict[str, Any]:  # noqa: A002
        """预览关键词模板渲染结果。"""
        item = {"tmdbid": tmdbid, "type": type}
        media = batch_mod._recognize(item)
        if not media:
            return {"error": "识别失败"}
        ctx = query_context(media.title, media, [season] if season else [])
        return {"context": ctx, "queries": render_queries(self._conf.get("query_templates") or DEFAULT_QUERY_TEMPLATES,
                                                          ctx, int(self._conf.get("max_queries") or 9))}

    # ---------------- AV / 里番 API ----------------
    def _need_adult(self) -> Optional[Dict[str, Any]]:
        return None if self._adult else {"ok": False, "error": "AV/里番 未启用（插件设置里打开，且流水线要就绪）"}

    def api_av_add(self, payload: dict = Body(...)) -> Any:
        """AV 入库：番号（sukebei 自动挑 FHD/中字/做种多的）或磁力 → 115 → MDC → AV 库。"""
        if self._need_adult():
            return self._need_adult()
        items = payload.get("items") or payload.get("codes") or []
        res = self._adult.av_add([items] if isinstance(items, str) else items, bool(payload.get("dry_run")), bool(payload.get("force")))
        if any(r.get("ok") and not r.get("dry_run") for r in res):
            self._adult_kick()
        # 一个都没提交成功就是失败（以前总是 ok:true，失败只在 results 里，App/后端看不出来）
        ok = any(r.get("ok") for r in res)
        return {"ok": ok, "results": res, **({} if ok else {"error": "；".join(f"{r.get('code') or r.get('item', '')[:30]}：{r.get('error')}" for r in res if r.get("error")) or "没有可提交的条目"})}

    def api_av_retry(self, payload: dict = Body(default={})) -> Any:
        if self._need_adult():
            return self._need_adult()
        n = self._adult.av_retry(str((payload or {}).get("name") or ""))
        self._adult_kick()
        return {"ok": True, "requeued": n}

    def api_hentai_add(self, payload: dict = Body(...)) -> Any:
        """加进追更目录；search（默认 true）立即在 sukebei 搜这几部并提交。"""
        if self._need_adult():
            return self._need_adult()
        titles = payload.get("titles") or []
        titles = [titles] if isinstance(titles, str) else titles
        added = self._adult.catalog_add(titles)
        report = self._adult.ingest(only=titles) if payload.get("search", True) else []
        if report:
            self._adult_kick()
        return {"ok": True, "added": added, "report": report}

    def api_hentai_submit(self, payload: dict = Body(...)) -> Any:
        if self._need_adult():
            return self._need_adult()
        link = payload.get("magnet") or (adult_magnet(payload["hash"].lower()) if payload.get("hash") else "")
        if not link:
            return {"ok": False, "error": "要 magnet 或 hash"}
        r = self._adult.hentai_submit(link, payload.get("title") or "", payload.get("ep"))
        self._adult_kick()
        return r

    def api_hentai_scan(self) -> Any:
        if self._need_adult():
            return self._need_adult()
        def job():
            try:
                n = self._adult.scan(force=True)
                self._log(f"里番扫描完成：新增 {n} 集")
            except Exception:  # noqa: BLE001
                import traceback
                logger.error(f"【Prowlarr115】里番扫描出错：{traceback.format_exc()}")
        threading.Thread(target=job, name="prowlarr115-hscan", daemon=True).start()
        return {"ok": True, "started": True}

    def api_hentai_fix(self) -> Any:
        if self._need_adult():
            return self._need_adult()
        return {"ok": True, "fixed": self._adult.emby_fix(force=True)}

    def api_adult_status(self) -> Any:
        if self._need_adult():
            return self._need_adult()
        return self._adult.status()

    def api_adult_run(self, full: bool = False) -> Any:
        if self._need_adult():
            return self._need_adult()
        threading.Thread(target=self.adult_track, kwargs={"quick": not full}, name="prowlarr115-adult-run", daemon=True).start()
        return {"ok": True, "started": True}

    def api_adult_import(self, payload: dict = Body(...)) -> Any:
        """一次性导入 NAS 旧脚本状态（av115-state.json / hentai-state.json / hentai-catalog.json）。"""
        for key, name in (("av", "av"), ("hentai", "hentai"), ("catalog", "hentai_catalog")):
            if payload.get(key):
                self.save_data(name, payload[key])
        return {"ok": True, "imported": [k for k in ("av", "hentai", "catalog") if payload.get(k)]}

    # ---------------- UI ----------------
    def get_form(self) -> Tuple[Optional[List[dict]], Dict[str, Any]]:
        """配置表单。"""
        def field(model, label, hint="", cols=6, **props):
            return {"component": "VCol", "props": {"cols": 12, "md": cols},
                    "content": [{"component": "VTextField",
                                 "props": dict({"model": model, "label": label, "hint": hint,
                                                "persistent-hint": bool(hint)}, **props)}]}

        def area(model, label, hint="", rows=8):
            return {"component": "VCol", "props": {"cols": 12},
                    "content": [{"component": "VTextarea", "props": {"model": model, "label": label, "hint": hint,
                                                                     "persistent-hint": True, "rows": rows,
                                                                     "style": "font-family: monospace"}}]}

        def switch(model, label, cols=3):
            return {"component": "VCol", "props": {"cols": 12, "md": cols},
                    "content": [{"component": "VSwitch", "props": {"model": model, "label": label}}]}

        def row(*cols):
            return {"component": "VRow", "content": list(cols)}

        return [{
            "component": "VForm",
            "content": [
                row(switch("enabled", "启用插件"), switch("offline", "下载走 115 离线"), switch("multi_keyword", "多关键词搜索"),
                    switch("notify", "进度通知")),
                row(field("prowlarr_url", "Prowlarr 地址", "如 http://prowlarr:9696"), field("prowlarr_key", "Prowlarr API Key", type="password")),
                row(field("indexers", "只用这些索引器 ID", "逗号分隔，留空=全部", 4), field("exclude_indexers", "排除索引器 ID", "默认排除 sukebei(16)", 4),
                    field("min_seeders", "最少做种数", cols=2, type="number"), field("max_results", "每个关键词最多结果", cols=2, type="number")),
                row(field("openlist_url", "OpenList 地址（插件用）", cols=4), field("openlist_public", "OpenList 地址（写进 strm，Emby 用）", cols=4),
                    field("root", "115 根目录", cols=4)),
                row(field("openlist_user", "OpenList 用户", cols=3), field("openlist_pass", "OpenList 密码", cols=3, type="password"),
                    field("lib_ol_root", "媒体库的 OpenList 路径", cols=6)),
                row(field("cookie_115", "115 Cookie", "与 OpenList 的 115 存储同一份", 6, type="password"),
                    field("proxy_115", "115 请求代理", "经 NAS 出口，避免异地风控", 6)),
                row(field("qb_url", "NAS qBittorrent（缓冲）", cols=4), field("qb_user", "qB 用户", cols=2), field("qb_pass", "qB 密码", cols=2, type="password"),
                    field("buffer_max_gb", "缓冲上限 GB", cols=2, type="number"), field("buffer_local", "缓冲目录（NAS）", cols=2)),
                row(field("emby_url", "Emby 地址", cols=4), field("emby_key", "Emby API Key", cols=4, type="password"),
                    field("emby_lib_root", "Emby 里的媒体库路径", cols=4)),
                row(area("query_templates", "搜索关键词模板（Jinja2，每行一个）",
                         "变量：keyword title original_title en_title short_title short_original latin_names en_head seasons year type；过滤器 cn"),
                    field("max_queries", "最多关键词数", cols=3, type="number")),
                row(switch("adult", "AV / 里番 入库", 3), field("mdc_url", "MDC 后端", "如 http://mdc:9207（同一 docker 网络）", 4),
                    field("bangumi_token", "Bangumi Access Token（可选）", "留空=经 Emby 的 Bangumi 插件识别里番", 5, type="password")),
                row(area("av_inbox", "AV 待入库（番号或磁力，每行一个）", "保存后在后台提交 115，MDC 刮削进 AV 库；结果发到服务通知群", 3),
                    ),
                row(area("hentai_inbox", "里番待入库（日文原名最好，每行一个）", "保存后加进追更目录并立即搜索 sukebei；以后 RSS 自动追新集", 3)),
                row(area("policy", "选片策略（JSON，与默认值合并）",
                         "tv.per_episode_gb / ideal_per_episode_gb、movie.min_gb/max_gb/ideal_gb、weights、groups、exclude、require_cn_sub、score_expr（Jinja 表达式，变量 t）", 12)),
                row({"component": "VCol", "props": {"cols": 12}, "content": [{
                    "component": "VAlert", "props": {"type": "info", "variant": "tonal", "text":
                        "流程：MP 搜索（本插件资源源，多关键词）→ 下载按钮/订阅 → 保存路径改成 /115/Emby/<库>/<名 (年) [tmdbid=N]>/Season N（库里已有同一部则用原目录）"
                        " → 115 离线（失败转 NAS qB 缓冲边下边传）→ 每 5 分钟检查，完成后经 OpenList 写 strm/字幕到 NAS 媒体库 → Emby 刮削确认 → 通知。"
                        "批量入库与策略调整见插件 API：/batch /policy /queries /tasks。"}}]}),
            ],
        }], dict(self._defaults(), **{
            "enabled": False, "offline": True, "multi_keyword": True, "notify": True,
            "prowlarr_url": "http://prowlarr:9696", "prowlarr_key": "",
            "indexers": "", "exclude_indexers": "16", "min_seeders": 1, "max_results": 200,
            "query_templates": DEFAULT_QUERY_TEMPLATES, "max_queries": 9,
            "adult": True, "mdc_url": "http://mdc:9207", "bangumi_token": "", "av_inbox": "", "hentai_inbox": "",
            "policy": json.dumps(DEFAULT_POLICY, ensure_ascii=False, indent=1),
        })

    def get_page(self) -> Optional[List[dict]]:
        """详情页：最近的下载任务。"""
        icon = {"downloading": "⏬", "buffer": "🧱", "uploaded": "⬆️", "done": "📦", "strm-failed": "❌", "too-big": "❌",
                "dead": "❌", "lost": "❓", "no-video": "⚠️", "superseded": "♻️", "cancelled": "🚫"}
        rows = []
        for t in self.api_tasks(40):
            st = t.get("status", "")
            emby = "✅" if (t.get("emby") or 0) > 0 else ("⚠️" if (t.get("emby") or 0) < 0 else "")
            rows.append({"component": "tr", "content": [
                {"component": "td", "text": f"{icon.get(st, '')} {st}"},
                {"component": "td", "text": f"{t.get('percent') or 0}%"},
                {"component": "td", "text": (t.get("dir") or "").replace(self._root + "/", "")},
                {"component": "td", "text": (t.get("name") or "")[:50]},
                {"component": "td", "text": f"{len(t.get('strm') or [])} {emby}"},
                {"component": "td", "text": datetime.fromtimestamp(t.get("added", 0)).strftime("%m-%d %H:%M")},
            ]})
        head = []
        if self._adult:
            try:
                a = self._adult.status()
                head = [{"component": "VAlert", "props": {"type": "info", "variant": "tonal", "class": "mb-2", "text":
                         f"AV：{len(a['av_pending'])} 个等 MDC 刮削"
                         + (f"（失败 {sum(1 for x in a['av_pending'] if x.get('status') == 'failed')}）" if a['av_pending'] else "")
                         + f"，最近入库 {' '.join(x.get('code') or '?' for x in a['av_recent'][:8])}；"
                         f"里番：{a['hentai_series']} 部 {a['hentai_eps']} 集，追更目录 {a['catalog']} 部。"
                         "搜索框输入番号（SSIS-001）、「av 关键词」或「里番 名字」可直接搜 sukebei 并下载入库。"}}]
            except Exception:  # noqa: BLE001
                head = []
        if not rows:
            return head + [{"component": "VAlert", "props": {"type": "info", "variant": "tonal", "text": "还没有下载任务"}}]
        return head + [{"component": "VTable", "props": {"hover": True, "density": "compact"}, "content": [
            {"component": "thead", "content": [{"component": "tr", "content": [
                {"component": "th", "text": h} for h in ("状态", "进度", "目录", "115 任务名", "入库/刮削", "提交")]}]},
            {"component": "tbody", "content": rows},
        ]}]
