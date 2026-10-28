"""AV 与里番入库。

AV：番号或磁力 → 115 离线到 /115/Emby/下载 → 在 媒体库/AV/download 写 <番号>.strm → 调 MDC 后端 API
    （MDC 容器，需与 MoviePilot 同一 docker 网络）刮削 → MDC 把 strm 挪进 AV/library/<演员>/<番号>/ 并写 NFO/图
    → 本模块按 MDC 任务结果把 115 上的原片挪到 /115/Emby/AV/<演员>/<番号>/ 并改写 strm → 通知 Emby。
    MDC 需要读写 AV 库目录（与 OpenList 本地存储是同一份文件，挂载方式因部署而异）。
里番：追更目录（catalog）+ sukebei RSS（Art-Anime 分类）→ 115 离线到 /115/Emby/里番/<目录>/Season 1
    → 115 完成后写 媒体库/里番/<Bangumi 中文名> [bangumiid=N]/Season 1/<名> S01Exx.strm → Emby 的 Bangumi 插件刮削。
    Bangumi 识别经 Emby 的 RemoteSearch（Emby Bangumi 插件已授权老账号，能搜到 NSFW 条目），不写任何 NFO。

状态在插件数据：av（stubbed/submitted）、hentai（与旧 hentai-state.json 同结构）、hentai_catalog。
由插件服务 Prowlarr115Adult 每 5 分钟推进；RSS 每 30 分钟，catalog 全量搜索每天一次（只搜没齐的系列）。
"""
import difflib
import re
import threading
import time
import unicodedata
import urllib.parse
import xml.etree.ElementTree as ET
from typing import Any, Callable, Dict, List, Optional, Tuple

from app.sdk.network import RequestUtils

from .clients import ClientError, UA, now

try:   # 繁→简（Bangumi 中文名是简体，hanime1 的中文名是繁体）；没装时退回原文比较
    from zhconv import convert as _zhconv
except Exception:  # noqa: BLE001
    def _zhconv(s: str, _: str) -> str:
        return s

VIDEO = (".mp4", ".mkv", ".avi", ".wmv", ".mov", ".ts", ".m2ts", ".webm", ".flv", ".rmvb", ".iso", ".m4v")
MIN_AV = 100e6
MIN_HENTAI = 50e6
TRACKERS = "&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=http%3A%2F%2Fsukebei.tracker.wf%3A8888%2Fannounce"
SUKEBEI = "https://sukebei.nyaa.si/?page=rss&f=0"
NS = {"nyaa": "https://sukebei.nyaa.si/xmlns/nyaa"}
CAT_ANIME, CAT_REAL = "1_1", "2_2"         # sukebei：Art - Anime / Real Life - Videos
RSS_EVERY, SEARCH_EVERY, FIX_EVERY, BGM_RETRY = 1800, 86400, 6 * 3600, 86400
MDC_RETRIGGER = 1800                       # 提交给 MDC 后 30 分钟还没有结果就再提交一次
MATCH_MIN = 0.8
_SUKEBEI_SEM = threading.BoundedSemaphore(1)

CODE_RX = re.compile(r"(?<![A-Z0-9])([A-Z]{2,6})-?(\d{2,5})(?![0-9])")
CODE_ONLY = re.compile(r"^\s*[A-Za-z]{2,6}-?\d{2,5}\s*$")
# AV：强暴/迷奸/轮奸类、未成年相关不入库（与 media-service jable_hot_ingest 一致）
AV_REJECT = re.compile(r"レ.?[×●〇]?プ|レイプ|強姦|强奸|輪[●〇×姦]|睡姦|昏睡|ロリ|ショタ|幼女|幼[児少稚齢]|小学|中学|\bJS\b|\bJC\b|"
                       r"未成年|(?<![大留])学生|女子校生|女子[●〇]生|制服少女", re.I)
CN_SUB = re.compile(r"中文字幕|中字|[-_](?:C|UC|CH)(?![A-Za-z0-9])|\[ch\]|-ch\b", re.I)

# ---------------- 里番标题解析（与旧 hentai115.py 相同） ----------------
EP_RX = [
    re.compile(r"^\[\d+\]\[\d+\]\[.+?\]\s*(.+?)\s+第(\d+)話"),
    re.compile(r"^\[\d+\]\[\d+\]\[.+?\]\s*(.+?)(?:\s*\[|\s*$)"),
    re.compile(r"^\[.+?\]\s*(?:[^/\[]*?/\s*)?(.+?)\s*-\s*(\d+)\s*(?:\[|v\d|$)"),
    re.compile(r"^\[.+?\]\s*(.+?)(?:\s*\[|\s*$)"),
    re.compile(r"^(.+?)\s+第(\d+)話"),
]
EP_RX.insert(3, re.compile(r"^\[.+?\]\s*(.+?)\s+第[〇一二三四五六七八九十]{1,3}[話巻]"))   # [KyokuSai] 勇者姫ミリア 第三話 …
JUNK_RX = re.compile(
    r"同人誌|同人CG|同人アニメ|漫画|Manga|Pictures|Photobook|\bVR\b|VR180|ASMR|\bJOI\b|\bSFM\b|\bMMD\b|Blender|"
    r"\[RJ\d+\]|\[d_\d+\]|\bKoikatsu\b|\bHoney\s*Select\b|ボイコミ|モーションコミック|ボイス付き", re.I)
JAV_RX = re.compile(r"\b[A-Z]{2,6}-\d{3,5}(?![\dp])|\d{3,4}[A-Z]{2,5}-\d{3,5}|4k2\.com|_FHD_CH|\[8KVR\]|Reducing Mosaic", re.I)
LIVE_RX = re.compile(r"短剧|国产|探花|主播|自拍|偷拍|良家|网红|骚妇|约炮|直播录屏|byg666|52746770")
MINOR_RX = re.compile(r"ロリ|loli|ショタ|shota|幼女|園児|小学生|\bJS\b", re.I)
VOL_RX = re.compile(r"\s*(?:第\s*(\d+|[〇一二三四五六七八九十]{1,3})\s*[巻話章]|(\d+)\s*時限目|\bVol\.?\s*(\d+)|[＃#]\s*(\d+))(?:\s.*)?$", re.I)
HENTAI_STUDIOS = re.compile(
    r"ピンクパイナップル|Pink Pineapple|エイ・ワン・シー|a1c|ショーテン|PoRO|collaborationworks|Queen Bee|nur|MS Pictures|"
    r"Mary Jane|EDGE|BOMB!\s*CUTE!\s*BOMB!|Lune|GREEN BUNNY|イメージ・ハウス|Milky|DISCOVERY|テイジイエル|T-Rex|バニラ|Vanilla|"
    r"SugarBoy|アームス|Arms|セルメイト|CherryLips|チェリーリップス|pixy|ひまじん|Himajin|ZIZ|じゅうしぃまんご|Juicy Mango", re.I)
