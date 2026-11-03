"""Progressive search (hub.search_stream, coroutines): sources = keyword x indexer (smart) or keyword x picked source
(raw), results merged as each answers, per-source paging (only sources whose last page worked get the next one),
shared jobs, cancel aborts in-flight fetches, status-only changes don't resend results."""
import asyncio
import sys
import types

import pytest

from conftest import hub_mod
from prowlarr115.policy import load_policy
from prowlarr115.sources import DirectSource

Hub = hub_mod.Hub


def magnet(n):
    return f"magnet:?xt=urn:btih:{n:040x}"


class T:   # TorrentInfo stand-in
    def __init__(self, n, title):
        self.title, self.enclosure, self.site_name = title, magnet(n), "Prowlarr·X"
        self.size, self.seeders, self.peers, self.pubdate, self.page_url, self.description = 2e9, 10, 1, "", "", "X"


class FakeChain:
    """MP matcher stand-in: keeps torrents whose title contains 仁医 / JIN (MP's identity match)."""
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
    plugin = types.SimpleNamespace(
        _pipe=None, _adult=None, _policy=lambda: load_policy(None), _prowlarr_url="http://prowlarr", _prowlarr_key="k", _timeout=30,
        _target_plan=lambda kw, target, seasons: types.SimpleNamespace(queries=["仁医", "JIN"], direct=None),
        _target_filter=lambda plan, batches, log=True: [t for b in batches for t in b],
        _prowlarr_torrents=lambda rows, q, mtype, log=True: list(rows), _search_anime=lambda *a: [])
    h = Hub(plugin)
    Hub._jobs.clear()
    h.pages, h.calls, h.gate = {}, [], {}

    async def prowlarr_json(q, iid, offset):     # pages[(q, iid)] = [page1, page2…]; a page is a list or an Exception
        k = (q, iid)
        h.calls.append((k, offset))
        if k in h.gate:
            await h.gate[k].wait()
        pages = h.pages.get(k) or []
        page = pages[offset // h.PAGE_SIZE] if offset // h.PAGE_SIZE < len(pages) else []
        if isinstance(page, Exception):
            raise page
        return list(page)
    monkeypatch.setattr(h, "_prowlarr_json", prowlarr_json)
    monkeypatch.setattr(h, "_stream_indexers", lambda media: [(1, "TorrentKitty"), (2, "LimeTorrents")])
    monkeypatch.setattr(h, "_usable_indexers", lambda ids: ([1], ""))
    monkeypatch.setattr(h, "_pw", lambda m, path, timeout=15: (200, [{"id": 1, "name": "TorrentKitty"}]))
    return h


def run(coro):
    return asyncio.run(coro)


async def idle(h, job, timeout=5):
    async def loop():
        v = -1
        while True:
            r = await h.search_poll(job, v=v, wait=1)
            if r["ok"] and not r["busy"] and r["round"] >= 1:
                return await h.search_poll(job, v=-1)
            v = r["v"]
    return await asyncio.wait_for(loop(), timeout)


def ids(r):
    return {x["id"] for x in r["results"]}


def test_first_round_merges_sources_and_marks_paging_state(hub):
    hub.pages[("仁医", 1)] = [[T(1, "[仁医] S01 1080p WEB-DL HEVC"), T(2, "无关 资源")], [T(3, "仁医 S01E05 720p")]]
    hub.pages[("仁医", 2)] = [RuntimeError("Prowlarr 返回 500")]
    hub.pages[("JIN", 1)] = [[T(1, "[仁医] S01 1080p WEB-DL HEVC"), T(4, "JIN S01 BluRay 1080p")]]
    hub.pages[("JIN", 2)] = [[]]

    async def go():
        job = (await hub.search_stream({"tmdbid": 46198, "type": "tv"}))["job"]
        return await idle(hub, job)
    r = run(go())
    assert ids(r) == {f"{1:040x}", f"{4:040x}"} and r["season"] == 1 and r["more"] is True
    assert [k for k, _ in hub.calls][:2] == [("仁医", 1), ("仁医", 2)]          # first keyword to every indexer first
    assert {x["name"]: x["state"] for x in r["tasks"]} == {"TorrentKitty": "more", "LimeTorrents": "error"}


def test_more_pages_only_sources_that_worked(hub):
    hub.pages[("仁医", 1)] = [[T(1, "仁医 S01 1080p")], [T(3, "仁医 S01E05 720p")]]
    hub.pages[("仁医", 2)] = [RuntimeError("timeout")]
    hub.pages[("JIN", 1)] = [[T(4, "JIN S01 1080p")]]
    hub.pages[("JIN", 2)] = [[]]

    async def go():
        job = (await hub.search_stream({"tmdbid": 46198, "type": "tv"}))["job"]
        await idle(hub, job)
        hub.calls.clear()
        assert (await hub.search_more({"job": job}))["started"] == 2           # not the failed / empty sources
        r = await idle(hub, job)
        assert sorted(hub.calls) == [(("JIN", 1), 100), (("仁医", 1), 100)]
        assert f"{3:040x}" in ids(r)
        await hub.search_more({"job": job})                                     # 仁医@1 page 3 empty -> end
        await idle(hub, job)
        assert (await hub.search_more({"job": job}))["started"] == 0
        assert (await hub.search_poll(job))["more"] is False
    run(go())


def test_source_repeating_its_first_page_ends(hub):
    p1 = [T(1, "仁医 S01 1080p")]
    hub.pages[("仁医", 1)] = [p1, p1]                                            # indexer ignores offset

    async def go():
        job = (await hub.search_stream({"tmdbid": 46198, "type": "tv"}))["job"]
        await idle(hub, job)
        await hub.search_more({"job": job})
        return await idle(hub, job)
    assert {x["name"]: x["state"] for x in run(go())["tasks"]}["TorrentKitty"] == "end"


def test_results_arrive_before_slow_sources_and_poll_wakes(hub):
    hub.pages[("仁医", 1)] = [[T(1, "仁医 S01 1080p")]]
    hub.pages[("仁医", 2)] = [[T(2, "仁医 S01 720p")]]

    async def go():
        for k in [("仁医", 2), ("JIN", 1), ("JIN", 2)]:
            hub.gate[k] = asyncio.Event()
        job = (await hub.search_stream({"tmdbid": 46198, "type": "tv"}))["job"]
        r = await hub.search_poll(job, v=-1)
        while not r.get("results"):
            r = await hub.search_poll(job, v=r["v"], wait=2)
        assert [x["id"] for x in r["results"]] == [f"{1:040x}"] and r["busy"]
        asyncio.get_running_loop().call_later(0.1, hub.gate[("仁医", 2)].set)
        r2 = await asyncio.wait_for(hub.search_poll(job, v=r["v"], wait=5), 2)  # woken by the change, not the timeout
        assert r2["v"] != r["v"]
        for e in hub.gate.values():
            e.set()
        assert len((await idle(hub, job))["results"]) == 2
    run(go())


def test_shared_job_and_last_viewer_cancels_in_flight(hub):
    async def go():
        hub.gate[("仁医", 1)] = asyncio.Event()                                  # never set: stays in flight
        a = await hub.search_stream({"tmdbid": 46198, "type": "tv", "season": 1})
        b = await hub.search_stream({"tmdbid": 46198, "type": "tv", "season": 1})
        assert a["job"] == b["job"] and b["reused"] and not a["reused"]
        await asyncio.sleep(0.05)
        assert (await hub.search_cancel({"job": a["job"]}))["stopped"] is False  # the other viewer still watches
        assert (await hub.search_cancel({"job": a["job"]}))["stopped"] is True
        r = await idle(hub, a["job"])
        assert r["cancelled"] and {x["name"]: x["state"] for x in r["tasks"]}["TorrentKitty"] == "cancelled"
        assert (await hub.search_more({"job": a["job"]}))["ok"] is False
        assert (await hub.search_stream({"tmdbid": 46198, "type": "tv", "season": 1}))["reused"] is False
    run(go())


def test_finished_search_is_reused_unless_forced(hub):
    hub.pages[("仁医", 1)] = [[T(1, "仁医 S01 1080p")]]

    async def go():
        job = (await hub.search_stream({"tmdbid": 46198, "type": "tv"}))["job"]
        await idle(hub, job)
        n = len(hub.calls)
        assert (await hub.search_stream({"tmdbid": 46198, "type": "tv"}))["reused"] is True and len(hub.calls) == n
        assert (await hub.search_stream({"tmdbid": 46198, "type": "tv", "force": True}))["reused"] is False
    run(go())


def test_status_only_changes_do_not_resend_results(hub):
    hub.pages[("仁医", 1)] = [[T(1, "仁医 S01 1080p")]]

    async def go():
        job = (await hub.search_stream({"tmdbid": 46198, "type": "tv"}))["job"]
        full = await idle(hub, job)
        assert full["results"] and full["rv"] >= 1
        again = await hub.search_poll(job, v=full["v"] - 1, rv=full["rv"])
        assert "results" not in again
        assert "results" in await hub.search_poll(job, v=full["v"] - 1, rv=full["rv"] - 1)
    run(go())


def test_raw_mode_uses_registry_sources_with_their_own_paging(hub, monkeypatch):
    pages = {1: [{"title": "仁医 S01 BD", "magnet": magnet(7), "size": 1e9, "seeders": 5, "site": "Nyaa"}], 2: []}
    monkeypatch.setitem(hub_mod.DIRECT_SOURCES, "nyaa", DirectSource(
        "nyaa", "Nyaa", "direct", "", "en", (), "", lambda ctx, q, page: pages.get(page, []), paged=True))
    monkeypatch.setitem(hub_mod.DIRECT_SOURCES, "mikan", DirectSource(
        "mikan", "Mikan", "direct", "", "zh", (), "", lambda ctx, q, page: [{"title": "仁医 合集", "magnet": magnet(8), "size": 0, "seeders": 1}]))
    hub.pages[("仁医", 1)] = [[{"title": "Jin S01", "magnetUrl": magnet(9)}]]
    monkeypatch.setattr(hub, "_prowlarr_map", lambda rows, q: [{"title": r["title"], "magnet": r["magnetUrl"], "size": 1, "seeders": 3, "indexer": "TorrentKitty"} for r in rows])

    async def go():
        job = (await hub.search_stream({"mode": "raw", "keywords": ["仁医"], "sources": ["nyaa", "mikan", "prowlarr", "nope"]}))["job"]
        r = await idle(hub, job)
        assert ids(r) == {f"{7:040x}", f"{8:040x}", f"{9:040x}"} and r["mode"] == "raw"
        st = {x["name"]: x["state"] for x in r["tasks"]}
        assert st == {"Nyaa": "more", "Mikan": "end", "TorrentKitty": "more"}  # Mikan has one page; unknown "nope" ignored
        assert {x["source"] for x in r["results"]} >= {"Nyaa", "TorrentKitty"}
        assert (await hub.search_more({"job": job}))["started"] == 2              # Nyaa and TorrentKitty, not Mikan
        r = await idle(hub, job)
        assert {x["name"]: x["state"] for x in r["tasks"]} == {"Nyaa": "end", "Mikan": "end", "TorrentKitty": "end"}
    run(go())
    assert hub.calls == [(("仁医", 1), 0), (("仁医", 1), 100)]


def test_raw_mode_needs_keywords_and_sources(hub):
    assert run(hub.search_stream({"mode": "raw", "keywords": [], "sources": ["nyaa"]}))["ok"] is False


def test_usable_indexers_drops_gone_quietly_and_notes_paused(hub, monkeypatch):
    from datetime import datetime, timedelta, timezone
    soon = (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat()
    ix = [{"id": 1, "name": "TorrentKitty", "protocol": "torrent", "enable": True},
          {"id": 2, "name": "YTS", "protocol": "torrent", "enable": True},
          {"id": 3, "name": "0Magnet", "protocol": "torrent", "enable": False}]
    monkeypatch.setattr(hub, "_pw", lambda m, path, timeout=15: (200, ix if path == "/indexer" else [{"indexerId": 2, "disabledTill": soon}]))
    hub.p._exclude_indexers = []
    keep, note = Hub._usable_indexers(hub, [1, 2, 3, 11])      # 3 switched off, 11 deleted: not mentioned
    assert keep == [1] and note.startswith("YTS 暂停中") and "0Magnet" not in note and "索引器" not in note
    keep, note = Hub._usable_indexers(hub, None)                # "all" = enabled ones
    assert keep == [1] and "YTS" in note


def test_raw_all_indexers_wins_over_single_picks_and_notice_is_not_error(hub, monkeypatch):
    seen = {}
    monkeypatch.setattr(hub, "_usable_indexers", lambda ids: (seen.setdefault("ids", ids), ([1], "YTS 暂停中，已跳过"))[1])
    hub.pages[("仁医", 1)] = [[{"title": "Jin S01", "magnetUrl": magnet(9)}]]
    monkeypatch.setattr(hub, "_prowlarr_map", lambda rows, q: [{"title": r["title"], "magnet": r["magnetUrl"], "size": 1, "seeders": 3, "site": "TorrentKitty"} for r in rows])

    async def go():
        job = (await hub.search_stream({"mode": "raw", "keywords": ["仁医"], "sources": ["prowlarr", "prowlarr:3", "prowlarr:11"]}))["job"]
        return await idle(hub, job)
    r = run(go())
    assert seen["ids"] is None                                   # 「全部」包含单选的那些
    assert r["error"] is None and r["notice"] == "YTS 暂停中，已跳过"


def test_job_id_stays_short_for_long_source_lists(hub):
    srcs = ["prowlarr"] + [f"prowlarr:{i}" for i in range(40)] + ["nyaa", "mikan", "dmhy"]

    async def go():
        r = await hub.search_stream({"mode": "raw", "keywords": ["Coherence", "彗星来的那一夜"], "sources": srcs})
        assert len(r["job"]) == 16
        await idle(hub, r["job"])
        assert (await hub.search_more({"job": r["job"]}))["ok"] is True
    run(go())
