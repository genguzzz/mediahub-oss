"""Emby item → OpenList temporary share: movie / episode share the file, series share the work folder with per-episode links."""
import types

from conftest import GB, hub_mod

Hub = hub_mod.Hub
MOVIE_115 = "/115/Emby/电影/两杆大烟枪 (1998) [tmdbid=100]/Lock Stock 1998 1080p.mkv"
SHOW = "/115/Emby/剧集/X (2020) [tmdbid=7]"


def make_hub(env, conf=None):
    plugin = types.SimpleNamespace(_pipe=env.p, _adult=None, _load_tasks=env.s.load, _save_tasks=env.s.save,
                                   get_data=lambda k: None, _conf=conf if conf is not None else {"openlist_share_base": "https://share.example:5243"})
    return Hub(plugin)


def lib(p):
    return "/media/library" + p


def seed_movie(env):
    env.ol.add("/lib/电影/两杆大烟枪 (1998)/两杆大烟枪 (1998).strm", 1, strm=MOVIE_115)
    env.emby.items["m1"] = {"Id": "m1", "Type": "Movie", "Name": "两杆大烟枪", "Path": lib("/电影/两杆大烟枪 (1998)/两杆大烟枪 (1998).strm")}


def seed_show(env):
    env.emby.items["s1"] = {"Id": "s1", "Type": "Series", "Name": "X"}
    eps = []
    for se, ep, rel in [(1, 2, "Season 1/[G] X - 02.mkv"), (1, 1, "Season 1/[G] X - 01.mkv"), (2, 1, "Season 2/pack/X S02E01.mkv")]:
        stub = f"/lib/剧集/X/Season {se}/S{se:02d}E{ep:02d}.strm"
        env.ol.add(stub, 1, strm=f"{SHOW}/{rel}")
        eps.append({"Type": "Episode", "Name": f"第{ep}集", "ParentIndexNumber": se, "IndexNumber": ep, "Path": lib(stub[4:])})
    env.emby.children["s1"] = eps


def test_movie_shares_the_file(env):
    seed_movie(env)
    r = make_hub(env).emby_share({"id": "m1"})
    assert r["ok"] and r["url"] == "https://share.example:5243/@s/s1"
    assert env.ol.shares[0]["files"] == [MOVIE_115] and env.ol.shares[0]["remark"] == "mediahub:m1"
    assert r["files"] == [{"name": "两杆大烟枪", "url": "https://share.example:5243/sd/s1"}]


def test_series_shares_work_folder_with_episode_links_in_order(env):
    seed_show(env)
    r = make_hub(env).emby_share({"id": "s1"})
    assert r["ok"] and env.ol.shares[0]["files"] == [SHOW]
    assert [f["name"] for f in r["files"]] == ["S01E01 第1集", "S01E02 第2集", "S02E01 第1集"]
    assert r["files"][0]["url"] == "https://share.example:5243/sd/s1/Season%201/%5BG%5D%20X%20-%2001.mkv"
    assert r["files"][2]["url"].endswith("/Season%202/pack/X%20S02E01.mkv")


def test_existing_share_is_reused_while_it_has_time_left(env):
    seed_movie(env)
    hub = make_hub(env)
    a = hub.emby_share({"id": "m1", "hours": 72})
    b = hub.emby_share({"id": "m1", "hours": 72})
    assert a["id"] == b["id"] and b["reused"] and len(env.ol.shares) == 1


def test_expiring_share_is_replaced(env):
    seed_movie(env)
    env.ol.shares.append({"id": "old", "files": [MOVIE_115], "expires": "2000-01-01T00:00:00Z", "remark": "mediahub:m1"})
    r = make_hub(env).emby_share({"id": "m1"})
    assert r["id"] != "old" and not r["reused"]


def test_not_on_115(env):
    env.ol.add("/lib/电影/Y/Y.strm", 1, strm="/nas/local/Y.mkv")
    env.emby.items["m2"] = {"Id": "m2", "Type": "Movie", "Name": "Y", "Path": lib("/电影/Y/Y.strm")}
    r = make_hub(env).emby_share({"id": "m2"})
    assert not r["ok"] and "不在 115" in r["error"] and env.ol.shares == []


def test_falls_back_to_public_base(env):
    seed_movie(env)
    env.ol.public = "http://lan-openlist:5244"
    assert make_hub(env, conf={}).emby_share({"id": "m1"})["url"] == "http://lan-openlist:5244/@s/s1"


def test_bad_id_and_unknown_item(env):
    hub = make_hub(env)
    assert hub.emby_share({"id": "../x"})["error"] == "id 不对"
    assert hub.emby_share({"id": "nope"})["error"] == "Emby 里没有这个条目"
