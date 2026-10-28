"""搜索关键词模板（Jinja2）与选片策略（打分 + 选择覆盖整季的组合）。

都可以在插件配置或 API（/policy）里改，方便人和 AI 调整而不用改代码。

关键词模板：每行渲染出一个查询词（空行忽略，规范化后去重）。可用变量：
  keyword        MP 给的关键词（通常是中文名）
  title / original_title / en_title / year / type ("电影"/"电视剧")
  short_title / short_original   「～」「：」前的短名（中文组发布常只写短名）
  latin_names    别名里的拉丁字母名（英文/罗马音，最多 5 个）
  en_head        英文名冒号前的部分（「Mushoku Tensei: Jobless Reincarnation」->「Mushoku Tensei」）
  seasons        要搜的季号列表（精确搜索 / 订阅时 MP 给出）
  过滤器 cn: 数字转中文（2 -> 二）

选片策略（JSON）：见 DEFAULT_POLICY 注释；score_expr 是可选的 Jinja 表达式，结果加到总分，
变量 t（见 features()）、policy。
"""
import json
import math
import re
from typing import Any, Dict, List, Optional, Tuple

try:
    import jinja2
except ImportError:  # pragma: no cover
    jinja2 = None

CN_NUM = "零一二三四五六七八九十"

DEFAULT_QUERY_TEMPLATES = """{{ keyword }}
{{ original_title }}
{{ short_title }}
{{ short_original }}
{% for s in seasons if s > 1 %}{{ short_title }} 第{{ s|cn }}季
{{ short_title }} {{ s }}期
{% if en_head %}{{ en_head }} S{{ s }}
{{ en_head }} Season {{ s }}
{% endif %}{% endfor %}{% for n in latin_names[:3] %}{{ n }}
{% endfor %}"""

# 选片规范（用户 2026-10-10）：剧集每集 1–3 GB、HEVC 优先、中文字幕优先、大组整季合集优先；电影可超 20 GB、4K HDR 压制优先、不要原盘
DEFAULT_POLICY: Dict[str, Any] = {
    "tv": {"per_episode_gb": [0.25, 4.0], "ideal_per_episode_gb": [1.0, 3.0]},
    "movie": {"min_gb": 2.0, "max_gb": 90.0, "ideal_gb": [8.0, 40.0]},
    "weights": {
        "hevc": 20, "av1": 6, "avc": 0, "2160p": 8, "1080p": 10, "720p": -15, "bd": 10, "web": 3,
        "hdr": 4, "cn_sub": 30, "cn_sub_inner": 6, "bilingual": 4, "pack": 18, "group": 12,
        "seeders_log": 3, "size_ideal": 10, "size_ok": 0, "size_bad": -40,
        "foreign": -35, "multi_season_extra": -15,
    },
    # 这些组的发布自带中文字幕（标题里不一定写「简繁」，如 BeanSub&VCB-Studio 的 BD）
    "cn_groups": ["喵萌", "Nekomoe", "千夏", "豌豆", "BeanSub", "华盟", "诸神", "Kamigami", "北宇治", "桜都", "Sakurato",
                  "云光", "LoliHouse", "Airota", "SweetSub", "澄空", "SumiSora", "极影", "动漫国", "幻樱", "7³ACG", "DBD-Raws",
                  "Snow-Raws", "悠哈", "ANi", "jibaketa", "绿茶", "织梦", "MCE", "猎户", "风之圣殿", "银色子弹"],
    "groups": ["LoliHouse", "喵萌奶茶屋", "Nekomoe", "桜都", "Sakurato", "VCB-Studio", "沸班亚马", "MTBB",
               "Beatrice-Raws", "ANi", "DBD-Raws", "Snow-Raws", "7³ACG", "SweetSub", "北宇治", "千夏",
               "Kamigami", "澄空", "SumiSora", "云光", "极影", "动漫国", "幻樱", "Moozzi2", "BlackRose", "Judas"],
    "exclude": [r"(?i)\bREMUX\b", r"(?i)\bBDMV\b", r"(?i)\bISO\b", r"(?i)\b(cam|ts|hdcam|telesync)\b",
                r"(?i)\bxvid\b", r"(?i)(?<![0-9])480p", r"(?i)english dub(?!.*dual)", r"(?i)\b(sample|trailer|ost|soundtrack)\b",
                r"(?i)\b(hardsub(bed)?|hard sub)\b(?!.*(chs|cht|简|繁))"],
    "require_cn_sub": False,
    "min_score": 35,            # 低于这个分数的候选不选（宁缺毋滥；720p、大小未知的小种子会被拦下）
    "score_expr": "",
}


