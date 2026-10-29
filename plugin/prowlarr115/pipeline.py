"""下载任务流水线：115 离线 → (失败时 NAS 缓冲) → strm/字幕入库 → Emby 刮削确认 → 通知。

文件操作全部经 OpenList API，插件不需要挂载媒体库。

目录约定：
  115 原片   <remote_root>/<库>/<名 (年) [tmdbid=N]>[/Season N]/...     （remote_root 默认 /115/Emby）
  媒体库     <lib_ol_root>/<库>/<同上>/...  （OpenList 本地存储，默认 /media/媒体库）
  Emby 路径  <emby_lib_root>/<库>/<同上>   （默认 /media/library）
状态（task.status）：downloading → (buffer → uploaded) → done → emby 确认；终态 failed / too-big / dead / lost / no-video / superseded（库里已有更好的版本）
"""
import base64
import re
import urllib.parse
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Dict, List, Optional

from . import subs as subs_mod
from .policy import title_season, year_conflict
from .clients import ClientError, Cloud115, Emby, OpenList, QBit, now

VIDEO = (".mp4", ".mkv", ".avi", ".wmv", ".mov", ".ts", ".m2ts", ".webm", ".flv", ".rmvb", ".iso", ".m4v")
SUB_EXT = (".ass", ".ssa", ".srt", ".sup")
LIBS = ("电影", "剧集", "动漫")
MIN_MOVIE = 300e6
MIN_EPISODE = 50e6
STALL_AFTER = 6 * 3600
STALL_HINT = 30 * 60          # 115 离线 30 分钟仍 0%：标成「卡住」，App 里给出改用 NAS 缓冲 / 换资源（6 小时后才自动改缓冲）
LOST_AFTER = 3 * 86400
DEAD_AFTER = 24 * 3600
UPLOAD_TIMEOUT = 6 * 3600
EMBY_GIVEUP = 3 * 3600
CHUNK = 256 * 1024


def btih(link: str) -> str:
    """磁力链接的 info hash（hex 小写；base32 自动转换）。"""
    m = re.search(r"xt=urn:btih:([0-9a-zA-Z]+)", link or "")
    if not m:
        return ""
    h = m.group(1)
    if len(h) == 32:
        h = base64.b32decode(h.upper()).hex()
    return h.lower()


def ep_of(name: str):
    """从文件名取 (季, 集)；季可能为 None。认不出返回 None。"""
    for rx in (r"[Ss](\d{1,2})[Ee](\d{1,3})", r"\b[Ee][Pp]?(\d{1,3})\b", r"第\s*(\d{1,3})\s*[集话話]",
               r"\s-\s(\d{1,3})(?:v\d)?['’]?(?:\s|\[|\(|\.|$)", r"\[(\d{1,3})(?:v\d)?\]",
               r"\[(\d{1,3})(?:v\d)?\s*\(\d{1,3}\)\]",          # VCB「[12(24)]」：本季集号(绝对集号)
               r"\.(\d{2,3})\.(?!\d)"):
        m = re.search(rx, name)
        if m:
            g = m.groups()
            return (int(g[0]), int(g[1])) if len(g) == 2 else (None, int(g[0]))
    # 最宽松：「Brotherhood 64 END [BD ...]」（SAIO-Raws）；先排除 NCOP / OVA 01 / Short Skit 16 这类特典
    if not EXTRA.search(name):
        m = re.search(r"[A-Za-z\)]\s(\d{1,3})(?:\s+END)?\s*\[", name)
        if m:
            return None, int(m.group(1))
    return None


EXTRA_DIR = re.compile(r"(?i)/(menus?|pvs?|cms?|sps?|nc\s*op[^/]*|nc\s*ed[^/]*|extras?|bonus|specials?|特典[^/]*|映像特典|"
                       r"scans?|cds?|preview|trailers?|making|interview)/")
EXTRA_TAG = re.compile(r"(?i)[\[(（【](menu\d*|pv\d*|cm\d*|nc\s?op\d*|nc\s?ed\d*|preview|trailer|teaser|bdmenu|特典)[\])）】]")
EXTRA = re.compile(r"(?i)\b(NC\s?OP|NC\s?ED|OVA|OAD|SPs?|Skit|Menu|PV|CM|Preview|Trailer|Teaser|Program|Bonus|Extras?|Specials?|Recap)\b")


def sub_lang(name: str) -> str:
    """外挂字幕语言后缀：Emby 认 chs→zh-CN、cht→zh-TW、en、ja。"""
    n = name.lower()
    if re.search(r"jptc|cht|big5|\btc\b|繁", n):
        return "cht"
    if re.search(r"jpsc|chs|\bgb\b|\bsc\b|简", n):
        return "chs"
    if re.search(r"[._\[ -](en|eng|english)[._\] ]", n):
        return "en"
    if re.search(r"[._\[ -](ja|jp|jpn)[._\] ]", n):
        return "ja"
    return "zh"


def label(d: str) -> str:
    """'/115/Emby/动漫/无职转生 (2021)/Season 2' -> '无职转生 (2021) 第2季'"""
    parts = d.split("/")
    if len(parts) == 4 and parts[3] == "下载":
        return "AV"
    name = re.sub(r"\s*\[(tmdbid|bangumiid)=\d+\]$", "", parts[4] if len(parts) > 4 else d)
    m = re.search(r"/Season (\d+)$", d)
    if m:
        return f"{name} 第{m.group(1)}季"
    return name + (" 特别篇" if d.endswith("/Specials") else "")



def _version_label(remote: str) -> str:
    """Emby 多版本的版本名：分辨率 + 发布组（「2160p DBD-Raws」），认不出用文件名开头。"""
    name = remote.rsplit("/", 1)[-1]
    res = (re.search(r"(?i)\b(2160p|1080p|720p|4k)\b", name) or [None, ""])[1]
    grp = (re.match(r"^\s*[\[【]([^\]】]{2,24})[\]】]", name) or [None, ""])[1]
    label = " ".join(x for x in (res, grp) if x) or re.sub(r"[\[\]【】]", "", name.rsplit(".", 1)[0])[:24]
    return re.sub(r'[\\/:*?"<>|]', " ", label).strip() or "版本2"

# 磁力没带 tracker 时补上的公共 tracker（Nyaa 自己的 + 常用公共 tracker）
PUBLIC_TRACKERS = ("http://nyaa.tracker.wf:7777/announce", "udp://tracker.opentrackr.org:1337/announce",
                   "udp://open.stealth.si:80/announce", "udp://tracker.torrent.eu.org:451/announce",
                   "udp://exodus.desync.com:6969/announce")


