"""番剧直连资源源：AnimeTosho（Nyaa 等的镜像，JSON，可按大小排序）+ Nyaa（按做种数）+ Mikan（Bangumi 对应的中文字幕组发布）。

为什么不走 Prowlarr：Prowlarr 查 Nyaa 只给第一页 75 条（按时间），老番的 BD 合集常被新单集挤掉；
dmhy/comicat 经常被 Prowlarr 标成不可用；每个查询都扇出到 11 个索引器，NAS（2GB）扛不住批量。
这里每部作品只发几个并发请求，直连，1–2 秒。

Nyaa 搜索语法：`(a b)|(c)` 是或（必须用括号分组，否则 `|` 只作用于相邻的词），空格是与，`-词` 排除。
"""
import html
import re
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from typing import Callable, Dict, List

NYAA = "https://nyaa.si/"
MIKAN = "https://mikanani.me/RSS/Search?searchstr="
UNITS = {"B": 1, "KiB": 1024, "MiB": 1024 ** 2, "GiB": 1024 ** 3, "TiB": 1024 ** 4,
         "KB": 1e3, "MB": 1e6, "GB": 1e9, "TB": 1e12}
ROW = re.compile(r"<tr class=\"(?:default|success|danger)\">(.*?)</tr>", re.S)


def _size(text: str) -> float:
    m = re.match(r"\s*([\d.]+)\s*([KMGT]?i?B)", text or "")
    return float(m.group(1)) * UNITS.get(m.group(2), 1) if m else 0.0


def nyaa_html(get: Callable[[str], str], q: str, sort: str = "seeders", page: int = 1, cat: str = "1_0") -> List[Dict]:
    """Nyaa 网页搜索一页（75 条）。sort: seeders / size / id(时间)。"""
    url = f"{NYAA}?f=0&c={cat}&q={urllib.parse.quote(q)}&s={sort}&o=desc&p={page}"
    out = []
    for row in ROW.findall(get(url) or ""):
        t = re.search(r'<a href="/view/\d+" title="([^"]+)"', row)
        mg = re.search(r'href="(magnet:\?xt=urn:btih:[^"]+)"', row)
        tds = re.findall(r'<td class="text-center"[^>]*>(.*?)</td>', row, re.S)
        ts = re.search(r'data-timestamp="(\d+)"', row)
        if not t or not mg or len(tds) < 5:
            continue
        out.append({"title": html.unescape(t.group(1)), "magnet": html.unescape(mg.group(1)),
                    "size": _size(re.sub(r"<[^>]+>", "", tds[1])),
                    "seeders": int(re.sub(r"\D", "", tds[3]) or 0), "peers": int(re.sub(r"\D", "", tds[4]) or 0),
                    "ts": int(ts.group(1)) if ts else 0, "site": "Nyaa"})
    return out


ANIMETOSHO = "https://feed.animetosho.xyz/json"     # .org 在部分网络解析不了


def animetosho(get: Callable[[str], str], q: str, order: str = "", page: int = 1) -> List[Dict]:
    """AnimeTosho JSON（镜像 Nyaa/AniDex/TokyoTosho，每页 75 条）。order: "" = 最新，"size-d" = 按大小倒序（合集在前）。
    不像 Nyaa 那样一并发就 429。"""
    import json
    url = f"{ANIMETOSHO}?q={urllib.parse.quote(q)}&page={page}" + (f"&order={order}" if order else "")
    out = []
    for r in json.loads(get(url) or "[]"):
        h = r.get("info_hash")
        if not h:
            continue
        title = r.get("title") or ""
        out.append({"title": title, "magnet": r.get("magnet_uri") or f"magnet:?xt=urn:btih:{h}&dn={urllib.parse.quote(title)}",
                    "size": float(r.get("total_size") or 0), "seeders": int(r.get("seeders") or 0),
                    "peers": int(r.get("leechers") or 0), "ts": int(r.get("timestamp") or 0), "site": "AnimeTosho"})
    return out


_NYAA_SEM = __import__("threading").BoundedSemaphore(2)


