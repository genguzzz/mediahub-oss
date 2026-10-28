"""自动补中文字幕：入库的视频既没有中文字幕轨也没有中文外挂时，从 GitHub foxofice/sub_share 找对应作品的字幕，
按集号匹配、下载，用音频互相关校验时间轴（偏移 >0.3s 自动平移），写到 strm 旁边。

sub_share 结构：subs_list/animation/<首播年>/(<首播日期>)<中文名>[续/2期...]/<版本>/<字幕组>/*.ass
只覆盖动画；电影、真人剧找不到时只在通知里提示「无中文字幕」。GitHub API 未登录每小时 60 次，按年份目录缓存一天。
"""
import json
import re
import subprocess
import tempfile
import time
import unicodedata
import urllib.parse
from typing import Dict, List, Optional, Tuple

from app.sdk.network import RequestUtils

API = "https://api.github.com/repos/foxofice/sub_share"
RAW = "https://raw.githubusercontent.com/foxofice/sub_share/master/"
_year_cache: Dict[str, Tuple[float, list]] = {}


def _norm(t: str) -> str:
    return re.sub(r"[\W_]+", "", unicodedata.normalize("NFKC", t or "").lower())


def _get_json(url: str):
    res = RequestUtils(headers={"Accept": "application/vnd.github+json", "User-Agent": "Prowlarr115"},
                       timeout=30).get_res(url)
    if res is None or res.status_code != 200:
        raise RuntimeError(f"GitHub {getattr(res, 'status_code', '无响应')}: {url[-60:]}")
    return res.json()


def year_dirs(year: int) -> list:
    key = str(year)
    hit = _year_cache.get(key)
    if hit and time.time() - hit[0] < 86400:
        return hit[1]
    data = _get_json(f"{API}/contents/subs_list/animation/{year}")
    _year_cache[key] = (time.time(), data)
    return data


SEASON_WORDS = {2: ["续", "2期", "第二季", "Ⅱ", " II", "2nd"], 3: ["完", "3期", "第三季", "Ⅲ", " III", "3rd"],
                4: ["4期", "第四季", "Ⅳ"], 5: ["5期", "第五季"]}


def find_work(names: List[str], year: int, season: int = 1) -> Optional[dict]:
    """在 <year>±1 的目录里找作品文件夹；季号 >1 时优先带「续/2期/第二季」的。"""
    keys = [k for k in (_norm(n) for n in names if n) if len(k) >= 2]
    best = None
    for y in (year, year - 1, year + 1):
        try:
            dirs = year_dirs(y)
        except Exception:  # noqa: BLE001
            continue
        for d in dirs:
            if d.get("type") != "dir":
                continue
            name = re.sub(r"^\([\d.]+\)", "", d["name"])
            n = _norm(name)
            hit = max((len(k) for k in keys if k in n or n in k), default=0)
            if not hit:
                continue
            words = SEASON_WORDS.get(season, [])
            sscore = (5 if season > 1 and any(w.strip() in name for w in words) else 0) - \
                     (5 if season == 1 and any(w.strip() in name for ws in SEASON_WORDS.values() for w in ws) else 0)
            sc = hit + sscore + (2 if y == year else 0)
            if not best or sc > best[0]:
                best = (sc, d)
    return best[1] if best else None


def ep_of(name: str) -> Optional[int]:
    for rx in (r"[Ss]\d{1,2}[Ee](\d{1,3})", r"\[(\d{1,3})(?:v\d)?\]", r"\s-\s(\d{1,3})(?:v\d)?[\s.\[]",
               r"第\s*(\d{1,3})\s*[集话話]", r"[\s_.](\d{2})[\s_.\[]", r"\b(\d{2})\b"):
        m = re.search(rx, name)
        if m:
            return int(m.group(1))
    return None