def _env():
    if not jinja2:
        return None
    env = jinja2.Environment(undefined=jinja2.ChainableUndefined, autoescape=False,
                             trim_blocks=True, lstrip_blocks=True)
    env.filters["cn"] = lambda n: CN_NUM[int(n)] if 0 <= int(n) <= 10 else str(n)
    return env


def _norm(text: str) -> str:
    import unicodedata
    return re.sub(r"[\W_]+", "", unicodedata.normalize("NFKC", text or "").lower())


def query_context(keyword: str, target: Any, seasons: List[int]) -> Dict[str, Any]:
    """组装关键词模板变量。"""
    title = getattr(target, "title", None) or keyword
    orig = getattr(target, "original_title", None) or ""
    en = getattr(target, "en_title", None) or ""
    names = [n for n in [title, orig, en] + list(getattr(target, "names", None) or []) if n]
    latin = [n for n in names if re.fullmatch(r"[\x20-\x7e]+", n) and len(_norm(n)) >= 4]
    seen, latin_u = set(), []
    for n in latin:
        if _norm(n) not in seen:
            seen.add(_norm(n))
            latin_u.append(n)

    def head(n):
        h = re.split(r"\s*[～~:：\-－—]\s*", n or "")[0].strip()
        return h if h and h != (n or "").strip() else ""

    en_src = en or (latin_u[0] if latin_u else "")
    return {"keyword": keyword, "title": title, "original_title": orig, "en_title": en,
            "short_title": head(title), "short_original": head(orig), "latin_names": latin_u[:5],
            "en_head": re.split(r"\s*[:：]\s*", en_src)[0] if en_src else "",
            "year": getattr(target, "year", "") or "", "seasons": seasons or [],
            "type": getattr(getattr(target, "type", None), "value", "")}


def render_queries(template: str, ctx: Dict[str, Any], limit: int = 10) -> List[str]:
    """渲染关键词模板；模板出错时退回默认模板。"""
    env = _env()
    lines: List[str] = []
    if env:
        try:
            lines = env.from_string(template or DEFAULT_QUERY_TEMPLATES).render(**ctx).splitlines()
        except Exception:  # noqa: BLE001
            lines = env.from_string(DEFAULT_QUERY_TEMPLATES).render(**ctx).splitlines()
    else:
        lines = [ctx["keyword"], ctx["original_title"], ctx["short_title"]] + ctx["latin_names"][:3]
    out, seen = [], set()
    for q in (l.strip() for l in lines):
        k = _norm(q)
        if q and k and k not in seen:
            seen.add(k)
            out.append(q)
    return out[:limit]


# ---------------- 选片打分 ----------------
def features(title: str, size: float, seeders: int, episodes: List[int], policy: Dict[str, Any]) -> Dict[str, Any]:
    """从发布标题提取打分特征。"""
    t = title or ""
    low = t.lower()
    groups = [g for g in policy.get("groups", [])
              if (re.search(rf"(?<![A-Za-z]){re.escape(g)}(?![A-Za-z])", t) if g.isascii() and len(g) <= 4 else g.lower() in low)]
    return {
        "title": t, "size_gb": size / 1e9, "seeders": seeders or 0, "episodes": episodes or [],
        "hevc": bool(re.search(r"(?i)hevc|x265|h\.?265", t)), "av1": bool(re.search(r"(?i)\bav1\b", t)),
        "avc": bool(re.search(r"(?i)\bavc\b|x264|h\.?264", t)),
        "res": "2160p" if re.search(r"(?i)2160p|4k|uhd", t) else "1080p" if re.search(r"(?i)1080p", t)
        else "720p" if re.search(r"(?i)720p", t) else "",
        "bd": bool(re.search(r"(?i)\bbd|blu-?ray|bdrip", t)), "web": bool(re.search(r"(?i)web-?(dl|rip)|webrip", t)),
        "hdr": bool(re.search(r"(?i)\bhdr|dolby ?vision|\bdv\b", t)),
        "cn_sub": bool(re.search(r"简|繁|中文|中字|双语|chs|cht|\bgb\b|big5|jpsc|jptc|zh-?(cn|tw|hans|hant)", low))
        or any((re.search(rf"(?<![A-Za-z]){re.escape(g)}(?![A-Za-z])", t) if g.isascii() else g.lower() in low)
               for g in policy.get("cn_groups", [])),
        # 法/意/俄/西/德语字幕或配音版（VOSTFR 等）
        "foreign": bool(re.search(r"(?i)\b(vostfr|vf|truefrench|french|ita|italian|rus|russian|castellano|latino|"
                                  r"german|deutsch|ger|pt-?br|portuguese)\b", t)) and not re.search(r"简|繁|chs|cht", low),
        "cn_sub_inner": bool(re.search(r"内封|內封|softsub", low)),
        "bilingual": bool(re.search(r"双语|雙語|简日|繁日|jpsc|jptc|中日", low)),
        "groups": groups,
    }


