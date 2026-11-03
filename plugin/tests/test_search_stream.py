"""Progressive smart search (hub.search_stream): one source per keyword x indexer, results merged as each answers,
per-source paging (only sources whose last page worked get the next one), shared jobs and cancel."""
import sys
import threading
import time
import types

import pytest

from conftest import hub_mod
from prowlarr115.policy import load_policy

Hub = hub_mod.Hub


def magnet(n):
    return f"magnet:?xt=urn:btih:{n:040x}"


class T:   # TorrentInfo stand-in
    def __init__(self, n, title, site="Prowlarr·X"):
        self.title, self.enclosure, self.site_name = title, magnet(n), site
        self.size, self.seeders, self.peers, self.pubdate, self.page_url, self.description = 2e9, 10, 1, "", "", "X"


class FakeChain:
    """MP matcher stand-in: keeps torrents whose title contains 仁医 / JIN (what MP's identity match does)."""
    def _parse_result(self, torrents, mediainfo, keyword=None, season_episodes=None):
        meta = types.SimpleNamespace(begin_season=1, episode_list=[])
        return [types.SimpleNamespace(torrent_info=t, meta_info=meta) for t in torrents if "仁医" in t.title or "JIN" in t.title]


@pytest.fixture
def hub(monkeypatch):
    chain_mod = types.ModuleType("app.chain.search")
    chain_mod.SearchChain = FakeChain
    monkeypatch.setitem(sys.modules, "app.chain", types.ModuleType("app.chain"))
    monkeypatch.setitem(sys.modules, "app.chain.search", chain_mod)
    media = types.SimpleNamespace(title="仁医", tmdb_id=46198, year="2009", seasons={1: [1] * 11},
                                  type=types.SimpleNamespace(value="电视剧"), season=None)
    monkeypatch.setattr(hub_mod.batch_mod, "_recognize", lambda q: media)
    monkeypatch.setattr(hub_mod.batch_mod, "_emby_eps", lambda p, m, s: set())
    monkeypatch.setattr(hub_mod.batch_mod, "_aired", lambda m, s: list(range(1, 12)))
    pages = {}          # (query, indexer id) -> list of pages: each page is a list of T, or an Exception
    calls = []
    gate = {}           # (query, indexer id) -> Event the fetch waits on (to control arrival order)

    def prowlarr_page(q, mtype, indexers, offset=0, limit=100):
        k = (q, indexers[0])
        calls.append((k, offset))
        if k in gate:
            gate[k].wait(5)
        page = (pages.get(k) or [])[offset // limit] if offset // limit < len(pages.get(k) or []) else []
        if isinstance(page, Exception):
            raise page
        return list(page), len(page)

    plugin = types.SimpleNamespace(
        _pipe=None, _adult=None, _policy=lambda: load_policy(None),
        _target_plan=lambda kw, target, seasons: types.SimpleNamespace(queries=["仁医", "JIN"], direct=None),
        _target_filter=lambda plan, batches, log=True: [t for b in batches for t in b],
        _prowlarr_page=prowlarr_page, _search_anime=lambda *a: [])
    h = Hub(plugin)
    Hub._jobs.clear()
    monkeypatch.setattr(h, "_stream_indexers", lambda media: [(1, "TorrentKitty"), (2, "LimeTorrents")])
    h.pages, h.calls, h.gate = pages, calls, gate
    return h


def wait_idle(h, job, timeout=5):
    end = time.time() + timeout
    while time.time() < end:
        r = h.search_poll(job, v=-1)
        if r["ok"] and not r["busy"] and r["round"] >= 1:
            return r
        time.sleep(0.02)
    raise AssertionError("search did not finish")


def test_first_round_merges_sources_and_marks_paging_state(hub):
    hub.pages[("仁医", 1)] = [[T(1, "[仁医] S01 1080p WEB-DL HEVC"), T(2, "无关 资源")], [T(3, "仁医 S01E05 720p")]]
    hub.pages[("仁医", 2)] = [RuntimeError("Prowlarr 返回 500")]
    hub.pages[("JIN", 1)] = [[T(1, "[仁医] S01 1080p WEB-DL HEVC"), T(4, "JIN S01 BluRay 1080p")]]
    hub.pages[("JIN", 2)] = [[]]
    job = hub.search_stream({"tmdbid": 46198, "type": "tv"})["job"]
    r = wait_idle(hub, job)
    assert [x["id"] for x in r["results"]] and {x["id"] for x in r["results"]} == {f"{1:040x}", f"{4:040x}"}
    assert r["season"] == 1 and r["more"] is True
    # first keyword goes to every indexer before the second keyword
    assert [k for k, off in hub.calls][:2] == [("仁医", 1), ("仁医", 2)]
    st = {x["name"]: x["state"] for x in r["tasks"]}
    assert st == {"TorrentKitty": "more", "LimeTorrents": "error"}


def test_more_pages_only_sources_that_worked(hub):
    hub.pages[("仁医", 1)] = [[T(1, "仁医 S01 1080p")], [T(3, "仁医 S01E05 720p")]]
    hub.pages[("仁医", 2)] = [RuntimeError("timeout")]
    hub.pages[("JIN", 1)] = [[T(4, "JIN S01 1080p")]]          # page 2 empty -> end
    hub.pages[("JIN", 2)] = [[]]                               # empty first page -> end, never asked again
    job = hub.search_stream({"tmdbid": 46198, "type": "tv"})["job"]
    wait_idle(hub, job)
    hub.calls.clear()
    assert hub.search_more({"job": job})["started"] == 2       # 仁医@1 and JIN@1; not the failed or empty ones
    r = wait_idle(hub, job)
    assert sorted(hub.calls) == [(("JIN", 1), 100), (("仁医", 1), 100)]
    assert f"{3:040x}" in {x["id"] for x in r["results"]}
    hub.calls.clear()
    hub.search_more({"job": job})                              # 仁医@1 page 3 is empty -> end; JIN@1 already ended
    wait_idle(hub, job)
    assert hub.search_more({"job": job})["started"] == 0 and hub.search_poll(job)["more"] is False


def test_source_repeating_its_first_page_ends(hub):
    p1 = [T(1, "仁医 S01 1080p")]
    hub.pages[("仁医", 1)] = [p1, p1]                         # indexer ignores offset
    job = hub.search_stream({"tmdbid": 46198, "type": "tv"})["job"]
    wait_idle(hub, job)
    hub.search_more({"job": job})
    r = wait_idle(hub, job)
    assert {x["name"]: x["state"] for x in r["tasks"]}["TorrentKitty"] == "end"


def test_results_arrive_before_slow_sources_and_poll_wait_wakes(hub):
    hub.pages[("仁医", 1)] = [[T(1, "仁医 S01 1080p")]]
    hub.pages[("仁医", 2)] = [[T(2, "仁医 S01 720p")]]
    for k in [("仁医", 2), ("JIN", 1), ("JIN", 2)]:
        hub.gate[k] = threading.Event()
    job = hub.search_stream({"tmdbid": 46198, "type": "tv"})["job"]
    end = time.time() + 5
    r = hub.search_poll(job, v=-1)
    while not r.get("results") and time.time() < end:
        r = hub.search_poll(job, v=r["v"], wait=2)             # blocks until something changes
    assert [x["id"] for x in r["results"]] == [f"{1:040x}"] and r["busy"]
    t0 = time.time()
    threading.Timer(0.2, hub.gate[("仁医", 2)].set).start()
    r2 = hub.search_poll(job, v=r["v"], wait=5)
    assert time.time() - t0 < 3 and r2["v"] != r["v"]
    for e in hub.gate.values():
        e.set()
    assert len(wait_idle(hub, job)["results"]) == 2


def test_same_search_is_shared_and_stops_when_last_viewer_leaves(hub):
    hub.gate[("仁医", 1)] = threading.Event()
    a = hub.search_stream({"tmdbid": 46198, "type": "tv", "season": 1})
    b = hub.search_stream({"tmdbid": 46198, "type": "tv", "season": 1})
    assert a["job"] == b["job"] and b["reused"] and not a["reused"]
    assert hub.search_cancel({"job": a["job"]})["stopped"] is False      # one viewer left, the other still watches
    assert hub.search_cancel({"job": a["job"]})["stopped"] is True
    hub.gate[("仁医", 1)].set()
    r = wait_idle(hub, a["job"])
    assert r["cancelled"] and hub.search_more({"job": a["job"]})["ok"] is False
    c = hub.search_stream({"tmdbid": 46198, "type": "tv", "season": 1})   # a cancelled search is not reused
    assert c["reused"] is False


def test_finished_search_is_reused_unless_forced(hub):
    hub.pages[("仁医", 1)] = [[T(1, "仁医 S01 1080p")]]
    job = hub.search_stream({"tmdbid": 46198, "type": "tv"})["job"]
    wait_idle(hub, job)
    n = len(hub.calls)
    assert hub.search_stream({"tmdbid": 46198, "type": "tv"})["reused"] is True and len(hub.calls) == n
    assert hub.search_stream({"tmdbid": 46198, "type": "tv", "force": True})["reused"] is False


def test_status_only_changes_do_not_resend_results(hub):
    hub.pages[("仁医", 1)] = [[T(1, "仁医 S01 1080p")]]
    job = hub.search_stream({"tmdbid": 46198, "type": "tv"})["job"]
    full = wait_idle(hub, job)
    assert full["results"] and full["rv"] >= 1
    again = hub.search_poll(job, v=full["v"] - 1, rv=full["rv"])     # newer status, same results
    assert "results" not in again and again["v"] == full["v"]
    assert "results" in hub.search_poll(job, v=full["v"] - 1, rv=full["rv"] - 1)
