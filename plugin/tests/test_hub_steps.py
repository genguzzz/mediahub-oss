"""What the App sees: step nodes per status, list row fields, event grouping, and task delete."""
import types

import pytest

from conftest import GB, H, H2, SEASON, events, hub_mod, task

Hub = hub_mod.Hub
KEYS = ["select", "submit", "download", "strm", "scrape", "finish"]


def states(t):
    return [s["state"] for s in Hub._steps(t)[1]]


def make_hub(env):
    plugin = types.SimpleNamespace(_pipe=env.p, _adult=None, _load_tasks=env.s.load, _save_tasks=env.s.save,
                                   get_data=lambda k: env.s.ev_load() if k == "events" else None)
    return Hub(plugin)


@pytest.mark.parametrize("status,extra,expect", [
    ("downloading", {}, ["done", "done", "active", "pending", "pending", "pending"]),
    ("downloading", {"ts": {"submitted": 1, "offline": 2}}, ["done", "done", "done", "active", "pending", "pending"]),
    ("buffer", {}, ["done", "done", "active", "pending", "pending", "pending"]),
    ("uploaded", {}, ["done", "done", "done", "active", "pending", "pending"]),
    ("done", {}, ["done", "done", "done", "done", "active", "pending"]),
    ("done", {"emby": 5}, ["done"] * 6),
    ("done", {"emby": -5}, ["done", "done", "done", "done", "error", "pending"]),
    ("scraping", {}, ["done", "done", "done", "done", "active", "pending"]),
    ("dead", {}, ["done", "done", "error", "pending", "pending", "pending"]),
    ("too-big", {}, ["done", "done", "error", "pending", "pending", "pending"]),
    ("no-video", {}, ["done", "done", "done", "error", "pending", "pending"]),
    ("strm-failed", {}, ["done", "done", "done", "error", "pending", "pending"]),
    ("needs-id", {}, ["done", "done", "done", "error", "pending", "pending"]),
    ("scrape-failed", {}, ["done", "done", "done", "done", "error", "pending"]),
    ("cancelled", {}, ["done", "done", "skipped", "skipped", "skipped", "skipped"]),
])
def test_step_states(status, extra, expect):
    assert states(task(status=status, **extra)) == expect


def test_failed_task_has_no_times_after_the_failed_step():
    """A dead download used to show 「Emby 刮削 10:20 起」 because the failure time was taken as later steps' start."""
    t = task(status="dead", done=500, fail_reason="115 离线列表里 1 小时都找不到这个任务", ts={"submitted": 100, "failed": 400})
    stage, steps, failed = Hub._steps(t)
    assert failed and stage == "下载失败：115 离线列表里 1 小时都找不到这个任务"
    dl = steps[2]
    assert (dl["start"], dl["end"]) == (100, 400)
    assert all(s["start"] is None and s["end"] is None for s in steps[3:])


def test_active_step_has_no_end():
    steps = Hub._steps(task(status="uploaded", ts={"submitted": 1, "offline": 2, "strm_start": 3}))[1]
    assert steps[3]["state"] == "active" and steps[3]["start"] == 3 and steps[3]["end"] is None


def test_labels_per_kind():
    av = Hub._steps(task(status="uploaded", meta={"kind": "av"}))[1]
    assert [s["label"] for s in av][3:5] == ["写入 MDC 收件箱", "MDC 刮削整理"]
    buf = Hub._steps(task(status="buffer", buffer={"since": 1}))[1]
    assert buf[2]["label"] == "NAS 缓冲"


def test_row_fields_episode_offset_source_and_buffer_deadline(env):
    env.s.tasks = {H: task(added=1000, size=3 * GB)}
    row = make_hub(env).pipeline(live=False)["tasks"][0]
    assert row["episodes"] == [53]                 # subscription S3E05 → library S1E53 (ep_offset 48)
    assert row["source"] == "订阅更新"
    assert row["bufferAt"] == 1000 + 3 * 3600
    assert "failAt" not in row


def test_no_buffer_deadline_once_downloaded_or_buffering(env):
    env.s.tasks = {H: task(ts={"offline": 5}), H2: task(status="buffer", buffer={"since": 1})}
    rows = {r["hash"]: r for r in make_hub(env).pipeline(live=False)["tasks"]}
    assert rows[H]["bufferAt"] is None and rows[H2]["bufferAt"] is None


def test_failure_notes_grouped_under_failed_step(env):
    env.s.tasks = {H: task(status="dead", ts={"submitted": 1, "failed": 2})}
    env.p.event(H, "offline", "115 离线列表里暂时找不到", "warn")
    env.p.event(H, "manual", "已拉黑这个资源，并把第 5 集从订阅「x」的已下载里去掉")
    hub = make_hub(env)
    evs = hub.task_events(H)["events"]
    assert [e["group"] for e in evs] == ["download", "download"]
    row = hub.pipeline(live=False)["tasks"][0]
    dl = row["steps"][2]
    assert dl["events"] == 2 and dl["last"].startswith("已拉黑") and row["steps"][5]["events"] == 0


