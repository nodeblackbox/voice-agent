from __future__ import annotations

from ear.ratelimit import RateLimiter


def test_first_burst_passes_then_suppressed_then_summarised():
    now = [0.0]
    rl = RateLimiter(window_s=10, burst=3, clock=lambda: now[0])
    results = []
    for i in range(50):
        now[0] = i * 0.032
        ok, expired = rl.admit("frame_failed")
        assert expired == []
        results.append(ok)
    assert results[:3] == [True, True, True]
    assert not any(results[3:])
    now[0] = 10.5
    ok, expired = rl.admit("other")
    assert ok
    assert expired == [("frame_failed", 47)]


def test_keys_are_independent_and_quiet_keys_do_not_summarise():
    now = [0.0]
    rl = RateLimiter(window_s=1, burst=1, clock=lambda: now[0])
    assert rl.admit("a")[0]
    assert rl.admit("b")[0]
    assert not rl.admit("a")[0]
    now[0] = 2.0
    assert sorted(rl.sweep()) == [("a", 1)]