def score(f: Dict[str, Any], kind: str, policy: Dict[str, Any], need_eps: int = 0) -> Tuple[float, List[str]]:
    """返回 (分数, 理由)。kind: "tv" / "movie"。分数 None 表示被排除。"""
    w = dict(DEFAULT_POLICY["weights"], **policy.get("weights", {}))
    why: List[str] = []
    for rx in policy.get("exclude", []):
        if re.search(rx, f["title"]):
            return None, [f"排除：{rx}"]
    if policy.get("require_cn_sub") and not f["cn_sub"]:
        return None, ["要求中文字幕"]
    s = 0.0

    def add(k, cond=True, note=None):
        nonlocal s
        if cond and w.get(k):
            s += w[k]
            why.append(f"{note or k}{w[k]:+g}")

    add("hevc", f["hevc"]); add("av1", f["av1"] and not f["hevc"]); add("avc", f["avc"] and not (f["hevc"] or f["av1"]))
    add(f["res"], bool(f["res"])); add("bd", f["bd"]); add("web", f["web"] and not f["bd"]); add("hdr", f["hdr"])
    add("cn_sub", f["cn_sub"], "中文字幕"); add("cn_sub_inner", f["cn_sub_inner"], "内封")
    add("bilingual", f["bilingual"], "双语"); add("group", bool(f["groups"]), "大组" + ",".join(f["groups"][:1]))
    add("foreign", f.get("foreign"), "外语版")
    n_eps = len(f["episodes"]) or (need_eps if kind == "tv" else 1)
    add("pack", kind == "tv" and n_eps >= max(2, need_eps or 2), "合集")
    if w.get("seeders_log") and f["seeders"] > 1:
        s += w["seeders_log"] * math.log10(f["seeders"])
    if kind == "tv":
        per = f["size_gb"] / max(1, n_eps)
        lo, hi = policy.get("tv", {}).get("per_episode_gb", [0.25, 4])
        ilo, ihi = policy.get("tv", {}).get("ideal_per_episode_gb", [1, 3])
        tag = "size_ideal" if ilo <= per <= ihi else "size_ok" if lo <= per <= hi else "size_bad"
        add(tag, True, f"每集{per:.1f}G")
    else:
        g = f["size_gb"]
        lo, hi = policy.get("movie", {}).get("min_gb", 2), policy.get("movie", {}).get("max_gb", 90)
        ilo, ihi = policy.get("movie", {}).get("ideal_gb", [8, 40])
        tag = "size_ideal" if ilo <= g <= ihi else "size_ok" if lo <= g <= hi else "size_bad"
        add(tag, True, f"{g:.1f}G")
    expr = policy.get("score_expr")
    env = _env()
    if expr and env:
        try:
            extra = float(env.from_string("{{ " + expr + " }}").render(t=f, policy=policy) or 0)
            if extra:
                s += extra
                why.append(f"表达式{extra:+g}")
        except Exception as err:  # noqa: BLE001
            why.append(f"表达式出错：{err}")
    return s, why


def load_policy(raw: Any) -> Dict[str, Any]:
    """配置里的策略（JSON 字符串或 dict）与默认值合并。"""
    p = json.loads(json.dumps(DEFAULT_POLICY))
    if isinstance(raw, str) and raw.strip():
        try:
            raw = json.loads(raw)
        except ValueError:
            raw = {}
    if isinstance(raw, dict):
        for k, v in raw.items():
            if isinstance(v, dict) and isinstance(p.get(k), dict):
                p[k].update(v)
            else:
                p[k] = v
    return p