def test_manual_events_stay_on_finish_when_not_failed(env):
    env.s.tasks = {H: task(status="cancelled")}
    env.p.event(H, "manual", "已取消")
    assert make_hub(env).task_events(H)["events"][0]["group"] == "finish"


# ---------------- delete ----------------
LIB = "/lib/动漫/药屋少女的呢喃 (2023) [tmdbid=220542]/Season 1"


def seed_done(env, other_episode=True):
    """A finished episode: 115 file + subtitle, strm + subtitle in the library; optionally another episode beside it."""
    env.ol.add(f"{SEASON}/[SubsPlease] S01E53.mkv", GB)
    env.ol.add(f"{SEASON}/[SubsPlease] S01E53.ass", 10)
    env.ol.add(f"{LIB}/S01E53.strm", 1, strm=f"{SEASON}/[SubsPlease] S01E53.mkv")
    env.ol.add(f"{LIB}/S01E53.zh.ass", 10)
    if other_episode:
        env.ol.add(f"{SEASON}/S01E52.mkv", GB)
        env.ol.add(f"{LIB}/S01E52.strm", 1, strm=f"{SEASON}/S01E52.mkv")
    env.s.tasks = {H: task(status="done", emby=5, name="[SubsPlease] S01E53.mkv",
                           strm=["动漫/药屋少女的呢喃 (2023) [tmdbid=220542]/Season 1/S01E53.strm"])}
    env.p.event(H, "strm", "x")


def test_delete_record_only_keeps_files(env):
    seed_done(env)
    before = set(env.ol.fs)
    r = make_hub(env).task_delete({"hash": H, "files": False})
    assert r["ok"] and r["removed"] == []
    assert set(env.ol.fs) == before
    assert env.s.tasks == {} and H not in env.s.events


def test_delete_with_files_removes_only_this_episode(env):
    seed_done(env)
    r = make_hub(env).task_delete({"hash": H, "files": True})
    assert r["ok"], r
    gone = {f"{SEASON}/[SubsPlease] S01E53.mkv", f"{SEASON}/[SubsPlease] S01E53.ass", f"{LIB}/S01E53.strm", f"{LIB}/S01E53.zh.ass"}
    assert not gone & set(env.ol.fs)
    assert {f"{SEASON}/S01E52.mkv", f"{LIB}/S01E52.strm"} <= set(env.ol.fs)     # the other episode stays
    assert env.emby.updates == ["/media/library/动漫/药屋少女的呢喃 (2023) [tmdbid=220542]/Season 1"]


def test_delete_last_episode_removes_empty_folders_up_to_library(env):
    seed_done(env, other_episode=False)
    assert make_hub(env).task_delete({"hash": H, "files": True})["ok"]
    assert not any(k.startswith("/lib/动漫/药屋") or k.startswith("/115/Emby/动漫/药屋") for k in env.ol.fs)
    assert "/lib/动漫" in env.ol.fs and "/115/Emby/动漫" in env.ol.fs


def test_delete_keeps_folder_another_task_downloads_into(env):
    seed_done(env, other_episode=False)
    env.s.tasks[H2] = task(status="downloading")                      # same season folder, still on 115
    assert make_hub(env).task_delete({"hash": H, "files": True})["ok"]
    assert SEASON in env.ol.fs and H2 in env.s.tasks


def test_delete_active_task_stops_115_and_buffer(env):
    env.s.tasks = {H: task(status="buffer", buffer={"since": 1})}
    assert make_hub(env).task_delete({"hash": H, "files": False})["ok"]
    assert env.c115.deleted == [H]
    assert ("/api/v2/torrents/delete", {"hashes": H, "deleteFiles": "true"}) in env.qb.posts


def test_delete_never_touches_strm_outside_115_root(env):
    env.ol.add("/elsewhere/movie.mkv", GB)
    env.ol.add(f"{LIB}/S01E01.strm", 1, strm="/elsewhere/movie.mkv")
    env.s.tasks = {H: task(status="done", strm=["动漫/药屋少女的呢喃 (2023) [tmdbid=220542]/Season 1/S01E01.strm"])}
    assert make_hub(env).task_delete({"hash": H, "files": True})["ok"]
    assert "/elsewhere/movie.mkv" in env.ol.fs


def test_delete_unknown_task(env):
    assert make_hub(env).task_delete({"hash": H, "files": True}) == {"ok": False, "error": "任务不存在"}