ADULT_KINDS = ("av", "hentai")


def with_trackers(url: str) -> str:
    """磁力缺 tracker 就补上：115 离线和 qB 拿种子信息都快得多（只靠 DHT 时新种子在 115 上会一直 0%）。"""
    if not (url or "").startswith("magnet:") or "tr=" in url:
        return url
    return url + "".join("&tr=" + urllib.parse.quote(t, safe="") for t in PUBLIC_TRACKERS)


class Pipeline:
    """任务状态保存在插件数据 tasks（{info_hash: task}）。"""

    def __init__(self, conf: Dict[str, Any], load: Callable[[], dict], save: Callable[[dict], None],
                 notify: Callable[[str, str], None], log, ev_load: Optional[Callable[[], dict]] = None,
                 ev_save: Optional[Callable[[dict], None]] = None):
        self.c = conf
        self.load, self.save, self._notify_fn, self._log_fn = load, save, notify, log
        # 每个任务的事件日志（App 任务详情里按步骤看日志、找卡点）：插件数据 events = {hash: [[ts, step, level, msg], ...]}，
        # 和 tasks 分开存（tasks 每次整表回写），每个任务最多 EV_MAX 条，最多 EV_TASKS 个任务
        self._ev_load, self._ev_save = ev_load, ev_save
        self._ev_lock = threading.Lock()
        self._cur = threading.local()          # 当前线程正在处理的任务和步骤：期间的 log/notify 都记到这个任务上
        self._subs_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="p115-subs")
        self.tvdb_map: Optional[Callable[[Any], dict]] = None    # 插件注入：tmdbid -> {(TMDb季,集): (TVDB季,集)}
        self.on_fail: Optional[Callable[[str, dict, str], None]] = None   # 插件注入：资源不可用时拉黑 + 回滚订阅
        self.on_ok: Optional[Callable[[str], None]] = None
        # 插件注入 Adult：AV / 里番任务和影视共用提交、115 离线、卡住、NAS 缓冲、换资源、黑名单，
        # 只有「115 下完以后」不同：AV 写进 MDC 收件箱交给 MDC 刮削整理，里番按 Bangumi 目录生成 strm
        self.adult: Any = None
        self.root = "/" + conf["root"].strip("/")
        self.lib_ol = "/" + conf["lib_ol_root"].strip("/")
        self.ol = OpenList(conf["openlist_url"], conf["openlist_user"], conf["openlist_pass"], conf["openlist_public"])
        self.c115 = Cloud115(conf["cookie_115"], conf.get("proxy_115") or None)
        self.qb = QBit(conf["qb_url"], conf["qb_user"], conf["qb_pass"]) if conf.get("qb_url") else None
        self.emby = Emby(conf["emby_url"], conf["emby_key"], conf.get("emby_lib_root") or "/media/library")
        self.buffer_max = float(conf.get("buffer_max_gb") or 20) * 1e9
        self.buffer_local = conf.get("buffer_local") or "/media/.mp115-buffer"
        self.buffer_ol = conf.get("buffer_ol") or "/media/.mp115-buffer"
        self._save_lock = threading.Lock()
        self._submit_lock = threading.Lock()
        self._tl = threading.local()     # 每个线程自己的「替换数 / 第 0 集」计数（入库并行处理多个任务）

    # ---------------- 路径 ----------------
    EV_MAX, EV_TASKS = 50, 400
    STRM_MAX_ERRORS = 5

    def mutate(self, h: str, fn: Callable[[dict], Any]) -> bool:
        """改一个任务并落盘（API 用）：在保存锁里重新读、改、写，标 api_ts 让正在跑的这一轮以 API 的改动为准。"""
        with self._save_lock:
            tasks = self.load()
            if h not in tasks:
                return False
            fn(tasks[h])
            tasks[h]["api_ts"] = time.time()
            self.save(tasks)
            return True

    def _dir_lock(self, d: str) -> threading.Lock:
        """同一个媒体库目录同一时间只让一个任务生成 strm（两个合集同时进一季会互相替换/删文件）。"""
        with self._ev_lock:
            locks = self.__dict__.setdefault("_dir_locks", {})
            return locks.setdefault(d, threading.Lock())

    def event(self, h: str, step: str, msg: str, level: str = "info") -> None:
        if not h or not self._ev_load or not self._ev_save:
            return
        with self._ev_lock:
            try:
                ev = self._ev_load() or {}
                rows = ev.setdefault(h, [])
                rows.append([now(), step, level, str(msg)[:300]])
                del rows[:-self.EV_MAX]
                if len(ev) > self.EV_TASKS:
                    for k in sorted(ev, key=lambda k: ev[k][-1][0] if ev[k] else 0)[:len(ev) - self.EV_TASKS]:
                        ev.pop(k, None)
                self._ev_save(ev)
            except Exception:  # noqa: BLE001 日志失败不影响流水线
                pass

    def events(self, h: str) -> List[list]:
        return list(((self._ev_load() or {}) if self._ev_load else {}).get(h) or [])

    def log(self, msg: str) -> None:
        self._log_fn(msg)
        h = getattr(self._cur, "h", None)
        if h:
            self.event(h, getattr(self._cur, "step", ""), msg,
                       "error" if re.search(r"出错|失败|FAIL|Error", msg) else "info")

    def notify(self, title: str, text: str) -> None:
        self._notify_fn(title, text)
        h = getattr(self._cur, "h", None)
        if h:
            self.event(h, getattr(self._cur, "step", ""), f"通知：{title} {text}", "notice")

    class _Ctx:
        def __init__(self, cur, h, step):
            self.cur, self.h, self.step = cur, h, step

        def __enter__(self):
            self.prev = (getattr(self.cur, "h", None), getattr(self.cur, "step", None))
            self.cur.h, self.cur.step = self.h, self.step

        def __exit__(self, *a):
            self.cur.h, self.cur.step = self.prev

    def ctx(self, h: str, step: str) -> "Pipeline._Ctx":
        """with self.ctx(h, "strm"): 期间的 log/notify 记到任务 h 的 strm 步骤下。"""
        return Pipeline._Ctx(self._cur, h, step)

    @staticmethod
    def failed(self, h: str, t: dict, status: str, reason: str) -> None:
        """资源本身不可用（太大 / 死种 / 没有可入库的视频）：置状态，交给插件拉黑并回滚订阅。"""
        t["status"] = status
        if self.on_fail:
            try:
                self.on_fail(h, t, reason)
            except Exception as e:  # noqa: BLE001
                self.log(f"失败回调出错：{e}")

    @staticmethod
    def mark(t: dict, step: str, at: Optional[int] = None) -> None:
        """记录步骤时间点（只记第一次）：submitted / offline / buffer / uploaded / strm / emby。"""
        t.setdefault("ts", {}).setdefault(step, at or now())

    def check_dir(self, d: str) -> str:
        d = (d or "").rstrip("/")
        parts = d.split("/")
        base = len(self.root.split("/"))
        if ".." in parts or not d.startswith(self.root + "/") or parts[base:base + 1] == [] \
                or parts[base] not in LIBS + ("待识别", "里番", "下载") or (len(parts) < base + 2 and parts[base] != "下载"):
            raise ValueError(f"目录不在允许范围：{d}")
        return d

    def emby_path(self, lib_ol_path: str) -> str:
        return (self.c.get("emby_lib_root") or "/media/library") + lib_ol_path[len(self.lib_ol):]

    # ---------------- 提交 ----------------
    def submit(self, url: str, d: str, title: str = "", meta: Optional[dict] = None) -> tuple:
        """提交 115 离线；失败时转 NAS 缓冲。返回 (ok, hash, err)。meta：作品信息（自动补字幕用）。"""
        d = self.check_dir(d)
        url = with_trackers(url)
        h = btih(url)
        if not h:
            return False, "", "只支持磁力链接"
        task = {"dir": d, "title": title, "url": url, "added": now(), "status": "downloading", "meta": meta or {},
                "ts": {"submitted": now()}}
        ok, err = False, ""
        with self._submit_lock:                      # 串行提交 + 间隔，批量入库并发时 115 会被打出「无响应」
            for wait in (0, 3, 6, 12):
                time.sleep(wait or 1)
                try:
                    cid = self.c115.mkdir_p(d[len("/115"):] if d.startswith("/115/") else d)
                    ok, err = self.c115.offline_add(url, cid)
                except ClientError as e:
                    ok, err = False, str(e)
                if ok or "无响应" not in err and "非 JSON" not in err:
                    break
        if not ok:
            try:
                self.buffer_start(h, task, f"115 离线提交失败：{err}")
                ok, err = True, ""
            except Exception as e:  # noqa: BLE001
                err = f"{err}；NAS 缓冲也失败：{e}"
        if ok:
            pick = (task.get("meta") or {}).setdefault("pick", {"by": "manual", "at": now(), "title": title[:200]})
            task["ts"]["select"] = pick.get("at") or now()
            with self._save_lock:
                tasks = self.load()
                tasks[h] = dict(task, api_ts=time.time())     # 这一轮跟踪若拿着旧快照，_persist 会以这次提交为准
                self.save(tasks)
        self.log(f"提交 {d} {h[:8]} {'OK' if ok else 'FAIL ' + err}")
        if ok:
            pk = task["meta"]["pick"]
            how = {"subscription": "订阅自动选中", "auto": "自动入库选中", "manual": "手动选择", "reselect": "手动换资源",
                   "rss": "RSS 追更", "catalog": "追更目录搜索"}.get(pk.get("by"), pk.get("by") or "")
            self.event(h, "select", how + (f"，评分 {pk['score']}（{' '.join(pk.get('why') or [])[:160]}）" if pk.get("score") is not None else "")
                       + (f"，候选 {pk['candidates']} 个" if pk.get("candidates") else ""))
        self.event(h, "submit", f"提交到 {d}" + (f"（{title[:120]}）" if title else "") + ("" if ok else f"，失败：{err}"),
                   "info" if ok else "error")
        return ok, h, err

    # ---------------- NAS 缓冲 ----------------
    def buffer_start(self, h: str, task: dict, reason: str) -> None:
        if not self.qb:
            raise ClientError("没有配置 NAS qBittorrent，无法缓冲")
        self.qb.post("/api/v2/torrents/createCategory", {"category": "mp115buffer", "savePath": self.buffer_local})
        code = self.qb.post("/api/v2/torrents/add", {
            "urls": with_trackers(task.get("url") or f"magnet:?xt=urn:btih:{h}"), "category": "mp115buffer",
            "savepath": f"{self.buffer_local}/{h}", "sequentialDownload": "true",
            "firstLastPiecePrio": "true", "autoTMM": "false"})
        if code != 200:
            raise ClientError(f"qBittorrent 添加失败 HTTP {code}")
        prev = task.get("buffer") or {}
        self.mark(task, "buffer")
        self.event(h, "buffer", f"改用 NAS 缓冲：{reason}", "warn")
        task.update(status="buffer", buffer={"since": now(), "reason": reason,
                                             "uploaded": prev.get("uploaded", {}), "uploading": {}})
        self.notify("⚠️ " + label(task["dir"]), f"{reason}，改用 NAS 缓冲下载（下完一个文件传一个到 115）")

    def _samples_match(self, local: str, remote: str, size: int) -> bool:
        offs = [(0, size)] if size <= 3 * CHUNK else [(0, CHUNK), (size // 2, CHUNK), (size - CHUNK, CHUNK)]
        for o, n in offs:
            rng = f"bytes={o}-{o + n - 1}"
            if self.ol.read(local, rng) != self.ol.read(remote, rng):
                return False
        return True

    def _buffer_one(self, h: str, t: dict, q: Optional[dict], busy: str, inflight: float):
        """推进一个缓冲任务，返回 (是否已全部传完, 在途字节)。"""
        b = t["buffer"]
        if q is None:
            if now() - b["since"] > 600:
                self.buffer_start(h, t, "qB 任务丢失，重新添加")
            return False, inflight
        size = float(q.get("total_size") or q.get("size") or 0)
        t["percent"] = round(float(q.get("progress") or 0) * 100)
        t["name"] = q.get("name")
        if size > self.buffer_max:
            self.qb.post("/api/v2/torrents/delete", {"hashes": h, "deleteFiles": "true"})
            self.failed(h, t, "too-big", f"种子 {size / 1e9:.1f}G 超过 NAS 缓冲上限")
            self.notify("❌ " + label(t["dir"]), f"NAS 缓冲上限 {self.buffer_max / 1e9:.0f}G，种子 {size / 1e9:.1f}G 太大，已放弃")
            return False, inflight
        if not q.get("progress") and now() - b["since"] > DEAD_AFTER:
            self.qb.post("/api/v2/torrents/delete", {"hashes": h, "deleteFiles": "true"})
            self.failed(h, t, "dead", "115 和 NAS 缓冲都下不动")
            self.notify("❌ " + label(t["dir"]), "115 和 NAS 缓冲都下载不动（24 小时 0%），判定死种，请换资源")
            return False, inflight
        if float(q.get("progress") or 0) < 1:
            if inflight + size > self.buffer_max and inflight > 0:
                self.qb.pause(h, True)
                return False, inflight
            if str(q.get("state", "")).lower().startswith(("paused", "stopped")):
                self.qb.pause(h, False)
            inflight += size
        files = self.qb.get("/api/v2/torrents/files", {"hash": h}) or []
        wanted = [f for f in files if f.get("priority", 1) > 0]
        for f in wanted:
            name, fsize = f["name"], f["size"]
            if f.get("progress", 0) < 1 or name in b["uploaded"]:
                continue
            local = f"{self.buffer_ol}/{h}/{name}"
            remote = f"{t['dir']}/{name}"
            up = b["uploading"].get(name)
            if up is None:
                self.ol.refresh_path(local.rsplit("/", 1)[0], 2)
                if not self.ol.get(local):
                    continue
                self.ol.refresh_path(remote.rsplit("/", 1)[0])
                it = self.ol.get(remote)
                if it and it.get("size") == fsize and self._samples_match(local, remote, fsize):
                    b["uploaded"][name] = now()
                    continue
                if it:
                    self.ol.remove(remote.rsplit("/", 1)[0], [remote.rsplit("/", 1)[1]])
                self.ol.mkdir(remote.rsplit("/", 1)[0])
                self.ol.copy(local.rsplit("/", 1)[0], remote.rsplit("/", 1)[0], [local.rsplit("/", 1)[1]])
                b["uploading"][name] = {"since": now()}
                self.log(f"缓冲上传 {remote[-80:]} {fsize / 1e9:.2f}G")
                continue
            if name.rsplit("/", 1)[-1] in busy:
                continue
            self.ol.refresh_path(remote.rsplit("/", 1)[0])
            it = self.ol.get(remote)
            if it and it.get("size") == fsize and self._samples_match(local, remote, fsize):
                b["uploaded"][name] = now()
                b["uploading"].pop(name, None)
            elif now() - up["since"] > UPLOAD_TIMEOUT or (not it and now() - up["since"] > 600):
                b["uploading"].pop(name, None)
        if float(q.get("progress") or 0) >= 1 and wanted and all(f["name"] in b["uploaded"] for f in wanted):
            self.qb.post("/api/v2/torrents/delete", {"hashes": h, "deleteFiles": "true"})
            t["status"] = "uploaded"
            self.log(f"缓冲全部传到 115，已删本地：{t['dir']}")
            return True, inflight
        return False, inflight

    def buffer_run(self, tasks: dict) -> List[str]:
        bufs = {h: t for h, t in tasks.items() if t.get("status") == "buffer"}
        if not bufs or not self.qb:
            return []
        torrents = {t["hash"]: t for t in (self.qb.get("/api/v2/torrents/info", {"category": "mp115buffer"}) or [])}
        busy = " ".join(self.ol.copy_undone())
        inflight = 0.0
        for h, t in sorted(bufs.items(), key=lambda kv: kv[1]["buffer"]["since"]):
            with self.ctx(h, "buffer"):
                try:
                    done, inflight = self._buffer_one(h, t, torrents.get(h), busy, inflight)
                    if done:
                        self.mark(t, "uploaded")
                except Exception as e:  # noqa: BLE001 一个任务出错不影响其他
                    self.log(f"缓冲出错 {t['dir']}: {e}")
        return list(bufs)

    # ---------------- strm ----------------
    def _write_strm(self, stub: str, remote: str) -> None:
        self.ol.put(stub, self.ol.sign_url(remote, public=True).encode())

    def _replace(self, stub: str, remote: str, protect: Optional[set] = None) -> bool:
        """已有 strm 指向别的文件 = 重下：删 115 上的旧文件和旧外挂字幕。返回 True 表示可覆盖。
        protect：本任务自己的文件（重新映射集号时同一合集内互相挪位，不能删）。"""
        old = self.ol.remote_of_strm(stub)
        if not old or old == remote:
            return False
        if old.startswith(self.root + "/") and old not in (protect or set()):
            try:
                self.ol.remove(old.rsplit("/", 1)[0], [old.rsplit("/", 1)[1]])
            except ClientError as e:
                self.log(f"删除旧文件失败 {old[-60:]}: {e}")
        d, stem = stub.rsplit("/", 1)[0], stub.rsplit("/", 1)[1][:-5]
        olds = [i["name"] for i in self.ol.list(d, refresh=True)
                if i["name"].startswith(stem + ".") and i["name"].lower().endswith(SUB_EXT)]
        if olds:
            self.ol.remove(d, olds)
        self._tl.replaced = getattr(self._tl, 'replaced', 0) + 1
        return True

    def _copy_sub(self, sub_remote: str, stub: str) -> None:
        ext = "." + sub_remote.rsplit(".", 1)[-1].lower()
        dst = f"{stub[:-5]}.{sub_lang(sub_remote.rsplit('/', 1)[-1])}{ext}"
        if not self.ol.get(dst):
            self.ol.put(dst, self.ol.read(sub_remote))

    def make_strms(self, d: str, t_meta: Optional[dict] = None, scope: Optional[str] = None) -> List[str]:
        """为 115 目录 d 生成媒体库 strm（OpenList 路径列表）。t_meta.ep_offset：集号偏移。
        scope：本任务的 115 任务名；目录下有同名文件夹/文件时只处理它（同一季陆续进来多个种子时互不干扰）。"""
        self.ol.refresh_path(d)
        parts = d.split("/")
        base = len(self.root.split("/"))
        lib, folder = parts[base], parts[base + 1]
        base_title = re.sub(r"\s*\[tmdbid=\d+\]$", "", folder)
        show = base_title.rsplit(" (", 1)[0]
        m = re.search(r"/Season (\d+)$", d)
        dir_season = int(m.group(1)) if m else None
        files = None
        if scope:
            hit = self.ol.get(f"{d}/{scope}")
            if not hit:
                alt = re.sub(r'[\\/:*?"<>|]', "_", scope)      # 115 保存时把 : ? 等换成 _
                hit = self.ol.get(f"{d}/{alt}") if alt != scope else None
                scope = alt if hit else scope
            if hit:
                files = list(self.ol.walk(f"{d}/{scope}")) if hit.get("is_dir") else [(f"{d}/{scope}", hit)]
        if files is None:
            files = list(self.ol.walk(d))
        # 合集里的特典目录/文件（BD 菜单、PV、NCOP、CM、SPs、特典映像…）不是正片：
        # 「[menu][01]」曾被认成第 1 集，替换时还把真正的第 1 集从 115 删了（命运石之门 0，2026-10-11）
        rel0 = len(d) + 1
        vids = [(r, it) for r, it in files if r.lower().endswith(VIDEO)
                and not EXTRA_DIR.search("/" + r[rel0:].rsplit("/", 1)[0] + "/")
                and not EXTRA_TAG.search(r.rsplit("/", 1)[1])]
        subs = [r for r, _ in files if r.lower().endswith(SUB_EXT)]
        made: List[str] = []
        self._tl.replaced, self._tl.zero, self._tl.linked, self._tl.kept = 0, [], 0, 0
        self._tl.nvid = len(vids)
        lib_folder = f"{self.lib_ol}/{lib}/{folder}"
        protect = {r for r, _ in vids}
        if lib == "电影":
            big = [v for v in vids if v[1].get("size", 0) >= MIN_MOVIE] or vids
            if not big:
                return made
            remote = max(big, key=lambda v: v[1].get("size", 0))[0]
            stub = f"{lib_folder}/{base_title}.strm"
            self.ol.mkdir(lib_folder)
            cur = self.ol.remote_of_strm(stub) if self.ol.get(stub) else None
            if cur and cur != remote and not (t_meta or {}).get("replace"):
                # 目录里已有另一个种子的正片：不删它（2026-10-27 两场不同年份的演唱会被下进同一部，后一个删了前一个的文件），
                # 新的按 Emby 多版本命名「片名 - 版本.strm」放在旁边，播放时可切换；要替换请带 meta.replace
                stub = f"{lib_folder}/{base_title} - {_version_label(remote)}.strm"
                self.log(f"电影目录已有别的版本，新文件作为另一个版本入库：{stub.rsplit('/', 1)[1]}")
            if not self.ol.get(stub) or self._replace(stub, remote, protect):
                self._write_strm(stub, remote)
                made.append(stub)
            elif self.ol.remote_of_strm(stub) == remote:
                self._tl.linked += 1
            else:
                self._tl.kept += 1
            stem = remote.rsplit("/", 1)[1].rsplit(".", 1)[0]
            for s in subs:
                if s.rsplit("/", 1)[1].startswith(stem) or len(big) == 1:
                    self._copy_sub(s, stub)
            return made
        # 短篇动画（暗芝居、轻松熊每集 4 分钟、50MB 上下）：门槛取 50MB 和本种最大视频一半里较小的那个，
        # 特典由 EXTRA_DIR/EXTRA_TAG 排除，不靠大小
        min_ep = min(MIN_EPISODE, 0.5 * max((it.get("size", 0) for _, it in vids), default=0)) or MIN_EPISODE
        meta = t_meta or {}
        off0 = int(meta.get("ep_offset") or 0)
        ep_max = int(meta.get("ep_max") or 0)
        delta = 0
        if off0 and not meta.get("season_starts"):
            # 合集已用发行方的绝对集号（VCB 文豪野犬 S3 是 [26]-[37]，日版把 OAD 算作第 25 话），
            # 与 TMDb 起点（25）不一致：整体平移到 off0+1 开始
            nums = sorted({e[1] for e in (ep_of(r.rsplit("/", 1)[1]) for r, it in vids
                                          if it.get("size", 0) >= min_ep) if e})
            if nums and nums[0] > off0:
                delta = nums[0] - (off0 + 1)
        for remote, it in sorted(vids, key=lambda v: -v[1].get("size", 0)):
            if it.get("size", 0) < min_ep:
                continue
            name = remote.rsplit("/", 1)[1]
            se = ep_of(name)
            if not se:
                self.log(f"认不出集数，跳过：{remote[-90:]}")
                continue
            if delta and se[1] > off0:
                se = (se[0], se[1] - delta)
            starts = (t_meta or {}).get("season_starts") or {}
            if starts and 0 < se[1] <= 30:
                # 多季合集进 TMDb 合并季：按文件所在子目录/文件名里的季号找起点（「S1+S2」包里的 S2 第 1 集 -> 第 13 集）
                rel = remote[len(d) + 1:].split("/", 1)[-1] if scope else remote[len(d) + 1:]
                k = se[0] or title_season(rel) or 1
                se = (None, se[1])
                if str(k) in starts:
                    se = (None, int(starts[str(k)]) - 1 + se[1])
            season = se[0] if se[0] is not None else (dir_season or 1)
            if (t_meta or {}).get("merged_season"):
                season = int(t_meta["merged_season"])      # 字幕组的「S3」在 TMDb 合并季里，目录名上的季号不算
            off = 0 if starts else int((t_meta or {}).get("ep_offset") or 0)
            if off and 0 < se[1] <= off:
                se = (se[0], se[1] + off)          # TMDb 把多季合成一季：文件里是本季集号就加偏移，已是绝对集号的不动
            n_season = int(meta.get("ep_count") or 0) if not meta.get("merged_season") else 0
            abs_off = int(meta.get("abs_offset") or 0)
            if abs_off and n_season and season == (meta.get("season") or 1) and se[1] > n_season \
                    and 1 <= se[1] - abs_off <= n_season:
                se = (se[0], se[1] - abs_off)      # 绝对集号（「第二季 [27]」）换成本季集号
            if n_season and season == (meta.get("season") or 1) and se[1] > n_season + 2:
                # 集号远超 TMDb 本季集数：多半是别的编号体系（Crunchyroll 把鬼灭游郭篇算 S2 第 8-18 集），不入库
                self.log(f"第 {se[1]} 集超出 TMDb 本季 {n_season} 集，不入库：{remote[-90:]}")
                self._tl.zero.append(remote)
                continue
            if ep_max and se[1] > ep_max:
                self.log(f"第 {se[1]} 集超出本合集范围（≤{ep_max}，可能是 OAD/特别篇），需要手动对应：{remote[-90:]}")
                self._tl.zero.append(remote)
                continue
            if se[1] == 0 and season > 0:
                self.log(f"第 0 集（第零话/前传）需要手动对应特别篇：{remote[-90:]}")
                self._tl.zero.append(remote)
                continue
            ep_no = se[1]
            if lib == "动漫" and self.tvdb_map and (t_meta or {}).get("tmdbid"):
                # 动漫库按 TheTVDB 分季命名（药屋少女 TMDb S1E25 -> TVDB S2E01）；映射拿不到就保持 TMDb 编号
                try:
                    season, ep_no = self.tvdb_map(t_meta["tmdbid"]).get((season, ep_no), (season, ep_no))
                except Exception as e:  # noqa: BLE001
                    self.log(f"TVDB 映射失败，按 TMDb 编号入库：{e}")
            sdir = f"{lib_folder}/Season {season}"
            stub = f"{sdir}/{show} S{season:02d}E{ep_no:02d}.strm"
            if stub in made:
                continue
            if self.ol.get(stub) and not self._replace(stub, remote, protect):
                if self.ol.remote_of_strm(stub) == remote:
                    self._tl.linked += 1          # 已经入库过（例如上一轮已处理但状态没来得及保存）
                else:
                    self._tl.kept += 1            # 这一集库里已有更好的版本（例如整季合集），保留不换
                continue
            self.ol.mkdir(sdir)
            self._write_strm(stub, remote)
            made.append(stub)
            stem = name.rsplit(".", 1)[0]
            for s in subs:
                if s.rsplit("/", 1)[1].startswith(stem):
                    self._copy_sub(s, stub)
        return made

    # ---------------- 自动补中文字幕 ----------------
    def autosubs(self, t: dict, made: List[str]) -> str:
        """给没有中文字幕（外挂或内封）的剧集从 sub_share 补字幕，返回给通知用的一句话。"""
        if not self.c.get("autosubs", True) or not made:
            return ""
        need: Dict[int, str] = {}
        remote_of: Dict[str, str] = {}
        probed: Dict[str, Optional[bool]] = {}     # 同一个种子目录只抽查一集（同一发布要么都有中文字幕要么都没有）
        for stub in made:
            m = re.search(r"S(\d+)E(\d+)\.strm$", stub)
            d, stem = stub.rsplit("/", 1)[0], stub.rsplit("/", 1)[1][:-5]
            names = [i["name"] for i in self.ol.list(d)]
            if any(n.startswith(stem + ".") and re.search(r"\.(chs|cht|zh)\.", n) for n in names):
                continue
            remote = self.ol.remote_of_strm(stub)
            if not remote:
                continue
            rdir = remote.rsplit("/", 1)[0]
            if rdir not in probed:
                probed[rdir] = subs_mod.has_cn_stream(self.ol.sign_url(remote, public=False))
            cn = probed[rdir]
            if cn is False:
                need[int(m.group(2)) if m else 1] = stub
                remote_of[stub] = remote
        if not need:
            return ""
        meta = t.get("meta") or {}
        parts = t["dir"].split("/")
        lib = parts[len(self.root.split("/"))]
        if lib != "动漫":
            return f"；{len(need)} 集没有中文字幕（非动画，sub_share 不覆盖）"
        season = int(meta.get("season") or (re.search(r"/Season (\d+)$", t["dir"]) or [None, 1])[1])
        year = int(meta.get("season_year") or meta.get("year") or 0)
        names = [meta.get("title"), meta.get("original_title"), meta.get("short_title")]
        try:
            work = subs_mod.find_work([n for n in names if n], year, season) if year else None
            if not work:
                return f"；{len(need)} 集没有中文字幕，sub_share 没找到这部"
            files = subs_mod.plan(work, sorted(need))
            if not files:
                return f"；{len(need)} 集没有中文字幕，sub_share「{work['name']}」里没有对应集"
            offs = []
            for ep in sorted(files)[:2]:            # 只校验前两集，按中位数统一修正
                o = subs_mod.offset(self.ol.sign_url(remote_of[need[ep]], public=False), subs_mod.download(files[ep]))
                if o is not None:
                    offs.append(o)
            off = sorted(offs)[len(offs) // 2] if offs else 0.0
            for ep, path in files.items():
                data = subs_mod.download(path)
                if abs(off) > 0.3:
                    data = subs_mod.shift(data, off)
                self.ol.put(need[ep][:-5] + ".chs.ass", data)
            return (f"；自动补中文字幕 {len(files)}/{len(need)} 集（sub_share「{work['name']}」，"
                    + (f"时间轴已平移 {off:+.1f}s" if abs(off) > 0.3 else f"时间轴偏差 {off:+.1f}s") + "）")
        except Exception as e:  # noqa: BLE001
            self.log(f"自动补字幕出错：{e}")
            return f"；{len(need)} 集没有中文字幕，自动补字幕出错：{e}"

    # ---------------- Emby 确认 ----------------
    def emby_folder(self, t: dict) -> str:
        """任务对应的 Emby 作品目录（Emby 里的路径）。"""
        m = t.get("meta") or {}
        if m.get("kind") == "hentai":
            return f"{self.c.get('emby_lib_root') or '/media/library'}/里番/{m.get('lib') or ''}"
        parts = t["dir"].split("/")
        base = len(self.root.split("/"))
        return self.emby_path(f"{self.lib_ol}/{parts[base]}/{parts[base + 1]}")

    def emby_check(self, t: dict) -> None:
        parts = t["dir"].split("/")
        base = len(self.root.split("/"))
        lib, folder = parts[base], parts[base + 1]
        want = self.emby_path(f"{self.lib_ol}/{lib}/{folder}")
        title = re.sub(r"\s*(\(\d{4}\))?\s*(\[tmdbid=\d+\])?$", "", folder)
        # 目录名带 [tmdbid=N] 就按 ID 查（Emby 刮削后的名字常和目录名不同：「转生成为魔剑了」→「转生成为魔剑」，按名字搜会漏）
        fid = (re.search(r"\[tmdbid=(\d+)\]", folder) or [None, None])[1]
        q = {"AnyProviderIdEquals": f"Tmdb.{fid}"} if fid else {"SearchTerm": title}
        d = self.emby.get("/Items", Recursive="true", IncludeItemTypes="Movie" if lib == "电影" else "Series",
                          Fields="Path,ProviderIds,ProductionYear", **q) or {}
        items = [i for i in d.get("Items") or [] if (i.get("Path") or "").startswith(want)]
        if not items and fid:
            # 按 ID 没找到这个目录：可能 Emby 认成了别的作品，按名字找到它，下面会报「可能认错」
            d = self.emby.get("/Items", Recursive="true", IncludeItemTypes="Movie" if lib == "电影" else "Series",
                              SearchTerm=title, Fields="Path,ProviderIds,ProductionYear") or {}
            items = [i for i in d.get("Items") or [] if (i.get("Path") or "").startswith(want)]
        it = items[0] if items else None
        if it and (it.get("ProviderIds") or {}).get("Tmdb") and (it.get("ImageTags") or {}).get("Primary"):
            extra = ""
            # 认对了吗：Emby 认出的 TMDb 要和目录里的一致；电影的种子标题年份要和 Emby 刮到的年份对得上
            want_id = (re.search(r"\[tmdbid=(\d+)\]", folder) or [None, None])[1]
            got_id = str(it["ProviderIds"]["Tmdb"])
            warn = ""
            if want_id and got_id != want_id:
                warn = f"Emby 认成了 TMDb {got_id}（目录是 {want_id}）"
            elif lib == "电影":
                why = year_conflict(t.get("name") or t.get("title") or "", it.get("ProductionYear"), [it.get("Name"), folder])
                if why:
                    warn = f"{why}：Emby 刮成了「{it.get('Name')}」({it.get('ProductionYear')})"
            if warn:
                t["identity_warn"] = warn
                self.event(t.get("hash") or getattr(self._cur, "h", "") or "", "emby", f"可能认错：{warn}", "error")
                self.notify("⚠️ 可能认错 " + label(t["dir"]), f"{warn}。不对的话在影库 App 任务详情里「改为另一部」")
            m = re.search(r"/Season (\d+)$", t["dir"])
            sn = (t.get("meta") or {}).get("merged_season") or (m.group(1) if m else None)
            if lib != "电影":
                eps = (self.emby.get(f"/Shows/{it['Id']}/Episodes", **({"Season": sn} if sn else {})) or {}).get("Items") or []
                named = sum(1 for e in eps if e.get("Name") and not re.match(r"^(第\s*\d+\s*集|Episode \d+|.* S\d+E\d+)$", e["Name"]))
                extra = f"，本季 {len(eps)} 集（{named} 集有标题）"
            t["emby"] = now()
            self.notify("✅ " + label(t["dir"]),
                        f"Emby 已刮削：{it['Name']} ({it.get('ProductionYear') or ''}) TMDb {it['ProviderIds']['Tmdb']}{extra}")


    def _persist(self, h: str, t: dict) -> None:
        """单个任务状态立即落盘（一轮要处理几十个合集时，不等整轮结束；中途重载也不会重复处理）。"""
        with self._save_lock:
            cur = self.load()
            if h in cur:
                if cur[h].get("status") == "cancelled" and t.get("status") != "cancelled":
                    t["status"] = "cancelled"          # 这一轮处理期间被 /cancel 了：以取消为准
                    return
                if cur[h].get("api_ts", 0) > t.get("api_ts", 0):
                    t.update(cur[h])                   # 这一轮处理期间被 API（retry/task_meta）改过：以 API 为准，本轮结果作废
                    return
                cur[h].update(t)
                self.save(cur)

    def _finish_traced(self, h: str, t: dict) -> None:
        before = t.get("status")
        with self.ctx(h, "strm"):
            if "strm_start" not in (t.get("ts") or {}):
                self.mark(t, "strm_start")
            self._finish_one(t, h)
            if t.get("status") != before:
                self.mark(t, "strm")
                self.event(h, "strm", f"生成 strm 完成：{t.get('status')}，{len(t.get('strm') or [])} 个 strm",
                           "info" if t.get("status") == "done" else "warn")

    def _finish_one(self, t: dict, h: str = "") -> None:
        """一个下载完成的任务：生成 strm、补字幕、通知 Emby、发通知。"""
        if "/待识别/" in t["dir"] + "/":
            if t.get("status") != "needs-id":
                t["status"], t["done"] = "needs-id", now()
                self.notify("❓ " + t["dir"].rsplit("/", 1)[-1],
                            "已下载到 115「待识别」，没有对应的 TMDb 条目，不会入库。请在影库 App 任务详情里「改为另一部」选定作品")
            return
        try:
            # 缓冲任务也要限定 scope（= 上传的顶层文件/目录）：不限定时整季目录都会套本任务的 ep_offset，
            # 药屋少女 S3（偏移 48）把同目录 S1/S2 的 48 集重编成 E49-96，还顶掉了真正的 S3E01/02（2026-10-13）
            ups = {n.split("/", 1)[0] for n in ((t.get("buffer") or {}).get("uploaded") or {})}
            scope = ups.pop() if t.get("buffer") and len(ups) == 1 else t.get("name")
            kind = (t.get("meta") or {}).get("kind")
            with self._dir_lock(t["dir"]):
                if kind in ADULT_KINDS and self.adult:
                    self._tl.replaced, self._tl.zero, self._tl.linked, self._tl.kept, self._tl.nvid = 0, [], 0, 0, 0
                    made = self.adult.finish(kind, t, scope, h)
                    self._tl.nvid = len(made)
                else:
                    made = self.make_strms(t["dir"], t.get("meta"), scope)
        except Exception as e:  # noqa: BLE001
            n = int(t.get("strm_errors") or 0) + 1
            t["strm_errors"] = n
            self.log(f"生成 strm 出错（第 {n} 次）{t['dir']}: {e}")
            if n >= self.STRM_MAX_ERRORS:
                # 不再每轮无限重试：标失败并通知，修好后在 App 或 mpctl retry 里重试
                t["status"] = "strm-failed"
                self.notify("❌ " + label(t["dir"]), f"生成 strm 连续失败 {n} 次，已停止重试：{e}")
            return
        replaced, zero = getattr(self._tl, "replaced", 0), getattr(self._tl, "zero", [])
        linked = getattr(self._tl, "linked", 0)
        kept = getattr(self._tl, "kept", 0)
        how = "NAS 缓冲上传" if t.get("buffer") else "115 离线"
        if not (made or linked or kept) and not getattr(self._tl, "nvid", 0) and not t.get("buffer") \
                and int(t.get("empty_rounds") or 0) < 6:
            t["empty_rounds"] = int(t.get("empty_rounds") or 0) + 1   # 115 刚完成时目录可能还列不出文件：下一轮再看
            return
        t["status"] = "done" if (made or linked) else "superseded" if kept else "no-video"
        kind = (t.get("meta") or {}).get("kind")
        if kind == "av" and made:
            t["status"] = "scraping"             # MDC 刮削 + 整理由 Adult.av_run 推进，完成后改 done
        if t["status"] == "no-video" and self.on_fail:
            self.failed(h, t, "no-video", "没有可入库的视频")
        elif t["status"] == "done" and self.on_ok:
            self.on_ok(h)                        # 重试后入库成功：解除拉黑
        t["done"] = t.get("done") or now()
        t["strm"] = (t.get("strm") or []) + [p[len(self.lib_ol) + 1:] for p in made]
        if not made:
            if not linked and not kept and not t.get("warned"):
                t["warned"] = now()
                self.notify("⚠️ " + label(t["dir"]), f"{how}完成，但没认出可入库的视频（集数解析失败？）")
            return
        if kind in ADULT_KINDS:
            t["strm"] = [p[len(self.lib_ol) + 1:] for p in made]
            self.event(h, "strm", ("已写入 MDC 收件箱：" if kind == "av" else "已生成 strm：") + "、".join(x.rsplit("/", 1)[-1] for x in made)[:200])
            return
        try:
            roots = sorted({p.rsplit("/Season ", 1)[0] if "/Season " in p else p.rsplit("/", 1)[0] for p in made})
            m = t.get("meta") or {}
            how_emby = self.emby.nudge([self.emby_path(p) for p in roots], "Tmdb" if m.get("tmdbid") else "", m.get("tmdbid"),
                                       "Movie" if m.get("type") == "电影" else "Series")
            self.event(h, "emby", "已让 Emby 刷新这一部" if how_emby == "refresh" else "已通知 Emby 扫描新目录")
        except Exception as e:  # noqa: BLE001
            self.log(f"通知 Emby 失败: {e}")
        msg = f"{how}完成，入库 {len(made)} 个文件"
        if replaced:
            msg += f"（替换旧版本 {replaced} 个）"
        if zero:
            msg += f"；另有 {len(zero)} 个第 0 集/超范围的集没入库，需要手动对应特别篇"
        self.notify("📦 " + label(t["dir"]), msg + "，等待 Emby 刮削…")
        # 补字幕（ffprobe + sub_share + 每集音轨比对）可能要几十分钟：放到后台单线程做，不占跟踪锁，结果另发通知
        self._subs_pool.submit(self._autosubs_bg, dict(t), list(made), h)

    def _autosubs_bg(self, t: dict, made: List[str], h: str = "") -> None:
        with self.ctx(h, "subs"):
            self.event(h, "subs", "开始检查字幕")
            try:
                note = self.autosubs(t, made)
            except Exception as e:  # noqa: BLE001
                note = f"；字幕检查出错：{e}"
            note = note.lstrip("；")
            self.event(h, "subs", note or "字幕检查完成，不需要补")
            if note:
                self.notify("🈶 " + label(t["dir"]), note)

    # ---------------- 定时推进 ----------------
    def _advance_offline(self, h: str, t: dict, info: Optional[dict], age: int, ready: List[str]) -> None:
        if info is None:
            if age > LOST_AFTER:
                self.buffer_start(h, t, "115 任务列表里找不到")
            elif not t.get("ev_missing"):
                t["ev_missing"] = 1
                self.event(h, "offline", "115 离线列表里暂时找不到这个任务", "warn")
            if age > STALL_HINT and not t.get("stalled"):
                t["stalled"] = now()
                self.notify("⏳ " + label(t["dir"]), f"115 离线列表里找不到这个任务（已 {int(age / 60)} 分钟）。可在影库 App 任务详情里"
                                                     f"「改用 NAS 缓冲」或「换一个资源」；{LOST_AFTER // 86400} 天后会自动改用 NAS 缓冲")
            return
        old = int(t.get("percent") or 0)
        t["percent"], t["name"] = info.get("percentDone"), info.get("name")
        new = int(t.get("percent") or 0)
        if new // 25 > old // 25 or (new and not old):
            self.event(h, "offline", f"115 离线进度 {new}%（{info.get('name') or ''}）"[:200])
        if info.get("status") == -1:
            self.c115.task_del(h)
            self.buffer_start(h, t, "115 离线失败")
        elif info.get("status") != 2:
            if t.get("percent"):
                t.pop("stalled", None)
            elif age > STALL_HINT and not t.get("stalled"):
                t["stalled"] = now()
                why = "还没拿到种子信息" if not info.get("size") else "没有下载进度"
                self.event(h, "offline", f"115 离线 {int(age / 60)} 分钟仍是 0%（{why}）", "warn")
                self.notify("⏳ " + label(t["dir"]), f"115 离线 {int(age / 60)} 分钟仍是 0%（{why}）。可在影库 App 任务详情里"
                                                     f"「改用 NAS 缓冲」或「换一个资源」；{STALL_AFTER // 3600} 小时后会自动改用 NAS 缓冲")
            if not t.get("percent") and age > STALL_AFTER:
                self.c115.task_del(h)
                self.buffer_start(h, t, f"115 离线 {int(age / 3600)} 小时仍是 0%")
        else:
            if "offline" not in (t.get("ts") or {}):
                self.mark(t, "offline")
                self.event(h, "offline", "115 离线下载完成")
            ready.append(h)

    def run(self) -> None:
        tasks = self.load()
        active = {h: t for h, t in tasks.items()
                  if t.get("status") in ("downloading", "buffer", "uploaded") or (t.get("status") == "done" and not t.get("emby"))}
        if not active:
            return
        pending = {h: t for h, t in active.items() if t["status"] == "downloading"}
        tl = self.c115.tasks() if pending else {}
        ready = []
        for h, t in pending.items():
            info = tl.get(h)
            age = now() - t["added"]
            with self.ctx(h, "offline"):
                try:
                    self._advance_offline(h, t, info, age, ready)
                except Exception as e:  # noqa: BLE001
                    self.log(f"推进出错 {t['dir']}: {e}")
        buffered = self.buffer_run(tasks)
        ready += [h for h, t in tasks.items() if t.get("status") == "uploaded"]
        with ThreadPoolExecutor(max_workers=4, thread_name_prefix="p115-strm") as pool:
            list(pool.map(lambda h: (self._finish_traced(h, tasks[h]), self._persist(h, tasks[h])), ready))
        for h in set(pending) | set(buffered):
            self._persist(h, tasks[h])          # 进度/缓冲状态（缓冲任务的上传进度、too-big/dead 也要落盘，否则每轮重来）
        # 刮削确认由 Emby 推送驱动（App 后端转发 LibraryChanged → /hub/emby/changed → 插件 _on_emby_items），
        # 这里不轮询 Emby，只处理超时：入库 3 小时还没确认就标失败，让人在 App 里处理
        for h, t in tasks.items():
            if t.get("status") == "done" and not t.get("emby") and now() - (t.get("done") or now()) > EMBY_GIVEUP:
                t["emby"] = -now()
                with self.ctx(h, "emby"):
                    self.event(h, "emby", "入库 3 小时 Emby 还没刮削（没收到 Emby 推送），请在 App 里重新生成 strm 并刮削", "error")
                    self.notify("⚠️ " + label(t["dir"]), "入库 3 小时 Emby 还没刮削，请在影库 App 任务详情里处理")
                self._persist(h, t)
        # 不整表回写：本轮开头读的是旧快照，回写会把期间 API（cancel/retry/override）的改动盖掉
