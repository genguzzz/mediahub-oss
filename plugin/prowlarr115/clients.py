"""Prowlarr115 用到的外部服务客户端：OpenList、115 网页接口、qBittorrent、Emby。

插件跑在 MoviePilot 容器里，通过网络访问：
  OpenList :5244   列 115 目录、移动改名、把 strm/字幕写进媒体库（OpenList 的本地存储）
  qBittorrent      115 离线不可用时的本地缓冲下载（可选）
  Emby :8096       按 TMDb ID 找已入库目录、确认刮削
  SOCKS5（可选）   115 网页接口走国内出口，避免 115 看到海外 IP 触发异地风控
"""
import re
import time
import urllib.parse
from typing import Any, Dict, List, Optional

from app.sdk.network import RequestUtils

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/138.0.0.0 Safari/537.36")


class ClientError(RuntimeError):
    """外部服务返回错误。"""


class OpenList:
    """OpenList(AList) 管理接口的最小封装（token 登录，过期自动重登）。"""

    def __init__(self, url: str, user: str, password: str, public: str):
        """url 供插件访问（隧道地址）；public 写进 strm，供 NAS 上的 Emby 访问。"""
        self.url, self.user, self.password = url.rstrip("/"), user, password
        self.public = public.rstrip("/")
        self._token: Optional[str] = None

    def _login(self) -> str:
        res = RequestUtils(content_type="application/json", timeout=30).post_res(
            f"{self.url}/api/auth/login", json={"username": self.user, "password": self.password})
        data = res.json() if res is not None else {}
        if data.get("code") != 200:
            raise ClientError(f"OpenList 登录失败：{data.get('message') or getattr(res, 'status_code', '无响应')}")
        self._token = data["data"]["token"]
        return self._token

    def call(self, path: str, body: Optional[dict] = None, timeout: int = 120) -> Any:
        """POST /api/...；返回 data。401 时重登一次。"""
        for attempt in (0, 1, 2):
            tok = self._token or self._login()
            res = RequestUtils(headers={"Authorization": tok}, content_type="application/json",
                               timeout=timeout).post_res(f"{self.url}{path}", json=body or {})
            try:
                data = res.json() if res is not None else {}
            except ValueError:
                data = {}
            if data.get("code") == 401 and attempt == 0:
                self._token = None
                continue
            if not data and attempt < 2:      # 隧道偶发断开/超时：无响应，等一下再试
                time.sleep(3)
                continue
            if data.get("code") != 200:
                why = f"{data.get('code')} {data.get('message')}" if data else \
                    f"HTTP {getattr(res, 'status_code', '无响应')} {(getattr(res, 'text', '') or '')[:60]}"
                raise ClientError(f"OpenList {path} {(body or {}).get('path', '')[-50:]}: {why}")
            return data.get("data")
        return None

    # ---- 文件 ----
    def get(self, p: str) -> Optional[dict]:
        """文件/目录信息；不存在返回 None。"""
        try:
            return self.call("/api/fs/get", {"path": p})
        except ClientError as err:
            if "not found" in str(err).lower() or "object not found" in str(err).lower():
                return None
            raise

    def list(self, p: str, refresh: bool = False) -> List[dict]:
        """目录列表（per_page=0 取全部）。"""
        return (self.call("/api/fs/list", {"path": p, "refresh": refresh, "per_page": 0}) or {}).get("content") or []

    def refresh_path(self, p: str, base_depth: int = 3) -> None:
        """从 base_depth 层开始逐级刷新目录缓存（新目录在父目录缓存过期前会报 object not found）。"""
        parts = p.rstrip("/").split("/")
        for k in range(base_depth + 1, len(parts) + 1):
            try:
                self.list("/".join(parts[:k - 1]), refresh=True)
            except ClientError:
                return

    def walk(self, p: str):
        """递归列出 (完整路径, 信息)。"""
        for it in self.list(p, refresh=True):
            full = f"{p}/{it['name']}"
            if it.get("is_dir"):
                yield from self.walk(full)
            else:
                yield full, it

    def mkdir(self, p: str) -> None:
        self.call("/api/fs/mkdir", {"path": p})

    def rename(self, p: str, name: str) -> None:
        self.call("/api/fs/rename", {"path": p, "name": name})

    def move(self, src_dir: str, dst_dir: str, names: List[str]) -> None:
        self.call("/api/fs/move", {"src_dir": src_dir, "dst_dir": dst_dir, "names": names})

    def copy(self, src_dir: str, dst_dir: str, names: List[str]) -> None:
        self.call("/api/fs/copy", {"src_dir": src_dir, "dst_dir": dst_dir, "names": names})

    def remove(self, d: str, names: List[str]) -> None:
        self.call("/api/fs/remove", {"dir": d, "names": names})

    def copy_undone(self) -> List[str]:
        """未完成的复制任务名（包含源/目标路径）。"""
        res = RequestUtils(headers={"Authorization": self._token or self._login()}, timeout=30).get_res(
            f"{self.url}/api/task/copy/undone")
        try:
            return [t.get("name", "") for t in (res.json().get("data") or [])]
        except Exception:  # noqa: BLE001
            return []

    def put(self, p: str, content: bytes) -> None:
        """写文件（本地存储直接落盘）。"""
        # 经 SSH 隧道上传约 150 KB/s：超时按大小放宽；无响应重试一次
        timeout = 60 + len(content) // 50_000
        for attempt in (0, 1, 2):
            tok = self._token or self._login()
            res = RequestUtils(headers={"Authorization": tok, "File-Path": urllib.parse.quote(p),
                                        "As-Task": "false"}, content_type="application/octet-stream",
                               timeout=timeout).put_res(f"{self.url}/api/fs/put", data=content)
            data = res.json() if res is not None else {}
            if (data.get("code") == 401 or res is None) and attempt < 2:
                self._token = None if data.get("code") == 401 else self._token
                continue
            if data.get("code") != 200:
                raise ClientError(f"OpenList put {p}: {data.get('message') or getattr(res, 'status_code', '-')}")
            return

    def sign_url(self, p: str, public: bool = True) -> str:
        """/d 直链（带 sign）。public=True 用于写进 strm，False 供插件自己读。"""
        info = self.get(p) or {}
        q = urllib.parse.quote(p, safe="/")
        base = self.public if public else self.url
        return f"{base}/d{q}" + (f"?sign={info['sign']}" if info.get("sign") else "")

    def read(self, p: str, rng: Optional[str] = None, timeout: int = 120) -> bytes:
        """读文件内容（可带 Range）。"""
        headers = {"User-Agent": UA}
        if rng:
            headers["Range"] = rng
        res = RequestUtils(headers=headers, timeout=timeout).get_res(self.sign_url(p, public=False))
        if res is None or res.status_code not in (200, 206):
            raise ClientError(f"读取失败 {p}: {getattr(res, 'status_code', '无响应')}")
        return res.content

    def remote_of_strm(self, stub: str) -> Optional[str]:
        """读 strm 内容，取出它指向的 OpenList 路径。"""
        try:
            u = self.read(stub).decode("utf-8", "ignore").strip()
        except ClientError:
            return None
        m = re.match(r"https?://[^/]+/d(/[^?]+)", u)
        return urllib.parse.unquote(m.group(1)) if m else None