def nyaa_limited(get: Callable[[str], str], *a) -> List[Dict]:
    """Nyaa 并发一多就 429：全局最多 2 个并发，429/空页退避重试。"""
    import time
    for wait in (0, 1.5, 3):
        time.sleep(wait)
        with _NYAA_SEM:
            r = _safe(nyaa_html, get, *a)
        if r:
            return r
    return []


def mikan_rss(get: Callable[[str], str], q: str) -> List[Dict]:
    """Mikan 搜索 RSS（最多 100 条）：中文字幕组的周更和合集。种子链接里带 hash，contentLength 是大小。"""
    out = []
    for it in re.findall(r"<item>(.*?)</item>", get(MIKAN + urllib.parse.quote(q)) or "", re.S):
        t = re.search(r"<title>(.*?)</title>", it, re.S)
        h = re.search(r"/Download/\d+/([0-9a-f]{40})\.torrent", it)
        sz = re.search(r"<contentLength>(\d+)</contentLength>", it)
        pub = re.search(r"<pubDate>([^<]+)</pubDate>", it)
        if not t or not h:
            continue
        title = html.unescape(t.group(1)).strip()
        out.append({"title": title, "magnet": f"magnet:?xt=urn:btih:{h.group(1)}&dn={urllib.parse.quote(title)}",
                    "size": float(sz.group(1)) if sz else 0.0, "seeders": 1, "peers": 0,
                    "pub": pub.group(1)[:19].replace("T", " ") if pub else "", "site": "Mikan"})
    return out


def anime_search(get: Callable[[str], str], latin_jp: List[str], zh: List[str], pages: int = 2) -> List[Dict]:
    """一部番的全部候选：Nyaa（名字用 | 合并）按做种数取 pages 页 + 按时间 1 页；Mikan 按中文名各一次。并发执行。"""
    names = [n for n in dict.fromkeys(latin_jp + zh) if n and len(n) >= 2]
    jobs = []
    if names:
        q = "|".join(f"({n})" for n in names[:6])     # 括号分组才是「或」；加引号会变成精确短语
        # AnimeTosho：大小倒序 pages 页（老番 BD 合集在前，新单集挤不掉）+ 最新 1 页 + 专搜合集 1 页；
        # Nyaa：按做种数 1 页（AnimeTosho 没有做种数排序），限速
        jobs += [(animetosho, q, "size-d", p) for p in range(1, pages + 1)] + [(animetosho, q, "", 1),
                 (animetosho, f"({q}) (batch|bd|bdrip|complete|fin|全集|合集)", "", 1),
                 (nyaa_limited, q, "seeders", 1)]
    for n in list(dict.fromkeys(zh))[:2]:
        jobs.append((mikan_rss, n))
    with ThreadPoolExecutor(max_workers=6) as pool:
        res = list(pool.map(lambda j: _safe(j[0], get, *j[1:]), jobs))
    seen, out = set(), []
    for batch in res:
        for r in batch:
            r["magnet"] = hex_magnet(r["magnet"], r["title"])
            h = (re.search(r"btih:([0-9a-fA-F]{40})", r["magnet"]) or [None, r["magnet"]])[1].lower()
            if h not in seen:
                seen.add(h)
                out.append(r)
    return out


def hex_magnet(magnet: str, title: str = "") -> str:
    """btih 统一成 40 位十六进制（AnimeTosho 有的是 32 位 base32，插件和 115 都按十六进制处理）。"""
    import base64
    m = re.search(r"btih:([0-9A-Za-z]{32,40})", magnet or "")
    if not m:
        return magnet
    h = m.group(1)
    if len(h) == 32:
        try:
            h = base64.b32decode(h.upper()).hex()
        except Exception:  # noqa: BLE001
            return magnet
    # 保留原来的 tracker：没有 tracker 的磁力，115 离线只能靠 DHT，刚发布、115 还没缓存的种子会一直拿不到种子信息
    trs = re.findall(r"[&?](tr=[^&]+)", magnet or "")
    return f"magnet:?xt=urn:btih:{h.lower()}&dn={urllib.parse.quote(title)}" + "".join("&" + t for t in trs)


def _safe(fn, *a):
    try:
        return fn(*a)
    except Exception:  # noqa: BLE001
        return []
