"""Task status transitions driven by a tracking round (Pipeline.run) against fake 115 / qB / OpenList."""
import time

from conftest import GB, H, H2, SEASON, events, pl, task


def ago(sec):
    return int(time.time() - sec)


def run(env):
    env.p.run()
    return env.s.tasks


# ---------------- 115 offline ----------------
def test_progress_logged_by_quarters_and_size_once(env):
    env.s.tasks = {H: task()}
    env.c115.list_[H] = {"status": 1, "percentDone": 10, "size": 2 * GB, "name": "S01E53.mkv"}
    run(env)
    env.c115.list_[H]["percentDone"] = 20
    run(env)
    env.c115.list_[H]["percentDone"] = 30
    t = run(env)[H]
    assert t["status"] == "downloading" and t["percent"] == 30 and t["size"] == 2 * GB
    msgs = [m for s, _, m in events(env) if s == "offline"]
    assert msgs == ["115 离线进度 10%，共 2.0 GB", "115 离线进度 30%"]


def test_complete_marks_offline_and_moves_to_strm(env, monkeypatch):
    env.s.tasks = {H: task(name="S01E53.mkv")}
    env.c115.list_[H] = {"status": 2, "percentDone": 100, "size": GB, "name": "S01E53.mkv"}
    monkeypatch.setattr(env.p, "make_strms", lambda d, meta, scope: ["/lib/动漫/药屋少女的呢喃 (2023) [tmdbid=220542]/Season 1/S01E53.strm"])
    t = run(env)[H]
    assert t["status"] == "done"
    assert {"offline", "strm_start", "strm"} <= set(t["ts"])
    assert t["strm"] == ["动漫/药屋少女的呢喃 (2023) [tmdbid=220542]/Season 1/S01E53.strm"]
    ev = events(env)
    assert ("offline", "info", "115 离线下载完成：S01E53.mkv") in ev
    assert ("strm", "info", "开始生成 strm") in ev
    assert ("strm", "info", "生成 strm 完成，共 1 个") in ev


def test_zero_percent_flags_stalled_once(env):
    env.s.tasks = {H: task(added=ago(31 * 60))}
    env.c115.list_[H] = {"status": 1, "percentDone": 0, "size": 4 * GB}
    run(env)
    t = run(env)[H]
    assert t["status"] == "downloading" and t["stalled"]
    assert sum("仍是 0%" in m for _, _, m in events(env)) == 1


def test_stalled_cleared_when_progress_resumes(env):
    env.s.tasks = {H: task(added=ago(40 * 60), stalled=ago(60))}
    env.c115.list_[H] = {"status": 1, "percentDone": 5, "size": 4 * GB}
    assert "stalled" not in run(env)[H]


def test_missing_from_115_warns_once_within_limit(env):
    env.s.tasks = {H: task(added=ago(40 * 60))}
    run(env)
    t = run(env)[H]
    assert t["status"] == "downloading" and t["stalled"]
    assert sum(m == "115 离线列表里暂时找不到" for _, _, m in events(env)) == 1


def test_timeout_by_size_switches_to_buffer(env):
    """2 GB → 2 h limit: at 2 h 1 min the 115 task is dropped and the NAS buffer takes over (no failure)."""
    env.s.tasks = {H: task(added=ago(2 * 3600 + 60), percent=40)}
    env.c115.list_[H] = {"status": 1, "percentDone": 40, "size": 2 * GB}
    t = run(env)[H]
    assert t["status"] == "buffer" and t["buffer"]["reason"].startswith("115 离线 2 小时没下完")
    assert env.c115.deleted == [H]
    assert any(path.endswith("/torrents/add") for path, _ in env.qb.posts)
    assert "buffer" in t["ts"] and not env.p.failures
    assert any("改用 NAS 缓冲" in n for n in env.s.notes)


def test_no_timeout_before_limit(env):
    env.s.tasks = {H: task(added=ago(int(1.5 * 3600)))}
    env.c115.list_[H] = {"status": 1, "percentDone": 40, "size": 2 * GB}
    assert run(env)[H]["status"] == "downloading" and not env.c115.deleted


def test_unknown_size_uses_one_hour(env):
    assert pl.offline_limit(None) == 3600 and pl.offline_limit(0.2 * GB) == 3600 and pl.offline_limit(3 * GB) == 3 * 3600


def test_missing_past_limit_switches_to_buffer(env):
    env.s.tasks = {H: task(added=ago(3600 + 60))}
    t = run(env)[H]
    assert t["status"] == "buffer" and "找不到" in t["buffer"]["reason"]
    assert env.c115.deleted == []        # nothing to delete on 115