class Cloud115:
    """115 网页接口（离线下载、建目录、任务列表）。cookie 与 OpenList 的 115 存储同一份，经 NAS SOCKS 出口访问。"""

    def __init__(self, cookie: str, proxy: Optional[str] = None):
        self.cookie = cookie.strip()
        self.proxies = {"http": proxy, "https": proxy} if proxy else None

    def _req(self, url: str, data: Optional[dict] = None) -> dict:
        ru = RequestUtils(headers={"Cookie": self.cookie, "User-Agent": UA}, proxies=self.proxies, timeout=60)
        res = ru.post_res(url, data=data) if data is not None else ru.get_res(url)
        if res is None:
            raise ClientError(f"115 无响应：{url[:60]}")
        try:
            return res.json()
        except ValueError as err:
            raise ClientError(f"115 返回非 JSON（cookie 失效？）：{res.text[:80]}") from err

    def mkdir_p(self, path: str) -> str:
        """逐级建目录，返回最后一级 cid。path 是 115 内路径（不带 /115 前缀）。"""
        cid, cur = "0", ""
        for part in path.strip("/").split("/"):
            cur += "/" + part
            got = str(self._req("https://webapi.115.com/files/getid?path=" + urllib.parse.quote(cur)).get("id"))
            if got == "0":
                got = str(self._req("https://webapi.115.com/files/add", {"pid": cid, "cname": part}).get("cid"))
            cid = got
        return cid

    def _sign(self) -> Dict[str, str]:
        sp = self._req("https://115.com/?ct=offline&ac=space")
        uid = re.search(r"UID=(\d+)", self.cookie)
        return {"uid": uid.group(1) if uid else "", "sign": sp["sign"], "time": sp["time"]}

    def offline_add(self, link: str, cid: str) -> tuple:
        """提交离线；返回 (ok, 错误信息)。errcode 10008 = 任务已存在，视为成功。"""
        r = self._req("https://115.com/web/lixian/?ct=lixian&ac=add_task_url",
                      {"url": link, "wp_path_id": cid, **self._sign()})
        return bool(r.get("state") or r.get("errcode") == 10008), r.get("error_msg") or ""

    def tasks(self, pages: int = 3) -> Dict[str, dict]:
        """离线任务 {info_hash: task}（status: 0/1 进行中，2 完成，-1 失败）。"""
        sign, out = self._sign(), {}
        for page in range(1, pages + 1):
            r = self._req("https://115.com/web/lixian/?ct=lixian&ac=task_lists", {"page": page, **sign})
            for t in r.get("tasks") or []:
                out[(t.get("info_hash") or "").lower()] = t
            if page >= int(r.get("page_count") or 1):
                break
        return out

    def task_del(self, info_hash: str) -> None:
        self._req("https://115.com/web/lixian/?ct=lixian&ac=task_del", {"hash[0]": info_hash, **self._sign()})


