"""Offline harness for the Prowlarr115 plugin: stubs the MoviePilot / FastAPI modules and swaps 115, OpenList,
qBittorrent and Emby for in-memory fakes, so task state transitions run without any network."""
import copy
import os
import sys
import time
import types

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
PKG_DIR = os.path.join(os.path.dirname(HERE), "prowlarr115")


def _stub(name: str, **attrs) -> types.ModuleType:
    mod = sys.modules.get(name) or types.ModuleType(name)
    for k, v in attrs.items():
        setattr(mod, k, v)
    sys.modules[name] = mod
    return mod


class _Logger:
    def __getattr__(self, _):
        return lambda *a, **k: None


class _RequestUtils:
    def __init__(self, *a, **k):
        raise AssertionError("network call in a test")


for n in ("app", "app.sdk"):
    _stub(n)
_stub("app.sdk.logging", logger=_Logger())
_stub("app.sdk.network", RequestUtils=_RequestUtils)
_stub("fastapi", Body=lambda *a, **k: None, Request=object)
_stub("fastapi.responses", Response=object)
# Load the submodules without running the package __init__ (that one needs the whole MoviePilot runtime).
pkg = _stub("prowlarr115")
pkg.__path__ = [PKG_DIR]

from prowlarr115 import pipeline as pl  # noqa: E402
from prowlarr115 import hub as hub_mod  # noqa: E402

GB = 1 << 30


# ---------------- fakes ----------------
class FakeOL:
    """OpenList over an in-memory tree: path -> {size, is_dir, strm}."""

    def __init__(self):
        self.fs = {}
        self.removed = []
        self.shares = []

    def add(self, path: str, size: int = 0, strm: str = None, is_dir: bool = False):
        parts = path.rstrip("/").split("/")
        for i in range(2, len(parts)):
            self.fs.setdefault("/".join(parts[:i]), {"is_dir": True, "size": 0})
        self.fs[path] = {"is_dir": is_dir, "size": size, "strm": strm}

    def get(self, p):
        it = self.fs.get(p.rstrip("/"))
        return dict(it, name=p.rsplit("/", 1)[-1]) if it else None

    def list(self, p, refresh=False):
        p = p.rstrip("/")
        return [dict(v, name=k.rsplit("/", 1)[1]) for k, v in self.fs.items() if k.rsplit("/", 1)[0] == p]

    def walk(self, p):
        for it in self.list(p):
            full = f"{p}/{it['name']}"
            if it["is_dir"]:
                yield from self.walk(full)
            else:
                yield full, it

    def remove(self, d, names):
        for n in names:
            full = f"{d}/{n}"
            for k in [k for k in self.fs if k == full or k.startswith(full + "/")]:
                self.fs.pop(k)
            self.removed.append(full)

    def refresh_path(self, p, base_depth=3):
        pass

    def mkdir(self, p):
        self.add(p, is_dir=True)

    def share_list(self):
        return list(self.shares)

    def share_create(self, files, expires, remark):
        sh = {"id": f"s{len(self.shares) + 1}", "files": files, "expires": expires, "remark": remark}
        self.shares.append(sh)
        return sh

    def copy_undone(self):
        return []

    def read(self, p, rng):
        return b""

    def copy(self, src_dir, dst_dir, names):
        pass

    def remote_of_strm(self, stub):
        return (self.fs.get(stub) or {}).get("strm")


class Fake115:
    def __init__(self):
        self.list_ = {}       # hash -> offline task info
        self.deleted = []
        self.fail_list = False

    def tasks(self, pages=2):
        if self.fail_list:
            raise pl.ClientError("115 无响应")
        return copy.deepcopy(self.list_)

    def task_del(self, h):
        self.deleted.append(h)
        self.list_.pop(h, None)

    def mkdir_p(self, d):
        return "cid"

    def offline_add(self, url, cid):
        return True, ""


class FakeQB:
    def __init__(self, ok=True):
        self.ok = ok
        self.posts = []
        self.torrents = []

    def post(self, path, data=None):
        self.posts.append((path, data))
        return 200 if self.ok else 500

    def get(self, path, params=None):
        if path.endswith("/torrents/info"):
            return self.torrents
        return []

    def pause(self, h, on):
        pass


class FakeEmby:
    lib_root = "/media/library"

    def __init__(self):
        self.updates = []
        self.items = {}          # id -> item; children: parent id -> [items]
        self.children = {}

    def get(self, path, **q):
        if q.get("Ids"):
            return {"Items": [self.items[q["Ids"]]] if q["Ids"] in self.items else []}
        return {"Items": self.children.get(q.get("ParentId"), [])}

    def updated(self, paths):
        self.updates += paths

    def nudge(self, *a, **k):
        return "scan"


class Store:
    """Plugin data (tasks, events): copies on load/save like MP's plugin data table."""

    def __init__(self):
        self.tasks, self.events = {}, {}
        self.notes, self.logs = [], []

    def load(self):
        return copy.deepcopy(self.tasks)

    def save(self, t):
        self.tasks = copy.deepcopy(t)

    def ev_load(self):
        return copy.deepcopy(self.events)

    def ev_save(self, e):
        self.events = copy.deepcopy(e)


CONF = {"root": "/115/Emby", "lib_ol_root": "/lib", "openlist_url": "x", "openlist_user": "u", "openlist_pass": "p",
        "openlist_public": "http://ol", "cookie_115": "c", "qb_url": "http://qb", "qb_user": "u", "qb_pass": "p",
        "emby_url": "http://emby", "emby_key": "k", "emby_lib_root": "/media/library"}


@pytest.fixture
def env(monkeypatch):
    s = Store()
    ol, c115, qb, emby = FakeOL(), Fake115(), FakeQB(), FakeEmby()
    monkeypatch.setattr(pl, "OpenList", lambda *a, **k: ol)
    monkeypatch.setattr(pl, "Cloud115", lambda *a, **k: c115)
    monkeypatch.setattr(pl, "QBit", lambda *a, **k: qb)
    monkeypatch.setattr(pl, "Emby", lambda *a, **k: emby)
    p = pl.Pipeline(dict(CONF), s.load, s.save, lambda t, x: s.notes.append(f"{t} {x}"), s.logs.append, s.ev_load, s.ev_save)
    p.failures = []
    p.on_fail = lambda h, t, why: p.failures.append((h, t["status"], why))
    p.on_ok = lambda h: None
    monkeypatch.setattr(p, "autosubs", lambda t, made: "")
    return types.SimpleNamespace(p=p, s=s, ol=ol, c115=c115, qb=qb, emby=emby)


H = "a" * 40
H2 = "b" * 40
SEASON = "/115/Emby/动漫/药屋少女的呢喃 (2023) [tmdbid=220542]/Season 1"


def task(**kw) -> dict:
    t = {"dir": SEASON, "title": "x", "url": f"magnet:?xt=urn:btih:{H}", "added": int(time.time()), "status": "downloading",
         "meta": {"tmdbid": 220542, "season": 1, "episodes": [5], "ep_offset": 48, "pick": {"by": "subscription"}},
         "ts": {"submitted": int(time.time()), "select": int(time.time())}}
    t.update(kw)
    return t


def events(env, h=H):
    return [(r[1], r[2], r[3]) for r in env.s.events.get(h, [])]