def plan(work: dict, episodes: List[int]) -> Dict[int, str]:
    """选一个字幕组目录（覆盖集数最多、简体优先、BD 优先），返回 {集号: 仓库路径}。"""
    tree = _get_json(f"{API}/git/trees/{work['sha']}?recursive=1").get("tree", [])
    groups: Dict[str, Dict[int, str]] = {}
    for e in tree:
        p = e["path"]
        if e["type"] != "blob" or not p.lower().endswith((".ass", ".ssa", ".srt")):
            continue
        g = p.rsplit("/", 1)[0] if "/" in p else ""
        ep = ep_of(p.rsplit("/", 1)[-1])
        if ep is None:
            continue
        low = p.lower()
        rank = (2 if re.search(r"sc|chs|简|gb|jpsc", low) else 1 if re.search(r"tc|cht|繁|big5", low) else 0)
        cur = groups.setdefault(g, {})
        if ep not in cur or rank > cur[ep][0]:
            cur[ep] = (rank, p)
    if not groups:
        return {}
    want = set(episodes)

    def gscore(item):
        g, m = item
        return (len(want & set(m)), sum(r for r, _ in m.values()), "bd" in g.lower(), -len(g))
    g, m = max(groups.items(), key=gscore)
    base = work.get("path", "")          # contents API 给的仓库路径，tree 里的路径相对它
    return {ep: f"{base}/{p}" for ep, (_, p) in m.items() if ep in want}


def download(repo_path: str) -> bytes:
    res = RequestUtils(timeout=60).get_res(RAW + urllib.parse.quote(repo_path))
    if res is None or res.status_code != 200:
        raise RuntimeError(f"下载字幕失败 {repo_path[-60:]}")
    return res.content


# ---------------- 时间轴校验（与 scripts/subs/sub_offset.py 同算法） ----------------
def _t(x: str) -> float:
    h, m, s = x.split(":")
    return int(h) * 3600 + int(m) * 60 + float(s)


def offset(video_url: str, ass: bytes, secs: int = 600) -> Optional[float]:
    """返回字幕相对音频的最佳偏移（秒，正数=字幕早了）；失败返回 None。"""
    try:
        import numpy as np
        with tempfile.NamedTemporaryFile(suffix=".pcm") as tmp:
            subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-t", str(secs), "-i", video_url,
                            "-vn", "-ac", "1", "-ar", "8000", "-af", "highpass=f=300,lowpass=f=3000", "-f", "s16le",
                            tmp.name], check=True, timeout=600)
            x = np.fromfile(tmp.name, dtype=np.int16).astype(np.float32)
        n = len(x) // 800
        if n < 600:
            return None
        e = np.log1p(np.sqrt((x[:n * 800].reshape(n, 800) ** 2).mean(1)))
        v = (e > np.percentile(e, 55)).astype(float)
        s = np.zeros(n)
        skip = re.compile(r"^(op|ed|lrc|song|title|staff|comment)", re.I)
        for line in ass.decode("utf-8-sig", "ignore").splitlines():
            if not line.startswith("Dialogue"):
                continue
            p = line.split(",", 9)
            if len(p) < 10 or skip.match(p[3]):
                continue
            s[max(int(_t(p[1]) * 10), 0):min(int(_t(p[2]) * 10), n)] = 1
        if not s.any():
            return None
        v -= v.mean()
        s -= s.mean()
        sc = {k / 10: float(np.dot(v[max(0, k):n + min(0, k)], s[max(0, -k):n - max(0, k)])) for k in range(-100, 101)}
        return max(sc, key=sc.get)
    except Exception:  # noqa: BLE001
        return None


def shift(ass: bytes, secs: float) -> bytes:
    """把所有 Dialogue 时间平移 secs 秒。"""
    def f(x):
        v = max(0.0, _t(x) + secs)
        return f"{int(v // 3600)}:{int(v % 3600 // 60):02d}:{v % 60:05.2f}"
    out = []
    for line in ass.decode("utf-8-sig", "ignore").splitlines(keepends=True):
        if line.startswith("Dialogue:"):
            p = line.split(",", 3)
            p[1], p[2] = f(p[1]), f(p[2])
            line = ",".join(p)
        out.append(line)
    return "﻿".encode() + "".join(out).encode("utf-8")


def has_cn_stream(video_url: str) -> Optional[bool]:
    """ffprobe 看视频里有没有中文字幕轨（语言 chi/zho 或标题含 简/繁/中）。失败返回 None。"""
    try:
        r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "s", "-show_entries",
                            "stream_tags=language,title", "-of", "json", video_url],
                           capture_output=True, text=True, timeout=120)
        for st in json.loads(r.stdout or "{}").get("streams", []):
            tags = st.get("tags") or {}
            if (tags.get("language") or "").lower() in ("chi", "zho", "chs", "cht", "zh") or \
                    re.search(r"简|繁|中|chs|cht|gb|big5", tags.get("title") or "", re.I):
                return True
        return False
    except Exception:  # noqa: BLE001
        return None