class QBit:
    """NAS qBittorrent WebUI（缓冲下载用）。"""

    def __init__(self, url: str, user: str, password: str):
        self.url, self.user, self.password = url.rstrip("/"), user, password
        self._ru: Optional[RequestUtils] = None

    def _session(self) -> RequestUtils:
        if self._ru is None:
            ru = RequestUtils(use_session=True, timeout=60, content_type="application/x-www-form-urlencoded")
            ru.post_res(f"{self.url}/api/v2/auth/login", data={"username": self.user, "password": self.password})
            self._ru = ru
        return self._ru

    def get(self, path: str, params: Optional[dict] = None) -> Any:
        res = self._session().get_res(f"{self.url}{path}", params=params)
        if res is None or res.status_code == 403:
            self._ru = None
            res = self._session().get_res(f"{self.url}{path}", params=params)
        try:
            return res.json()
        except Exception:  # noqa: BLE001
            return None

    def post(self, path: str, data: dict) -> int:
        res = self._session().post_res(f"{self.url}{path}", data=data)
        if res is not None and res.status_code == 403:
            self._ru = None
            res = self._session().post_res(f"{self.url}{path}", data=data)
        return getattr(res, "status_code", 0)

    def pause(self, h: str, pause: bool = True) -> None:
        """qB 5.x 用 stop/start，4.x 用 pause/resume。"""
        for p in (("stop", "pause") if pause else ("start", "resume")):
            if self.post(f"/api/v2/torrents/{p}", {"hashes": h}) == 200:
                return


class Emby:
    """Emby 查询（经 emby-relay）。"""

    def __init__(self, url: str, key: str, lib_root: str = "/media/library"):
        self.url, self.key, self.lib_root = url.rstrip("/"), key, lib_root.rstrip("/")

    def get(self, path: str, **params) -> Any:
        params["api_key"] = self.key
        res = RequestUtils(timeout=30).get_res(f"{self.url}/emby{path}", params=params)
        return res.json() if res is not None and res.status_code == 200 else None

    def post(self, path: str, body: Any = None, **params) -> Any:
        params["api_key"] = self.key
        res = RequestUtils(content_type="application/json", timeout=120).post_res(f"{self.url}/emby{path}", params=params,
                                                                                  json=body if body is not None else {})
        if res is None or res.status_code >= 400:
            raise ClientError(f"Emby {path}: {getattr(res, 'status_code', '无响应')}")
        try:
            return res.json()
        except ValueError:
            return None

    def folder_by_tmdb(self, tmdbid: Any, movie: bool, libs) -> Optional[tuple]:
        """已入库的同一 TMDb 条目 -> (库名, 目录名)。"""
        d = self.get("/Items", Recursive="true", IncludeItemTypes="Movie" if movie else "Series",
                     AnyProviderIdEquals=f"Tmdb.{tmdbid}", Fields="Path,ProviderIds") or {}
        for it in d.get("Items") or []:
            parts = (it.get("Path") or "").replace(self.lib_root, "", 1).strip("/").split("/")
            if len(parts) >= 2 and parts[0] in libs and str((it.get("ProviderIds") or {}).get("Tmdb", tmdbid)) == str(tmdbid):
                return parts[0], parts[1]
        return None

    def updated(self, paths: List[str]) -> None:
        """通知 Emby 这些目录有新文件。"""
        RequestUtils(content_type="application/json", timeout=60).post_res(
            f"{self.url}/emby/Library/Media/Updated?api_key={self.key}",
            json={"Updates": [{"Path": p, "UpdateType": "Created"} for p in paths]})


def now() -> int:
    return int(time.time())