def test_timeout_fails_when_buffer_cannot_start(env):
    env.qb.ok = False
    env.s.tasks = {H: task(added=ago(3600 + 60))}
    t = run(env)[H]
    assert t["status"] == "dead" and "NAS 缓冲也失败" in t["fail_reason"]
    assert t["ts"]["failed"] and env.p.failures == [(H, "dead", t["fail_reason"])]
    assert "done" not in t               # a failed download is not "入库"


def test_115_reports_failure_goes_to_buffer(env):
    env.s.tasks = {H: task()}
    env.c115.list_[H] = {"status": -1, "percentDone": 0, "size": GB}
    t = run(env)[H]
    assert t["status"] == "buffer" and t["buffer"]["reason"] == "115 离线失败" and env.c115.deleted == [H]


def test_115_list_outage_skips_offline_but_still_finishes_uploaded(env, monkeypatch):
    env.c115.fail_list = True
    env.s.tasks = {H: task(added=ago(5 * 3600)), H2: task(status="uploaded", name="x.mkv", ts={"offline": ago(60)})}
    monkeypatch.setattr(env.p, "make_strms", lambda d, meta, scope: ["/lib/动漫/x/Season 1/a.strm"])
    t = run(env)
    assert t[H]["status"] == "downloading"          # no timeout decision without the 115 list
    assert t[H2]["status"] == "done"


# ---------------- strm ----------------
def test_strm_errors_retry_then_stop(env, monkeypatch):
    env.s.tasks = {H: task(status="uploaded", name="x.mkv")}

    def boom(*a):
        raise pl.ClientError("OpenList 502")
    monkeypatch.setattr(env.p, "make_strms", boom)
    for i in range(1, 5):
        t = run(env)[H]
        assert t["status"] == "uploaded" and t["strm_errors"] == i
    t = run(env)[H]
    assert t["status"] == "strm-failed" and t["ts"]["failed"]
    assert run(env)[H]["strm_errors"] == 5          # stopped: not picked up again


def test_empty_listing_waits_then_no_video(env, monkeypatch):
    env.s.tasks = {H: task(status="uploaded", name="x.mkv")}
    monkeypatch.setattr(env.p, "make_strms", lambda *a: [])
    for _ in range(6):
        assert run(env)[H]["status"] == "uploaded"
    t = run(env)[H]
    assert t["status"] == "no-video" and t["fail_reason"] == "没有可入库的视频"
    assert env.p.failures and env.p.failures[0][1] == "no-video"


def test_downloaded_but_strm_retrying_keeps_status_downloading(env, monkeypatch):
    """115 finished but strm fails: status stays downloading (ts.offline set) and the next round retries strm only."""
    env.s.tasks = {H: task(name="x.mkv")}
    env.c115.list_[H] = {"status": 2, "percentDone": 100, "size": GB, "name": "x.mkv"}
    calls = []

    def flaky(*a):
        calls.append(1)
        if len(calls) == 1:
            raise pl.ClientError("OpenList 里还看不到下载的文件夹")
        return ["/lib/动漫/x/Season 1/a.strm"]
    monkeypatch.setattr(env.p, "make_strms", flaky)
    t = run(env)[H]
    assert t["status"] == "downloading" and t["ts"]["offline"] and t["strm_errors"] == 1
    assert run(env)[H]["status"] == "done"


# ---------------- NAS buffer ----------------
def test_buffer_dead_after_24h_zero(env):
    env.s.tasks = {H: task(status="buffer", buffer={"since": ago(25 * 3600), "reason": "x", "uploaded": {}, "uploading": {}})}
    env.qb.torrents = [{"hash": H, "progress": 0, "total_size": GB, "name": "x"}]
    t = run(env)[H]
    assert t["status"] == "dead" and t["fail_reason"] == "115 和 NAS 缓冲都下不动" and t["ts"]["failed"]


def test_buffer_too_big(env):
    env.s.tasks = {H: task(status="buffer", buffer={"since": ago(60), "reason": "x", "uploaded": {}, "uploading": {}})}
    env.qb.torrents = [{"hash": H, "progress": 0.1, "total_size": 30e9, "name": "x"}]
    assert run(env)[H]["status"] == "too-big"


# ---------------- persistence vs. concurrent API changes ----------------
def test_cancel_during_round_wins(env):
    env.s.tasks = {H: task()}
    t = env.s.load()[H]
    env.s.tasks[H]["status"] = "cancelled"        # /cancel landed while the round held its snapshot
    t["percent"] = 50
    env.p._persist(H, t)
    assert env.s.tasks[H]["status"] == "cancelled"


