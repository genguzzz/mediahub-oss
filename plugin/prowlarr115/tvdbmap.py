"""TMDb 集号 -> TheTVDB 集号映射。

动漫库按 TVDB 分季（用户 2026-10-11 选定，同 Sonarr）：TMDb 会把药屋少女三季合成 60 集的 S1、
文豪野犬五季合成一季；TVDB 分成 S1/S2/S3。流水线内部仍按 TMDb 算集号（识别、合并季偏移都基于 TMDb），
写 strm 文件名时再换成 TVDB 的 (季, 集)。

对齐规则（只用已播出的正片，不含第 0 季）：
  1. 两边总集数相同：按播出顺序一一对应；
  2. 否则按播出日期：同一天的集按顺序配对，某天两边集数不同的那几集不映射（保持 TMDb 编号）。
没有任何一集换季时返回 {}（只是集号平移的不映射），调用方不做任何改名。
"""
import time
from datetime import date
from typing import Dict, List, Optional, Tuple

TVDB_API = "https://api4.thetvdb.com/v4"
TVDB_KEY = "ed2aa66b-7899-4677-92a7-67bc9ce3d93a"      # MoviePilot 内置的公开 v4 key
Ep = Tuple[int, int, str]                              # (季, 集, 播出日期 YYYY-MM-DD)


def build(tmdb_eps: List[Ep], tvdb_eps: List[Ep], today: Optional[str] = None) -> Dict[Tuple[int, int], Tuple[int, int]]:
    today = today or date.today().isoformat()

    def clean(eps):
        return sorted(((s, e, d) for s, e, d in eps if s > 0 and d and d <= today), key=lambda x: (x[2], x[0], x[1]))
    a, b = clean(tmdb_eps), clean(tvdb_eps)
    if not a or not b:
        return {}
    out: Dict[Tuple[int, int], Tuple[int, int]] = {}
    if len(a) == len(b):
        out = {(x[0], x[1]): (y[0], y[1]) for x, y in zip(sorted(a, key=lambda x: (x[0], x[1])), sorted(b, key=lambda x: (x[0], x[1])))}
    else:
        by_a: Dict[str, list] = {}
        by_b: Dict[str, list] = {}
        for x in a:
            by_a.setdefault(x[2], []).append(x)
        for y in b:
            by_b.setdefault(y[2], []).append(y)
        for d, xs in by_a.items():
            ys = by_b.get(d) or []
            if len(xs) == len(ys):
                out.update({(x[0], x[1]): (y[0], y[1]) for x, y in zip(xs, ys)})
    # 只在季号确实不同时才映射：同一季里只是集号平移（两边对首播特别篇的认定不同，在播番常见）不可靠，保持 TMDb
    if not any(k[0] != v[0] for k, v in out.items()):
        return {}
    return out


class TvdbClient:
    """TVDB v4 最小客户端；get(url, headers, params) 由调用方注入（插件里用 RequestUtils，脚本里用 requests）。"""

    def __init__(self, http_get, http_post):
        self._get, self._post = http_get, http_post
        self._tok: Optional[str] = None
        self._tok_t = 0.0

    def _h(self) -> dict:
        if not self._tok or time.time() - self._tok_t > 20 * 86400:
            self._tok = self._post(f"{TVDB_API}/login", {"apikey": TVDB_KEY})["data"]["token"]
            self._tok_t = time.time()
        return {"Authorization": f"Bearer {self._tok}"}

    def episodes(self, tvdb_id: int) -> List[Ep]:
        eps, page = [], 0
        while True:
            d = self._get(f"{TVDB_API}/series/{tvdb_id}/episodes/default", self._h(), {"page": page})
            for e in (d.get("data") or {}).get("episodes") or []:
                if e.get("seasonNumber") is not None and e.get("number") is not None:
                    eps.append((int(e["seasonNumber"]), int(e["number"]), str(e.get("aired") or "")))
            if not (d.get("links") or {}).get("next"):
                return eps
            page += 1