GENERIC_SEASON = re.compile(r"^(第\s*\d+\s*季|season\s*\d+|特别篇|specials?|第[一二三四五六七八九十]+季)$", re.I)
SEASON_TAG = [re.compile(r"(?i)\bS(?:eason)?\s*0?(\d{1,2})(?!\d)(?!\s*E\d)"), re.compile(r"(?i)\b(\d)(?:st|nd|rd|th)\s*season"), re.compile(r"第\s*([一二三四五六七八九十\d]+)\s*[季期]"),
              re.compile(r"(?<![\d第])(\d)\s*期"), re.compile(r"△\s*(\d)(?!\d)"), re.compile(r"\s(II|III|IV)(?=[\s\]/|)～:]|$)"),
              re.compile(r"([ⅡⅢⅣ])")]
_ROM = {"II": 2, "III": 3, "IV": 4, "Ⅱ": 2, "Ⅲ": 3, "Ⅳ": 4}


def title_season(title: str) -> Optional[int]:
    """标题里明确写出的季号（S2 / Season 2 / 第二季 / 2期 / △2 / II / Ⅱ）；没有返回 None。"""
    for rx in SEASON_TAG:
        m = rx.search(title or "")
        if m:
            g = m.group(1)
            if g in _ROM:
                return _ROM[g]
            if g.isdigit():
                return int(g)
            return CN_NUM.index(g) if g in CN_NUM else None
    return None


def title_seasons(title: str) -> List[int]:
    """标题里的所有季号：「S1+S2」「第一季+第二季」「Season 1-3」-> [1, 2(, 3)]；没有返回 []。"""
    t = title or ""
    m = re.search(r"(?i)\bS(?:eason)?\s*0?(\d)\s*[-~]\s*S?(?:eason)?\s*0?(\d)\b", t)
    if m:
        return list(range(int(m.group(1)), int(m.group(2)) + 1))
    found = [int(x) for x in re.findall(r"(?i)\bS(?:eason\s*)?0?(\d{1,2})(?!\d)(?!\s*E\d)", t)]
    found += [CN_NUM.index(x) if x in CN_NUM else int(x) for x in re.findall(r"第\s*([一二三四五六七八九十\d]+)\s*季", t)
              if x in CN_NUM or x.isdigit()]
    if not found:
        one = title_season(t)
        return [one] if one else []
    return sorted(set(found))


def name_season(title: str, work_names: List[str]) -> Optional[int]:
    """「吹响吧！上低音号2」「Hibike! Euphonium 3」：作品名后面紧跟的 2–9 当季号。"""
    t = _norm(title)                      # 去掉空格标点再比：「響け! ユーフォニアム 2」->「響けユーフォニアム2」
    for n in work_names or []:
        n = _norm(n)
        if len(n) < 2 or n[-1:].isdigit():
            continue
        m = re.search(re.escape(n) + r"([2-9])(?!\d)", t)
        if m:
            return int(m.group(1))
    return None


def season_ok(c: Dict[str, Any], season: Optional[int], names: Dict[int, str], counts: Dict[int, int],
              work_names: Optional[List[str]] = None) -> Tuple[Optional[int], str]:
    """判断候选是否属于目标季：返回 (加分, 理由)；None = 排除。
    篇章名（TMDb 季名，如「游郭篇」）优先；其次标题里的季号；再看集号是否超出本季集数。"""
    if season is None:
        return 0, ""
    t = _norm(c["title"])
    works = [_norm(w) for w in (work_names or []) if w]
    # 季名就是剧名本身（上低音号 S1 叫「吹响吧！上低音号」）不算篇章名，否则「上低音号2」也会被当成第 1 季
    arcs = {s: _norm(n) for s, n in names.items() if n and not GENERIC_SEASON.match(n.strip()) and len(_norm(n)) >= 2
            and not any(_norm(n) in w or w in _norm(n) for w in works if w)}
    own = arcs.get(season)
    others = [s for s, a in arcs.items() if s != season and a and a in t]
    if own and own in t:
        return 15, f"篇章「{names[season]}」+15"
    if others:
        return None, f"属于第{others[0]}季「{names[others[0]]}」"
    ts = title_season(c["title"])
    if ts is None:
        ts = name_season(c["title"], work_names or [])
    if ts is not None and ts != season:
        return None, f"标题写的是第{ts}季"
    eps = c.get("episodes") or []
    if eps and counts.get(season) and max(eps) > counts[season] + 1 and min(eps) > counts[season]:
        prev = sum(n for k, n in counts.items() if 0 < k < season)
        if prev and all(prev < e <= prev + counts[season] for e in eps):
            c["episodes"] = [e - prev for e in eps]          # 绝对集号（「12(36)」）换算回本季
            return 0, f"绝对集号-{prev}"
        return None, f"集号 {min(eps)}-{max(eps)} 超出本季 {counts[season]} 集"
    if ts is None and season > 1 and not eps:
        return -10, "没写季号-10"
    return 0, ""