def test_api_change_during_round_wins(env):
    env.s.tasks = {H: task()}
    t = env.s.load()[H]
    env.p.mutate(H, lambda cur: cur.update(status="uploaded"))
    t["status"] = "dead"
    env.p._persist(H, t)
    assert env.s.tasks[H]["status"] == "uploaded"


def test_deleted_during_round_is_not_recreated(env):
    env.s.tasks = {H: task()}
    t = env.s.load()[H]
    env.s.tasks = {}
    env.p._persist(H, t)
    assert env.s.tasks == {}


# ---------------- manual retry ----------------
def test_retry_offline_clears_later_steps(env):
    t = task(status="dead", fail_reason="x", stalled=1, strm_errors=3, buffer={"since": 1},
             ts={"submitted": 1, "select": 1, "offline": 2, "strm_start": 3, "failed": 4})
    pl.Pipeline.retry_reset(t, "offline")
    assert t["status"] == "downloading" and t["percent"] == 0 and "buffer" not in t
    assert set(t["ts"]) == {"submitted", "select"}
    assert not {"fail_reason", "stalled", "strm_errors"} & set(t)


def test_retry_strm_keeps_download_marks(env):
    t = task(status="strm-failed", done=5, emby=-6, strm_errors=5, ts={"submitted": 1, "offline": 2, "strm_start": 3, "strm": 4, "failed": 5})
    pl.Pipeline.retry_reset(t, "strm")
    assert t["status"] == "uploaded" and "done" not in t and "emby" not in t and "strm_errors" not in t
    assert set(t["ts"]) == {"submitted", "offline"}


def test_retry_strm_then_round_succeeds(env, monkeypatch):
    t = task(status="strm-failed", name="x.mkv", strm_errors=5, ts={"submitted": 1, "offline": 2, "strm_start": 3, "failed": 5})
    pl.Pipeline.retry_reset(t, "strm")
    env.s.tasks = {H: t}
    monkeypatch.setattr(env.p, "make_strms", lambda *a: ["/lib/动漫/x/Season 1/a.strm"])
    t = run(env)[H]
    assert t["status"] == "done" and "failed" not in t["ts"]


def test_retry_buffer_keeps_buffer_mark(env):
    t = task(added=ago(60))
    env.p.buffer_start(H, t, "手动改用 NAS 缓冲")
    pl.Pipeline.retry_reset(t, "buffer")
    assert t["status"] == "buffer" and "buffer" in t["ts"]


# ---------------- emby ----------------
def test_emby_giveup_after_3h(env):
    env.s.tasks = {H: task(status="done", done=ago(3 * 3600 + 60), strm=["a.strm"], ts={"strm": ago(4 * 3600)})}
    t = run(env)[H]
    assert t["emby"] < 0
    assert any(lvl == "error" and s == "emby" for s, lvl, _ in events(env))


def test_notification_not_duplicated_in_log(env):
    with env.p.ctx(H, "offline"):
        env.p.event(H, "offline", "115 离线失败，改用缓冲", "warn")
        env.p.notify("t", "115 离线失败，改用缓冲")
        env.p.notify("t", "别的事")
    msgs = [m for _, _, m in events(env)]
    assert msgs == ["115 离线失败，改用缓冲", "已推送通知：别的事"]


# ---------------- AV / 里番 ----------------
class FakeAdult:
    def __init__(self, made):
        self.made = made

    def finish(self, kind, t, scope, h):
        return self.made


def test_av_strm_hands_off_to_mdc(env):
    env.p.adult = FakeAdult(["/lib/AV/download/JUR-853.strm"])
    env.s.tasks = {H: task(status="uploaded", dir="/115/Emby/下载", name="JUR-853", meta={"kind": "av"})}
    t = run(env)[H]
    assert t["status"] == "scraping" and t["strm"] == ["AV/download/JUR-853.strm"]
    ev = events(env)
    assert ("strm", "info", "开始写入 MDC 收件箱") in ev
    assert ("strm", "info", "写入 MDC 收件箱完成，交给 MDC 刮削，共 1 个") in ev


def test_hentai_without_bangumi_waits_for_id(env):
    env.p.adult = FakeAdult(None)
    env.s.tasks = {H: task(status="uploaded", dir="/115/Emby/里番/x", name="x", meta={"kind": "hentai"})}
    t = run(env)[H]
    assert t["status"] == "needs-id"
    assert sum("没认出 Bangumi" in m for _, _, m in events(env)) == 1
    assert run(env)[H]["status"] == "needs-id" and sum("没认出 Bangumi" in m for _, _, m in events(env)) == 1


def test_unidentified_media_goes_to_needs_id(env):
    env.s.tasks = {H: task(status="uploaded", dir="/115/Emby/待识别/铁旅 (2026)", name="x")}
    assert run(env)[H]["status"] == "needs-id"