SEP = " 　~〜～・-－:：!！?？「『(（[【"


def safe(name: str) -> str:
    return re.sub(r'[\\/:*?"<>|]', " ", name or "").strip()


def rejected(text: str) -> bool:
    return bool(JAV_RX.search(text) or LIVE_RX.search(text) or MINOR_RX.search(text))


def split_vol(title: str) -> Tuple[str, Optional[int]]:
    """'性活週間 THE ANIMATION 第2巻' -> ('性活週間 THE ANIMATION', 2)"""
    m = VOL_RX.search(title or "")
    if m and m.start() > 0:
        g = next(g for g in m.groups() if g)
        return title[:m.start()].strip(), int(g) if g.isdigit() else _kanji_num(g)
    return (title or "").strip(), None


_KANJI = {c: i for i, c in enumerate("〇一二三四五六七八九", 0)}


def _kanji_num(s: str) -> Optional[int]:
    """一〜九十九：「三」=3、「十二」=12、「二十」=20。"""
    if not s or any(c not in _KANJI and c != "十" for c in s):
        return None
    if "十" not in s:
        return int("".join(str(_KANJI[c]) for c in s))
    a, _, b = s.partition("十")
    return (_KANJI[a] if a else 1) * 10 + (_KANJI[b] if b else 0)


def file_ep(name: str) -> Optional[int]:
    m = re.search(r"第\s*([〇一二三四五六七八九十]{1,3})\s*[巻話章]", name or "")   # 「第三話」（KyokuSai 等）
    if m and _kanji_num(m.group(1)):
        return _kanji_num(m.group(1))
    for rx in (r"第\s*(\d+)\s*[巻話]", r"(\d+)\s*時限目", r"\s-\s(\d{1,3})(?:v\d)?(?:\s|\[|\(|\.|$)",
               r"\b(?:EP?|Episode|Vol(?:ume)?)[\s._-]*(\d{1,3})\b", r"\[(\d{1,2})\]", r"_(\d{1,2})_"):
        m = re.search(rx, name, re.I)
        if m:
            return int(m.group(1))
    return None


def parse_release(raw: str) -> Tuple[Optional[str], Optional[int]]:
    raw = (raw or "").strip()
    if re.match(r"^\(同人|^\(C\d", raw) or JUNK_RX.search(raw) or rejected(raw):
        return None, None
    for rx in EP_RX:
        m = rx.search(raw)
        if m:
            title = re.sub(r"\s*(?:The Animation|Animation|OVA|BD|Blu-?ray).*$", "", m.group(1).strip(), flags=re.I).strip()
            title = re.sub(r"\s*\d+p$", "", title, flags=re.I).strip()
            if len(title) >= 2:
                return title, int(m.group(2)) if m.lastindex >= 2 else 1
    return None, None


def norm(t: str) -> str:
    t = _zhconv(unicodedata.normalize("NFKC", t or "").lower(), "zh-cn")
    t = re.sub(r"the animation|animation|\bova\b", "", t)
    return re.sub(r"[\s\W_]+", "", t)


def score(q: str, names: List[str]) -> float:
    """标题相似度 0..1：相同=1；以查询词开头后接分隔符（副标题）=0.9；后接数字视为续作；互相包含（≥3 字）=0.8。"""
    qr = _zhconv(unicodedata.normalize("NFKC", q or "").strip().lower(), "zh-cn")
    qn, best = norm(q), 0.0
    for raw in names:
        nr = _zhconv(unicodedata.normalize("NFKC", raw or "").strip().lower(), "zh-cn")
        n = norm(raw)
        if not qn or not n:
            continue
        if qn == n:
            return 1.0
        r = difflib.SequenceMatcher(None, qn, n).ratio()
        for a, b in ((nr, qr), (qr, nr)):
            if b and a.startswith(b):
                rest = a[len(b):]
                if rest[:1].isdigit():
                    r = min(r, 0.5)
                elif rest[:1] in SEP or rest.strip().startswith("the animation"):
                    r = max(r, 0.9)
        short = min(qn, n, key=len)
        if len(short) >= 3 and (qn in n or n in qn) and not re.search(re.escape(short) + r"\d", max(qn, n, key=len)):
            r = max(r, 0.8)
        best = max(best, r)
    return best


def av_code(name: str) -> Optional[str]:
    """文件名/标题里的番号，规范成大写带横线（489155.com@DLDSS-537-U -> DLDSS-537）。"""
    s = re.sub(r"^.*@", "", name or "").upper()
    s = re.sub(r"\b(?:1080P|720P|2160P|4K|FHD|HD|X26[45]|H26[45]|HEVC)\b", " ", s)
    m = CODE_RX.search(s)
    return f"{m.group(1)}-{m.group(2).zfill(3)}" if m else None


def _ts(iso: Any) -> float:
    from datetime import datetime
    try:
        return datetime.fromisoformat(str(iso)).timestamp()
    except ValueError:
        return 0


def magnet(ihash: str) -> str:
    return f"magnet:?xt=urn:btih:{ihash}{TRACKERS}"