TV_PACK = re.compile(r"(?i)TV\s*全集|全集|\b\d{2}\s*[-~]\s*\d{2}\b|\bseason\b|\bS\d{2}\b|合集|全\d+话|batch")
MOVIEISH = re.compile(r"(?i)\b(movie|film|gekijou?ban)\b|劇場版|剧场版|\bArc\s*(?=[\[(]|$)")
MOVIE_COLL = re.compile(r"(?i)三部|四部|合集|collection|trilogy|\b\d\s*-\s*\d\b|1\+2|序\+破")


RANGE = re.compile(r"[\[\s(【第](\d{1,3})(\.\d)?\s*[-~～]\s*(\d{1,3})(?=\s*(?:合集|话|話|集|fin|end|\]|】|\)|\(|\s|$))", re.I)


def _fill_range(c: Dict[str, Any]) -> Dict[str, Any]:
    """MP 没解析出集数时自己从标题取范围：「[24.9-36合集]」-> 25..36（24.9 是总集篇，不算）。"""
    if c.get("episodes"):
        return c
    for m in RANGE.finditer(c["title"]):
        a, dec, b = int(m.group(1)), m.group(2), int(m.group(3))
        a = a + 1 if dec else a
        if 0 < a < b <= 2000 and not (1900 <= a <= 2100):
            return dict(c, episodes=list(range(a, b + 1)))
    return c


_YEAR = re.compile(r"(?<!\d)(19\d\d|20\d\d)(?!\d)")


def year_conflict(title: str, year: Any, names: Optional[List[str]] = None) -> str:
    """电影：发布标题写的年份和作品对不上时返回原因（空串 = 没冲突）。
    - 作品名本身带年份（年度演唱会「《明日方舟》2026「音律联觉」」、「Blade Runner 2049」）：名字里的年份不算发布年份；
      名字带年份的系列作品，标题里出现别的年份就是另一年的那一部，必须精确匹配。
    - 其余按上映年份 ±1（电影节首映和公映常差一年）；标题没写年份放行（BD 常不写）。"""
    y = int(str(year)[:4]) if str(year or "")[:4].isdigit() else 0
    if not y:
        return ""
    own = {int(x) for n in names or [] if n for x in _YEAR.findall(str(n))}
    ys = [int(x) for x in _YEAR.findall(title or "") if int(x) not in own]
    if not ys:
        return ""
    series = {o for o in own if abs(o - y) <= 1}      # 名字里的年份就是发行年份：年度系列（2049 这种不算）
    if series:
        return f"标题年份 {ys[0]} 和作品（{'/'.join(map(str, sorted(series)))}）不是同一年的那一部"
    if any(abs(v - y) <= 1 for v in ys):
        return ""
    return f"标题年份 {ys[0]} 和作品 {y} 对不上"


def pick(cands: List[Dict[str, Any]], kind: str, policy: Dict[str, Any], want_eps: List[int],
         season: Optional[int] = None, season_names: Optional[Dict[int, str]] = None,
         season_counts: Optional[Dict[int, int]] = None, movie_names: Optional[List[str]] = None,
         season_starts: Optional[Dict[int, int]] = None, sibling_names: Optional[List[str]] = None,
         want_seasons: Optional[List[int]] = None, season_year: Optional[int] = None,
         movie_year: Any = None) -> Dict[str, Any]:
    """在 _pick 之前按季/电影上下文过滤或加减分。
    sibling_names：同名的其他作品（重制版、衍生作）的独有名字，标题里出现就排除（狼与香辛料 2008 vs 2024「行商邂逅贤狼」）。
    want_seasons：这次要下的季；多季合集里含不需要的季（库里已有）扣分。"""
    adj = []
    if kind == "tv":
        cands = [_fill_range(c) for c in cands]
    keys = [k for k in (_norm(n) for n in (movie_names or [])) if len(k) >= 3]
    # 兄弟作品名去掉和本作共有的部分，只比独有的那段（「狼と香辛料 MERCHANT MEETS THE WISE WOLF」-> merchantmeetsthewisewolf）
    ours = sorted({k for k in (_norm(n) for n in (movie_names or [])) if len(k) >= 2}, key=len, reverse=True)
    sibs = []
    for n in sibling_names or []:
        k = _norm(n)
        for o in ours:
            k = k.replace(o, "")
        if len(k) >= 4:
            sibs.append(k)
    if sibs:
        cands = [c for c in cands if not any(k in _norm(c["title"]) for k in sibs)]
    counts = season_counts or {}
    # TMDb 把多季合成一季（药屋少女 S1=50 集、文豪野犬 S1=60 集）：字幕组按「第N季」发布、集号从 01 开始。
    # 标题季号 k 在 TMDb 里不存在时，按候选里第 1..k-1 季合集的最大集号累加出偏移，换算成绝对集号。
    merged = kind == "tv" and season is not None and counts.get(season, 0) >= 30
    starts: Dict[int, int] = {}          # 字幕组第 k 季在 TMDb 合并季里的起始绝对集号
    if merged:
        rel_max: Dict[int, int] = {}
        for c in cands:
            ss = title_seasons(c["title"]) or [1]
            eps = c.get("episodes") or []
            if len(ss) != 1 or not eps:
                continue
            k = ss[0]
            if k > 1 and min(eps) > 30 and k not in starts:          # 「01-13(38-50)」被解析成绝对集号
                starts[k] = min(eps)
            elif max(eps) <= 30 and len(eps) >= 6:
                rel_max[k] = max(rel_max.get(k, 0), max(eps))
        if season_starts:                                           # batch 按 TMDb 播出间隔推出的各季起点，最可靠
            starts = {int(k): int(v) for k, v in season_starts.items()}
        starts.setdefault(1, 1)
        for k in range(2, 10):                                      # 缺的按前一季集数累加
            if k not in starts and (k - 1) in starts and rel_max.get(k - 1):
                starts[k] = starts[k - 1] + rel_max[k - 1]

    def span(k: int) -> Optional[range]:
        if k not in starts:
            return None
        last = counts.get(season, 0) + 1 if season_starts else starts[k] + rel_max.get(k, 0)
        end = starts.get(k + 1, last) if merged else 0
        return range(starts[k], end) if end > starts[k] else None

    for c in cands:
        c = dict(c)
        if kind == "tv" and merged:
            ss = title_seasons(c["title"])
            eps = c.get("episodes") or []
            if not ss and not eps:
                ss = [1]
            if ss and ss != [1] and eps and len(eps) < 6:
                continue                                            # 单集按「第N季」换算风险大（衍生作「汪！2」也会混进来），只换算合集
            if ss and (not eps or max(eps) <= 30):
                rng = [r for r in (span(k) for k in ss) if r]
                if len(rng) != len(ss):
                    continue                                        # 推不出这几季在合并季里的位置，不冒险
                off = starts[ss[0]] - 1
                c["episodes"] = [e + off for e in eps] if eps and len(ss) == 1 else [e for r in rng for e in r]
                c["ep_offset"] = off if len(ss) == 1 else 0
                if len(ss) > 1:
                    c["season_starts"] = {str(k): starts[k] for k in ss}
                if len(ss) > 1 and off:
                    continue                                        # 多季合集且不从第 1 季开始：文件集号无法统一换算
                c["bonus"], c["bonus_why"] = 0, f"合并季：第{'+'.join(map(str, ss))}季 → {c['episodes'][0]}-{c['episodes'][-1]}"
                adj.append(c)
                continue
            if eps and min(eps) > 30:
                k = (title_seasons(c["title"]) or [None])[0]
                adj.append(dict(c, bonus=0, bonus_why="绝对集号", ep_offset=(starts[k] - 1) if k in starts else 0))
                continue
        if kind == "tv" and not c.get("episodes") and len(want_eps) > 1 and MOVIEISH.search(c["title"]) \
                and not TV_PACK.search(c["title"]) and not title_seasons(c["title"]):
            continue                                                # 「Chainsaw Man - Reze Arc」：同系列剧场版，不是整季
        if kind == "tv" and season_year and not merged:          # TMDb 合并季跨好几年，不按年份判断
            ys = [int(y) for y in re.findall(r"[\(\[（【]\s*((?:19|20)\d{2})(?:\s*[-~]\s*(?:19|20)\d{2})?\s*[\)\]）】]", c["title"])]
            if ys and all(abs(y - season_year) > 1 for y in ys):
                continue                                            # 「Spice and Wolf (2024)」不是 2008 版
        if kind == "tv":
            bonus, why = season_ok(c, season, season_names or {}, season_counts or {}, movie_names)   # 可能就地改写 c["episodes"]
            if bonus is None:
                continue
            ss = title_seasons(c["title"])
            extra = [k for k in ss if k != season and k not in (want_seasons or [])]
            if (len(ss) > 1 and extra) or (re.search(r"(?i)complete series|全系列|全季|series\s*\+\s*movie", c["title"])
                                          and not (want_seasons and len(want_seasons) > 1)):
                w = (policy.get("weights") or {}).get("multi_season_extra", DEFAULT_POLICY["weights"]["multi_season_extra"])
                bonus += w
                why = (why + " " if why else "") + f"含不需要的季{w:+g}"
            c["bonus"], c["bonus_why"] = bonus, why
        else:
            if year_conflict(c["title"], movie_year, movie_names):
                continue                                            # 「音律联觉2024」不是 2026 那一部
            t = _norm(c["title"])
            named = any(k in t for k in keys)
            b, w = 0, []
            if TV_PACK.search(c["title"]) and not named:
                b -= 40; w.append("像TV合集-40")
            if MOVIE_COLL.search(c["title"]):
                b -= 20; w.append("系列合集-20")
            if named:
                b += 10; w.append("片名匹配+10")
            c["bonus"], c["bonus_why"] = b, " ".join(w)
        adj.append(c)
    return _pick(adj, kind, policy, want_eps)