class Adult:
    """AV + 里番。pipe 是插件的 Pipeline（OpenList / 115 / qB / Emby 客户端）。"""

    def __init__(self, pipe: Any, conf: Dict[str, Any], get_data: Callable[[str], Any], save_data: Callable[[str, Any], None],
                 notify: Callable[[str, str], None], log: Callable[[str], None]):
        self.p, self.c = pipe, conf
        self.ol, self.c115, self.emby = pipe.ol, pipe.c115, pipe.emby
        self.get_data, self.save_data, self.notify, self.log = get_data, save_data, notify, log
        self.mdc = str(conf.get("mdc_url") or "http://mdc:9207").rstrip("/")
        self.root, self.lib = pipe.root, pipe.lib_ol
        self.remote_dl, self.remote_av, self.remote_h = f"{self.root}/下载", f"{self.root}/AV", f"{self.root}/里番"
        self.av_dl, self.av_lib, self.h_lib = f"{self.lib}/AV/download", f"{self.lib}/AV/library", f"{self.lib}/里番"
        self.emby_root = conf.get("emby_lib_root") or "/media/library"
        self.bgm_token = str(conf.get("bangumi_token") or "")
        self._state_lock = threading.RLock()
        self._h_lib_id: Optional[str] = None

    # ---------------- 公共 ----------------
    def run(self) -> None:
        """服务入口（每 5 分钟）。各段互不影响。"""
        for name, fn in (("AV", self.av_run), ("里番 RSS", self.rss_poll), ("里番搜索", self.ingest),
                         ("里番入库", self.scan), ("里番 Emby 纠正", self.emby_fix)):
            try:
                fn()
            except Exception as e:  # noqa: BLE001
                self.log(f"{name} 出错：{e}")

    def offline(self, remote_dir: str, link: str) -> Tuple[bool, str]:
        """提交 115 离线到 remote_dir（115 API 建目录；OpenList 对 115 mkdir 会卡）。和影视下载共用串行锁。"""
        with self.p._submit_lock:
            err = ""
            for wait in (1, 3, 6):
                time.sleep(wait)
                try:
                    cid = self.c115.mkdir_p(remote_dir[len("/115"):] if remote_dir.startswith("/115/") else remote_dir)
                    ok, err = self.c115.offline_add(link, cid)
                    if ok:
                        return True, ""
                except ClientError as e:
                    err = str(e)
                if "无响应" not in err and "非 JSON" not in err:
                    break
            return False, err

    def sukebei(self, q: str = "", cat: str = CAT_ANIME) -> List[dict]:
        """sukebei RSS（直连，全局串行 + 429 退避）。返回 [{title, hash, size, seeders, cat}]。"""
        url = f"{SUKEBEI}&c={cat}" + (f"&q={urllib.parse.quote(q)}" if q else "")
        with _SUKEBEI_SEM:
            for wait in (0, 5, 15):
                time.sleep(wait or 1.2)
                res = RequestUtils(headers={"User-Agent": UA}, timeout=30).get_res(url)
                if res is not None and res.status_code == 200:
                    break
            else:
                raise ClientError(f"sukebei {getattr(res, 'status_code', '无响应')}：{q[:30]}")
        out = []
        for it in ET.fromstring(res.content).findall(".//item"):
            m = re.match(r"([\d.]+)\s*(GiB|MiB|KiB)", it.findtext("nyaa:size", "", NS) or "")
            size = float(m.group(1)) * {"GiB": 1 << 30, "MiB": 1 << 20, "KiB": 1 << 10}[m.group(2)] if m else 0
            out.append({"title": it.findtext("title", ""), "hash": (it.findtext("nyaa:infoHash", "", NS) or "").lower(),
                        "size": size, "seeders": int(it.findtext("nyaa:seeders", "0", NS) or 0),
                        "cat": it.findtext("nyaa:categoryId", "", NS), "pub": it.findtext("pubDate", "")})
        return out

    def status(self) -> dict:
        av, h = self.get_data("av") or {}, self.get_data("hentai") or {}
        st = av.get("stubbed") or {}
        return {"av_pending": [dict(v, remote=k) for k, v in st.items()],
                "av_recent": sorted((av.get("done") or [])[-20:], key=lambda x: -x.get("at", 0)),
                "hentai_series": len(h.get("downloaded") or {}),
                "hentai_eps": sum(len(v.get("episodes") or {}) for v in (h.get("downloaded") or {}).values()),
                "catalog": len((self.get_data("hentai_catalog") or {}).get("series") or []),
                "last_rss": h.get("last_rss"), "last_search": h.get("last_search")}

    # ================= AV =================
    def av_pick(self, code: str) -> Optional[dict]:
        """按番号在 sukebei 真人区挑一个：FHD 且 ≤9G > 720p/MP4 > 其他；中文字幕加分；同级比做种。"""
        best = None
        for r in self.sukebei(code, CAT_REAL):
            t, gb = r["title"], r["size"] / 1e9
            if len(r["hash"]) != 40 or av_code(t) != code or AV_REJECT.search(t) or r["seeders"] < 1:
                continue
            if "Reducing Mosaic" in t or gb < 0.8:
                continue
            rank = 3 if re.search(r"FHD|1080", t, re.I) and gb <= 9 else 2 if re.search(r"720p|MP4", t, re.I) else 1
            key = (rank, bool(CN_SUB.search(t)), r["seeders"])
            if best is None or key > best[0]:
                best = (key, r)
        return best[1] if best else None

    def av_have(self) -> set:
        """Emby AV 库、收件箱里已有的和已提交过的番号。"""
        have = set()
        try:
            lib = next(f["ItemId"] for f in self.emby.get("/Library/VirtualFolders") or [] if f.get("Name") == "AV")
            items = (self.emby.get("/Items", ParentId=lib, Recursive="true", IncludeItemTypes="Movie", Fields="Path") or {}).get("Items")
            have |= {av_code((i.get("Path") or "").rsplit("/", 1)[-1]) for i in items or []}
            have |= {av_code(i["name"]) for i in self.ol.list(self.av_dl)}
        except (StopIteration, ClientError):
            pass
        av = self.get_data("av") or {}
        return (have | set(av.get("submitted") or {}) | {v.get("code") for v in (av.get("stubbed") or {}).values()}) - {None}

    def av_add(self, items: List[str], dry_run: bool = False, force: bool = False) -> List[dict]:
        """番号或磁力 → 115 离线到 /115/Emby/下载（之后 av_run 接手）。"""
        out, have = [], (set() if force else self.av_have())
        for raw in [x.strip() for x in items if x and x.strip()]:
            r: Dict[str, Any] = {"item": raw}
            if raw.startswith("magnet:") or re.fullmatch(r"[0-9a-fA-F]{40}", raw):
                link, code = raw if raw.startswith("magnet:") else magnet(raw.lower()), None
            else:
                code = av_code(raw)
                if not code:
                    out.append(dict(r, ok=False, error="认不出番号"))
                    continue
                if code in have:
                    out.append(dict(r, ok=False, code=code, error="已有或已提交"))
                    continue
                try:
                    pick = self.av_pick(code)
                except ClientError as e:
                    out.append(dict(r, ok=False, code=code, error=str(e)))
                    continue
                if not pick:
                    out.append(dict(r, ok=False, code=code, error="sukebei 没有合适的资源"))
                    continue
                link = magnet(pick["hash"])
                r.update(title=pick["title"], size_gb=round(pick["size"] / 1e9, 1), seeders=pick["seeders"])
            r["code"] = code
            if dry_run:
                out.append(dict(r, ok=True, dry_run=True))
                continue
            ok, err = self.offline(self.remote_dl, link)
            out.append(dict(r, ok=ok, **({"error": err} if err else {})))
            if ok:
                with self._state_lock:
                    av = self.get_data("av") or {}
                    av.setdefault("submitted", {})[code or link[20:60]] = {"at": now(), "link": link[:80]}
                    self.save_data("av", av)
                if code:
                    have.add(code)
            self.log(f"AV 提交 {code or raw[:50]}：{'OK' if ok else err}")
        return out

    def _qb_handoff(self) -> None:
        """兼容：qB 分类 av / 115av 的任务转交 115 离线（media-service 的 jable 热榜入库还用它）。"""
        if not self.p.qb:
            return
        for cat in ("115av", "av"):
            for t in self.p.qb.get("/api/v2/torrents/info", {"category": cat}) or []:
                ok, err = self.offline(self.remote_dl, t.get("magnet_uri") or magnet(t["hash"]))
                if ok:
                    self.p.qb.post("/api/v2/torrents/delete", {"hashes": t["hash"], "deleteFiles": "true"})
                    self.log(f"qB {cat} → 115：{t.get('name', '')[:60]}")

    def _mdc(self, method: str, path: str, body: Optional[dict] = None) -> Any:
        ru = RequestUtils(content_type="application/json", timeout=60)
        res = ru.post_res(f"{self.mdc}{path}", json=body) if method == "POST" else ru.get_res(f"{self.mdc}{path}")
        if res is None or res.status_code != 200:
            raise ClientError(f"MDC {path}: {getattr(res, 'status_code', '无响应')} {getattr(res, 'text', '')[:80]}")
        try:
            return res.json()
        except ValueError:
            return res.text

    def mdc_scrape(self, names: List[str]) -> None:
        """让 MDC 刮削 AV/download 里的这些 strm（MDC 后端 REST，等同网页「手动任务」）。"""
        self._mdc("POST", "/api/manual-jobs", {
            "pathes": [f"/media/download/{n}" for n in names], "target_folder": "/media/library", "link_mode": 0,
            "delete_empty_parent_after_move": False, "ts_id": str(int(time.time() * 1000)), "copy_config_from": None})

    def av_run(self) -> None:
        self._qb_handoff()
        with self._state_lock:
            av = self.get_data("av") or {}
        st = av.setdefault("stubbed", {})
        changed = False
        new: List[str] = []
        try:
            # 1. 115 下载目录里新完成的视频 -> AV/download/<番号>.strm
            if self.ol.get(self.remote_dl):
                for remote, it in self.ol.walk(self.remote_dl):
                    if remote in st or not remote.lower().endswith(VIDEO) or it.get("size", 0) < MIN_AV:
                        continue
                    base = remote.rsplit("/", 1)[1].rsplit(".", 1)[0]
                    code = av_code(base)
                    name = (code + ("-C" if CN_SUB.search(base) else "") if code else re.sub(r"^.*@", "", base)) + ".strm"
                    if any(v.get("name") == name for v in st.values()):
                        name = f"{name[:-5]}-{len(st)}.strm"
                    self.p._write_strm(f"{self.av_dl}/{name}", remote)
                    st[remote] = {"name": name, "code": code, "at": now(), "status": "new"}
                    new.append(name)
                    changed = True
                    self.log(f"AV 115 完成 → {name}")
            # 2. 交给 MDC：新的（含上次没交成功的），以及提交 30 分钟还没出结果的。
            #    只交收件箱里真有的 strm：MDC 遇到一个不存在的路径会拒绝整批（JUR-748 卡死过整条 AV 流水线）。
            todo = [v["name"] for v in st.values()
                    if (v.get("status") == "new" and now() - v.get("job", 0) > 300)
                    or (v.get("status") == "scraping" and now() - v.get("job", 0) > MDC_RETRIGGER)]
            if todo:
                inbox = {i["name"] for i in self.ol.list(self.av_dl, refresh=True)}
                for v in st.values():
                    if v["name"] in todo and v["name"] not in inbox:
                        v.update(status="missing", err="收件箱里没有这个 strm（可能已整理、改名或被删）")
                        self.log(f"AV {v['name']} 不在收件箱，标为 missing")
                        changed = True
                todo = sorted({n for n in todo if n in inbox})
            if todo:
                try:
                    self.mdc_scrape(todo)
                    for v in st.values():
                        if v["name"] in todo:
                            v.update(status="scraping", job=now(), err=None)
                except ClientError as e:   # 交不上：记下原因，5 分钟后再试，不影响其余步骤
                    for v in st.values():
                        if v["name"] in todo:
                            v.update(job=now(), err=f"提交 MDC 失败：{e}"[:200])
                    self.log(f"AV 提交 MDC 失败：{e}")
                changed = True
            # 3. 按 MDC 任务结果整理 115 原片
            if any(v.get("status") == "scraping" for v in st.values()):
                tasks = (self._mdc("GET", "/api/tasks?page=1&page_size=200") or {}).get("data") or []
                latest: Dict[str, dict] = {}
                for t in tasks:
                    if t.get("id", 0) > latest.get(t.get("source_path"), {}).get("id", -1):
                        latest[t.get("source_path")] = t
                for remote, v in list(st.items()):
                    t = latest.get(f"/media/download/{v['name']}")
                    # 同名旧任务（以前刮过同一个文件名）不算：只认 strm 写出之后创建的任务
                    if v.get("status") != "scraping" or not t or _ts(t.get("created_at")) < v.get("at", 0) - 120:
                        continue
                    if t.get("status") == 2 and t.get("target_path"):
                        try:
                            self._organise(remote, v, t)
                            st.pop(remote)
                            av.setdefault("done", []).append({"code": v.get("code"), "target": t["target_path"], "at": now()})
                            av["done"] = av["done"][-200:]
                        except ClientError as e:
                            v["err"] = f"整理失败：{e}"[:200]
                            self.log(f"AV 整理失败 {v['name']}：{e}")
                        changed = True
                    elif t.get("status") == -1 and v.get("err") != t.get("error_message"):
                        v.update(status="failed", err=t.get("error_message"))
                        self.notify("⚠️ AV 刮削失败", f"{v['name']}：{t.get('error_message')}（改名后 /av/retry，或在 MDC 网页手动处理）")
                        changed = True
        finally:
            # 无论哪一步出错都要落盘：没存住 stubbed 的话下一轮会把同一个文件重新当新文件处理
            if changed:
                with self._state_lock:
                    cur = self.get_data("av") or {}
                    cur["stubbed"], cur["done"] = st, av.get("done") or cur.get("done") or []
                    self._prune_submitted(cur, new_remotes=[r for r, v in st.items() if v["name"] in new])
                    self.save_data("av", cur)

    def _prune_submitted(self, av: dict, new_remotes: Optional[List[str]] = None) -> None:
        """submitted 只表示「115 离线中」：已生成 strm / 已入库的去掉；磁力提交的按 115 任务名对上新文件再去掉；超过 14 天的也去掉。"""
        sub = av.setdefault("submitted", {})
        seen = {v.get("code") for v in (av.get("stubbed") or {}).values()} | {d.get("code") for d in av.get("done") or []}
        names: Dict[str, dict] = {}
        if new_remotes and any(not av_code(k) for k in sub):
            try:
                names = self.c115.tasks(3)
            except ClientError:
                names = {}
        for k, v in list(sub.items()):
            h = (re.search(r"btih:([0-9a-fA-F]{40})", v.get("link") or "") or [None, ""])[1].lower()
            nm = (names.get(h) or {}).get("name") or ""
            if k in seen or now() - v.get("at", 0) > 14 * 86400 or (nm and any(f"/{nm}" in r for r in new_remotes or [])):
                sub.pop(k)

    def av_cancel(self, key: str, files: bool = False) -> dict:
        """取消/删除一条 AV 记录。key：submitted 的番号或 hash、stubbed 的 115 路径、done:<番号>:<时间>。
        files=True 时连 115 上已下好的文件一起删（不动已入库的 AV/library；删库里的作品用媒体库管理）。"""
        out: Dict[str, Any] = {"ok": False, "removed": [], "files": []}
        with self._state_lock:
            av = self.get_data("av") or {}
            sub, st, done = av.setdefault("submitted", {}), av.setdefault("stubbed", {}), av.setdefault("done", [])
            if key in sub:
                v = sub.pop(key)
                h = (re.search(r"btih:([0-9a-fA-F]{40})", v.get("link") or "") or [None, ""])[1].lower()
                name = ""
                if h:
                    try:
                        name = (self.c115.tasks(3).get(h) or {}).get("name") or ""
                        self.c115.task_del(h)
                    except ClientError as e:
                        out["warn"] = f"删 115 离线任务失败：{e}"
                if files and name and self.ol.get(f"{self.remote_dl}/{name}"):
                    self.ol.remove(self.remote_dl, [name])
                    out["files"].append(f"{self.remote_dl}/{name}")
                out["removed"].append(key)
            elif key in st:
                v = st.pop(key)
                try:
                    if self.ol.get(f"{self.av_dl}/{v['name']}"):
                        self.ol.remove(self.av_dl, [v["name"]])
                except ClientError:
                    pass
                if files and key.startswith(self.remote_dl + "/") and self.ol.get(key):
                    d, n = key.rsplit("/", 1)
                    self.ol.remove(d, [n])
                    out["files"].append(key)
                    if d != self.remote_dl and all(i.get("size", 0) < MIN_AV for _, i in self.ol.walk(d)):
                        parent, folder = d.rsplit("/", 1)
                        self.ol.remove(parent, [folder])
                        out["files"].append(d)
                out["removed"].append(v.get("code") or v["name"])
            elif key.startswith("done:"):
                _, code, at = (key.split(":", 2) + ["", ""])[:3]
                keep = [d for d in done if not (str(d.get("code")) == code and str(d.get("at")) == at)]
                if len(keep) != len(done):
                    av["done"] = keep
                    out["removed"].append(code)
            if out["removed"]:
                self.save_data("av", av)
                out["ok"] = True
                self.log(f"AV 取消 {key[-60:]}：{out}")
            else:
                out["error"] = "没有找到这条 AV 记录"
        return out

    def _organise(self, remote: str, v: dict, t: dict) -> None:
        """MDC 已把 strm 挪到 /media/library/<演员>/<番号>/<番号>.strm：115 原片挪到 /115/Emby/AV/<演员>/<番号>/ 并改写 strm。"""
        rel = t["target_path"][len("/media/library/"):]
        rel_dir, stem = rel.rsplit("/", 1)[0], rel.rsplit("/", 1)[1].rsplit(".", 1)[0]
        dst_dir = f"{self.remote_av}/{rel_dir}"
        new_name = stem + "." + remote.rsplit(".", 1)[1]
        src_dir, src_name = remote.rsplit("/", 1)
        self.c115.mkdir_p(dst_dir[len("/115"):])
        self.ol.refresh_path(dst_dir)
        if src_name != new_name:
            self.ol.rename(remote, new_name)
        self.ol.move(src_dir, dst_dir, [new_name])
        new_remote = f"{dst_dir}/{new_name}"
        self.ol.refresh_path(new_remote)
        self.p._write_strm(f"{self.av_lib}/{rel}", new_remote)
        try:   # MDC 经 sshfs 用硬链接整理，收件箱里会留一份同名 strm，不删的话每轮都被重新刮削
            if self.ol.get(f"{self.av_dl}/{v['name']}"):
                self.ol.remove(self.av_dl, [v["name"]])
        except ClientError:
            pass
        if src_dir != self.remote_dl:   # 种子目录里只剩小文件（广告、截图）就删掉
            rest = list(self.ol.walk(src_dir))
            if all(i.get("size", 0) < MIN_AV for _, i in rest):
                parent, folder = src_dir.rsplit("/", 1)
                self.ol.remove(parent, [folder])
        try:
            self.emby.updated([f"{self.emby_root}/AV/library/{rel_dir}"])
        except Exception:  # noqa: BLE001
            pass
        self.log(f"AV 入库 {new_remote}")
        self.notify("🔞 AV 入库", f"{v.get('code') or stem} → AV/{rel_dir}")

    def av_retry(self, name: str = "") -> int:
        """把刮削失败（或指定名字）的 AV 重新交给 MDC。"""
        with self._state_lock:
            av = self.get_data("av") or {}
            n = 0
            for v in (av.get("stubbed") or {}).values():
                if (name and v["name"] == name) or (not name and v.get("status") == "failed"):
                    v.update(status="scraping", job=0, err=None)
                    n += 1
            self.save_data("av", av)
        return n

    # ================= 里番 =================
    def _h(self) -> dict:
        return self.get_data("hentai") or {"downloaded": {}, "seen_hashes": []}

    def _h_save(self, h: dict) -> None:
        h["seen_hashes"] = (h.get("seen_hashes") or [])[-4000:]
        self.save_data("hentai", h)

    def catalog(self) -> dict:
        return self.get_data("hentai_catalog") or {"series": []}

    def hentai_lib_id(self) -> str:
        if not self._h_lib_id:
            folders = self.emby.get("/Library/VirtualFolders") or []
            self._h_lib_id = next(f["ItemId"] for f in folders if f.get("Name") == "里番")
        return self._h_lib_id

    def bgm_identify(self, *titles: str) -> Optional[dict]:
        """Bangumi 识别：有 bangumi_token 时直连 API（日文原名精确比较），否则经 Emby 的 Bangumi 插件 RemoteSearch
        （以里番库为锚点，插件带老账号授权能搜到 NSFW；结果只有中文名，按繁简转换后比较）。"""
        seen = set()
        for t in titles:
            t = re.sub(r"\s*\((?:19|20)\d\d\)\s*$", "", t or "").strip()
            if not t or t in seen:
                continue
            seen.add(t)
            try:
                cands = self._bgm_api(t) if self.bgm_token else self._bgm_emby(t)
            except Exception as e:  # noqa: BLE001
                self.log(f"里番 Bangumi 搜索出错 {t[:30]}：{e}")
                continue
            scored = sorted(((score(t, [c["name"], c["name_cn"]]), i, c) for i, c in enumerate(cands)),
                            key=lambda x: (-x[0], x[1]))
            if scored and scored[0][0] >= MATCH_MIN:
                return scored[0][2]
        return None

    def _bgm_api(self, keyword: str) -> List[dict]:
        res = RequestUtils(headers={"Authorization": "Bearer " + self.bgm_token, "User-Agent": "prowlarr115"},
                           content_type="application/json", timeout=30).post_res(
            "https://api.bgm.tv/v0/search/subjects?limit=10", json={"keyword": keyword, "filter": {"type": [2]}})
        data = (res.json() if res is not None and res.status_code == 200 else {}).get("data") or []
        return [{"id": s["id"], "name": s.get("name", ""), "name_cn": s.get("name_cn", ""), "date": s.get("date")} for s in data]

    def _bgm_emby(self, keyword: str) -> List[dict]:
        res = self.emby.post("/Items/RemoteSearch/Series", {"SearchInfo": {"Name": keyword}, "ItemId": self.hentai_lib_id(),
                                                            "SearchProviderName": "Bangumi"}) or []
        return [{"id": int(r["ProviderIds"]["Bangumi"]), "name": r.get("Name", ""), "name_cn": r.get("Name", ""),
                 "date": (r.get("PremiereDate") or "")[:10]} for r in res if (r.get("ProviderIds") or {}).get("Bangumi")]

    @staticmethod
    def lib_name(bgm: Optional[dict], fallback: str) -> str:
        return f"{safe(bgm['name_cn'] or bgm['name'])} [bangumiid={bgm['id']}]" if bgm else safe(fallback)

    def new_entry(self, downloaded: dict, key: str, *titles: str) -> dict:
        """取或建系列条目。名字对不上但 Bangumi ID 相同的（日文发布名 vs 繁中 catalog 名）用已有条目，记成别名。"""
        entry = downloaded.get(key)
        if entry is None:
            entry = next((v for v in downloaded.values() if key in (v.get("aliases") or [])), None)
        if entry is None:
            bgm = self.bgm_identify(*titles)
            same = next((v for v in downloaded.values() if bgm and (v.get("bgm") or {}).get("id") == bgm["id"]), None)
            if same is not None:
                same.setdefault("aliases", []).append(key)
                return same
            name = self.lib_name(bgm, key)
            entry = downloaded[key] = {"folder": name, "lib": name, "season": 1, "episodes": {}, "added": now(), "bgm_tried": now()}
            if bgm:
                entry["bgm"] = bgm
                self.log(f"里番 Bangumi {name} <- {' | '.join(t for t in titles if t)[:80]}")
        return entry

    @staticmethod
    def _key_of(downloaded: dict, entry: dict) -> str:
        return next(k for k, v in downloaded.items() if v is entry)

    @staticmethod
    def dedupe(downloaded: dict) -> int:
        """同一 Bangumi ID 的多个条目合并到最早的那个（集数并入，后来的名字记成别名）。"""
        by, n = {}, 0
        for k, v in sorted(downloaded.items(), key=lambda kv: kv[1].get("added", 0)):
            bid = (v.get("bgm") or {}).get("id")
            if not bid:
                continue
            if bid in by:
                keep = downloaded[by[bid]]
                for ep, e in (v.get("episodes") or {}).items():
                    keep.setdefault("episodes", {}).setdefault(ep, e)
                keep.setdefault("aliases", []).extend([k] + (v.get("aliases") or []))
                downloaded.pop(k)
                n += 1
            else:
                by[bid] = k
        return n

    def ensure_lib(self, entry: dict, *titles: str) -> str:
        """确定库目录；Bangumi 查不到的每天重试，查到后把已有 strm 搬进新目录（旧目录挪到 .hentai-relib-backup）。"""
        if entry.get("bgm") or (entry.get("lib") and now() - entry.get("bgm_tried", 0) < BGM_RETRY):
            return entry.setdefault("lib", entry["folder"])
        entry["bgm_tried"] = now()
        bgm = self.bgm_identify(*titles)
        new = self.lib_name(bgm, entry.get("lib") or entry["folder"])
        old = entry.get("lib")
        if bgm:
            entry["bgm"] = bgm
        if old and old != new and self.ol.get(f"{self.h_lib}/{old}"):
            self._move_lib(old, new)
        entry["lib"] = new
        return new

    def _move_lib(self, old: str, new: str) -> None:
        title = re.sub(r"\s*\[bangumiid=\d+\]$", "", new)
        for path, _ in list(self.ol.walk(f"{self.h_lib}/{old}")):
            m = re.search(r"S(\d+)E(\d+)\.strm$", path)
            if not m:
                continue
            dst_dir = f"{self.h_lib}/{new}/Season {int(m.group(1))}"
            dst_name = f"{title} S{m.group(1)}E{m.group(2)}.strm"
            if not self.ol.get(f"{dst_dir}/{dst_name}"):
                self.ol.mkdir(dst_dir)
                self.ol.put(f"{dst_dir}/{dst_name}", self.ol.read(path))
        backup = self.lib.rsplit("/", 1)[0] + "/.hentai-relib-backup"
        self.ol.mkdir(backup)
        stamped = f"{old}.{now()}"
        self.ol.rename(f"{self.h_lib}/{old}", stamped)
        self.ol.move(self.h_lib, backup, [stamped])
        self.log(f"里番改目录 {old} -> {new}")

    def existing_eps(self, lib: str) -> set:
        eps = set()
        try:
            for sd in self.ol.list(f"{self.h_lib}/{lib}"):
                if sd.get("is_dir") and sd["name"].startswith("Season"):
                    eps |= {int(m.group(1)) for x in self.ol.list(f"{self.h_lib}/{lib}/{sd['name']}")
                            for m in [re.search(r"E(\d+)\.strm$", x["name"])] if m}
        except ClientError:
            pass
        return eps

    def _catalog_titles(self, h: dict) -> set:
        titles = set()
        for s in self.catalog().get("series") or []:
            for key in ("title", "cn_title"):
                t = split_vol(s.get(key, ""))[0]
                if t:
                    titles.add(t.lower())
                    titles.add(re.sub(r"\s*(The Animation|Animation|OVA).*$", "", t, flags=re.I).strip().lower())
        for k, v in (h.get("downloaded") or {}).items():
            titles |= {k.lower(), (v.get("folder") or "").lower()}
        return titles - {""}

    @staticmethod
    def _in_catalog(series: str, titles: set) -> bool:
        s = series.lower().strip()
        short = re.sub(r"\s*(the animation|animation|ova).*$", "", s).strip()
        return s in titles or short in titles or any(len(c) >= 4 and (c in s or s in c) for c in titles)

    def rss_poll(self, force: bool = False) -> int:
        """sukebei Art-Anime RSS：只收 catalog 里的系列或已知里番工作室的发布。"""
        with self._state_lock:
            h = self._h()
        if not force and now() - h.get("last_rss", 0) < RSS_EVERY:
            return 0
        seen, downloaded = set(h.get("seen_hashes") or []), h.setdefault("downloaded", {})
        titles, n = self._catalog_titles(h), 0
        try:
            items = self.sukebei("", CAT_ANIME)
        except ClientError as e:
            self.log(f"里番 RSS：{e}")
            items = []
        for r in items:
            if not r["hash"] or r["hash"] in seen:
                continue
            seen.add(r["hash"])
            if r["size"] < MIN_HENTAI:
                continue
            series, ep = parse_release(r["title"])
            if series is None:
                continue
            series, vol = split_vol(series)
            ep = file_ep(r["title"]) or vol or ep
            if not self._in_catalog(series, titles) and not HENTAI_STUDIOS.search(r["title"]):
                continue
            key = next((k for k in downloaded if norm(k) == norm(series)), series)
            entry = self.new_entry(downloaded, key, series)
            lib = self.ensure_lib(entry, series)
            if str(ep) in entry["episodes"] or ep in self.existing_eps(lib):
                continue
            ok, err = self.offline(f"{self.remote_h}/{entry['folder']}/Season {entry['season']}", magnet(r["hash"]))
            self.log(f"里番 RSS {lib} E{ep:02d} [{r['seeders']}S {r['size'] / 1e6:.0f}MB] {'OK' if ok else 'FAIL ' + err}")
            if ok:
                entry["episodes"][str(ep)] = {"hash": r["hash"], "title": r["title"][:120], "added": now()}
                n += 1
        h["last_rss"], h["seen_hashes"] = now(), list(seen)
        with self._state_lock:
            cur = self._h()
            cur["downloaded"].update(downloaded)
            cur.update(last_rss=h["last_rss"], seen_hashes=h["seen_hashes"])
            self._h_save(cur)
        return n

    def best_releases(self, query: str, vol: Optional[int] = None) -> List[tuple]:
        """sukebei 动画区搜索 -> [(ep, hash, title, size, seeders)]，每集取 1080p > 做种 > 大小 最好的一个。"""
        best: Dict[int, tuple] = {}
        for r in self.sukebei(query, CAT_ANIME):
            t = r["title"]
            if len(r["hash"]) != 40 or r["size"] < MIN_HENTAI or r["seeders"] < 1 or JUNK_RX.search(t) or rejected(t):
                continue
            ep = file_ep(t)
            if ep is None:
                ep = 0 if re.search(r"complete|batch|全話|全集|\d+\s*[-~]\s*\d+", t, re.I) else (vol or 1)
            key = (bool(re.search(r"1080|FHD", t, re.I)), r["seeders"], r["size"])
            if ep not in best or key > best[ep][0]:
                best[ep] = (key, r["hash"], t, r["size"], r["seeders"])
        return [(ep, h, t, sz, s) for ep, (_, h, t, sz, s) in sorted(best.items())]

    def _groups(self) -> Dict[str, dict]:
        groups: Dict[str, dict] = {}
        for s in self.catalog().get("series") or []:
            jp, vol = split_vol(s["title"])
            cn, vol2 = split_vol(s.get("cn_title") or s["title"])
            g = groups.setdefault(cn, {"jp": jp, "cn": cn, "vols": set(), "full": []})
            g["full"].append(s["title"])
            if vol or vol2:
                g["vols"].add(vol or vol2)
        return groups

    def ingest(self, force: bool = False, only: Optional[List[str]] = None) -> List[str]:
        """catalog 搜索入库（每天一次；只搜还没齐的系列）。only：只搜这些（catalog 里的 title/cn_title 或新加的名字）。"""
        with self._state_lock:
            h = self._h()
        if not force and not only and now() - h.get("last_search", 0) < SEARCH_EVERY:
            return []
        seen, downloaded, report = set(h.get("seen_hashes") or []), h.setdefault("downloaded", {}), []
        groups = self._groups()
        if only:
            keys = {norm(x) for x in only}
            groups = {k: g for k, g in groups.items() if keys & ({norm(k), norm(g["jp"])} | {norm(x) for x in g["full"]})}
        for key, g in groups.items():
            if any(rejected(t) for t in g["full"] + [g["cn"]]):
                continue
            old = [k for k in downloaded if k == key or split_vol(k)[0] == key]
            if old and not only:
                have = self.existing_eps(downloaded[old[0]].get("lib") or downloaded[old[0]]["folder"])
                if have and g["vols"] <= have:
                    continue
            try:
                results = self.best_releases(g["jp"], next(iter(g["vols"])) if len(g["vols"]) == 1 else None)
            except ClientError as e:
                self.log(f"里番搜索 {g['jp'][:30]}：{e}")
                continue
            if not results:
                report.append(f"{g['cn']}：sukebei 没找到")
                continue
            entry = downloaded[old[0]] if old else self.new_entry(downloaded, key, g["jp"], g["cn"])
            lib = self.ensure_lib(entry, g["jp"], g["cn"])
            have = self.existing_eps(lib)
            remote_dir = f"{self.remote_h}/{entry['folder']}/Season {entry['season']}"
            for ep, ihash, rtitle, size, seeders in results:
                if ihash in seen or str(ep) in entry["episodes"] or (ep > 0 and ep in have):
                    continue
                ok, err = self.offline(remote_dir, magnet(ihash))
                msg = f"{lib} {'E%02d' % ep if ep > 0 else '合集'} [{seeders}S {size / 1e6:.0f}MB] {'OK' if ok else 'FAIL ' + err}"
                self.log("里番搜索 " + msg)
                report.append(msg)
                if ok:
                    entry["episodes"][str(ep)] = {"hash": ihash, "title": rtitle[:120], "added": now()}
                seen.add(ihash)
        with self._state_lock:
            cur = self._h()
            cur["downloaded"].update(downloaded)
            cur["seen_hashes"] = list(set(cur.get("seen_hashes") or []) | seen)
            if not only:
                cur["last_search"] = now()
            self._h_save(cur)
        return report

    def scan(self, force: bool = False) -> int:
        """115 上完成的里番 -> strm（最近 2 天有提交的系列每轮扫；其余没齐的每天扫一次；force=全部扫）。"""
        with self._state_lock:
            h = self._h()
            if self.dedupe(h.setdefault("downloaded", {})):
                self.save_data("hentai", h)
        made, touched = 0, {}
        for key, entry in (h.get("downloaded") or {}).items():
            folder, season, eps = entry.get("folder", ""), entry.get("season", 1), entry.get("episodes") or {}
            recent = force or max((e.get("added", 0) for e in eps.values()), default=0) > now() - 2 * 86400
            if not recent and now() - entry.get("scanned", 0) < 86400:
                continue
            lib = entry.get("lib") or folder
            have = self.existing_eps(lib)
            if not recent and have and all(int(e) in have for e in eps if int(e) > 0):
                continue
            entry["scanned"] = now()
            touched[key] = entry
            remote_dir = f"{self.remote_h}/{folder}/Season {season}"
            if not self.ol.get(remote_dir):
                remote_dir = f"{self.remote_h}/{folder}"
                if not self.ol.get(remote_dir):
                    continue
            try:
                vids = [(r, it) for r, it in self.ol.walk(remote_dir)
                        if r.lower().endswith(VIDEO) and it.get("size", 0) >= MIN_HENTAI and not rejected(r)]
                if not vids:
                    continue
                lib = self.ensure_lib(entry, key)
                have = self.existing_eps(lib)
                title = re.sub(r"\s*\[bangumiid=\d+\]$", "", lib).rsplit(" (", 1)[0]
                for remote, _ in sorted(vids, key=lambda x: -x[1].get("size", 0)):    # 同集多个版本取最大的
                    ep = file_ep(remote.rsplit("/", 1)[1]) or file_ep(remote[len(remote_dir):])
                    if ep is None and len(vids) == 1:
                        known = [int(e) for e in eps if int(e) > 0]
                        ep = known[0] if len(known) == 1 else 1
                    if ep is None or ep in have:
                        continue
                    sdir = f"{self.h_lib}/{lib}/Season {season}"
                    self.ol.mkdir(sdir)
                    self.p._write_strm(f"{sdir}/{title} S{season:02d}E{ep:02d}.strm", remote)
                    have.add(ep)
                    made += 1
                    self.log(f"里番 strm {lib} S{season:02d}E{ep:02d}")
                    try:
                        self.emby.updated([f"{self.emby_root}/里番/{lib}"])
                    except Exception:  # noqa: BLE001
                        pass
            except ClientError as e:
                self.log(f"里番扫描 {folder}：{e}")
        if touched:
            with self._state_lock:
                cur = self._h()
                self.dedupe(cur.setdefault("downloaded", {}))
                cur["downloaded"].update({k: v for k, v in touched.items() if k in cur["downloaded"]})
                self._h_save(cur)
        if made:
            self.notify("🔞 里番入库", f"新增 {made} 集")
        return made

    def emby_fix(self, force: bool = False) -> int:
        """目录名带 [bangumiid=N] 但 Emby 首次扫库按名字认错的，按 ID 重新识别（= 网页「识别」）。"""
        with self._state_lock:
            h = self._h()
            if not force and now() - h.get("last_fix", 0) < FIX_EVERY:
                return 0
            h["last_fix"] = now()
            self._h_save(h)
        n = 0
        items = (self.emby.get("/Items", ParentId=self.hentai_lib_id(), Recursive="true", IncludeItemTypes="Series",
                               Fields="Path,ProviderIds") or {}).get("Items") or []
        for s in items:
            m = re.search(r"\[bangumiid=(\d+)\]", s.get("Path", ""))
            if not m or (s.get("ProviderIds") or {}).get("Bangumi") == m.group(1):
                continue
            res = self.emby.post("/Items/RemoteSearch/Series", {"SearchInfo": {"ProviderIds": {"Bangumi": m.group(1)}},
                                                                "ItemId": s["Id"], "SearchProviderName": "Bangumi"}) or []
            hit = [r for r in res if (r.get("ProviderIds") or {}).get("Bangumi") == m.group(1)]
            if hit:
                self.emby.post(f"/Items/RemoteSearch/Apply/{s['Id']}", hit[0], ReplaceAllImages="true")
                self.log(f"里番 Emby 重新识别 {m.group(1)} {hit[0].get('Name')} <- {s.get('Name')}")
                n += 1
        return n

    def catalog_add(self, titles: List[str]) -> List[str]:
        """加进追更目录（日文原名最好；也可以中文名）。返回新加的。"""
        with self._state_lock:
            cat = self.catalog()
            have = {s["title"] for s in cat.get("series") or []}
            added = []
            for raw in titles:
                t = re.sub(r"^\[中字後補\]\s*", "", (raw or "").strip())
                if t and t not in have:
                    cat.setdefault("series", []).append({"title": t, "source": "manual", "added": now()})
                    have.add(t)
                    added.append(t)
            cat["updated"] = now()
            self.save_data("hentai_catalog", cat)
        return added

    def hentai_submit(self, link: str, title: str, ep: Optional[int] = None) -> dict:
        """指定资源（MP 搜索结果或手挑的磁力）按系列入库。title 是发布标题或系列名。"""
        series, rep = parse_release(title)
        series = split_vol(series or title)[0]
        if not series or rejected(title):
            return {"ok": False, "error": "认不出系列名或被排除"}
        with self._state_lock:
            h = self._h()
            downloaded = h.setdefault("downloaded", {})
            key = next((k for k in downloaded if norm(k) == norm(series)), series)
            entry = self.new_entry(downloaded, key, series)
            key = self._key_of(downloaded, entry)
            lib = self.ensure_lib(entry, series)
            ep = ep or file_ep(title) or rep or 1
            ok, err = self.offline(f"{self.remote_h}/{entry['folder']}/Season {entry['season']}", link)
            if ok:
                entry["episodes"][str(ep)] = {"hash": (re.search(r"btih:([0-9a-fA-F]{40})", link) or [None, ""])[1].lower(),
                                              "title": title[:120], "added": now()}
                cur = self._h()
                cur.setdefault("downloaded", {})[key] = entry
                self._h_save(cur)
        return {"ok": ok, "series": key, "lib": lib, "ep": ep, **({"error": err} if err else {})}