def _pick(cands: List[Dict[str, Any]], kind: str, policy: Dict[str, Any], want_eps: List[int]) -> Dict[str, Any]:
    """从候选里选：电影取最高分一个；剧集优先覆盖整季的合集，否则按集取每集最高分。
    cands: [{"idx", "title", "size", "seeders", "episodes"}]；返回 {"chosen": [...], "ranked": [...], "missing": [...]}"""
    ranked = []
    for c in cands:
        f = features(c["title"], c["size"], c["seeders"], c.get("episodes") or [], policy)
        sc, why = score(f, kind, policy, len(want_eps))
        if sc is not None:
            if c.get("bonus"):
                sc += c["bonus"]
            if c.get("bonus_why"):
                why = why + [c["bonus_why"]]
            ranked.append(dict(c, score=round(sc, 1), why=why))
    ranked.sort(key=lambda c: -c["score"])
    floor = float(policy.get("min_score", 35))
    good = [c for c in ranked if c["score"] >= floor]
    if kind != "tv":
        return {"chosen": good[:1], "ranked": ranked[:15], "missing": []}
    want = set(want_eps)
    full = [c for c in good if not c.get("episodes") or want <= set(c["episodes"])]
    chosen, covered = [], set()
    for c in good:  # 贪心：分高的先选，补没覆盖的集（允许溢出 2 集：TMDb 偶尔少算一集）
        eps = set(c.get("episodes") or [])
        if eps and eps - covered and len(eps - want - {0}) <= 2 and eps & want:
            chosen.append(c)
            covered |= eps
        if want <= covered:
            break
    # 去冗余：被其他已选资源完全覆盖的去掉（同一集两份会在入库时互相替换）
    for c in list(chosen):
        others = set().union(*[set(o.get("episodes") or []) for o in chosen if o is not c]) if len(chosen) > 1 else set()
        if set(c.get("episodes") or []) <= others:
            chosen.remove(c)
    # 整季合集 vs 单集组合：合集分数不低于单集组合平均分 - 5 才用合集（例：生肉合集 vs 简繁内封单集，选单集）
    if full:
        avg = sum(c["score"] for c in chosen) / len(chosen) if chosen and want <= covered else -1e9
        if full[0]["score"] >= avg - 5:
            return {"chosen": full[:1], "ranked": ranked[:15], "missing": []}
    return {"chosen": chosen, "ranked": ranked[:15], "missing": sorted(want - covered)}
