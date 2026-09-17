from __future__ import annotations

from ear.bargein import BargeInBucket
from ear.config import EndpointConfig


def bucket(**overrides) -> BargeInBucket:
    return BargeInBucket(EndpointConfig(**overrides))


def drive(b: BargeInBucket, pattern: str, can_duck: bool = True) -> list[str | None]:
    return [b.update(ch == "x", can_duck) for ch in pattern]


def test_duck_after_duck_chunks_of_speech():
    b = bucket(duck_chunks=3)
    assert drive(b, "xxx") == [None, None, "duck"]
    assert b.ducked


def test_cut_after_barge_in_chunks():
    b = bucket(duck_chunks=3, barge_in_chunks=10)
    out = drive(b, "x" * 10)
    assert out[2] == "duck"
    assert out[9] == "cut"
    assert out[3:9] == [None] * 6


def test_cut_resets_everything():
    b = bucket(duck_chunks=3, barge_in_chunks=10)
    drive(b, "x" * 10)
    assert (b.hot, b.miss_run, b.ducked) == (0, 0, False)


def test_single_dip_only_costs_decay_not_a_reset():
    b = bucket(duck_chunks=3, barge_in_chunks=10, barge_in_decay=1)
    drive(b, "xxxxx")
    assert b.hot == 5
    assert b.update(False) is None
    assert b.hot == 4
    assert drive(b, "xxxxxx")[-1] == "cut"


def test_decay_never_goes_negative():
    b = bucket()
    drive(b, "....")
    assert b.hot == 0


def test_release_after_release_chunks_of_silence_while_ducked():
    b = bucket(duck_chunks=3, barge_in_release_chunks=6)
    drive(b, "xxx")
    out = drive(b, "." * 6)
    assert out[:5] == [None] * 5
    assert out[5] == "release"
    assert not b.ducked and b.hot == 0


def test_a_hit_while_ducked_restarts_the_release_count():
    b = bucket(duck_chunks=3, barge_in_release_chunks=6)
    drive(b, "xxx")
    drive(b, "....")
    assert b.miss_run == 4
    b.update(True)
    assert b.miss_run == 0
    assert drive(b, "." * 6)[-1] == "release"


def test_duck_only_emitted_once_per_episode():
    b = bucket(duck_chunks=3, barge_in_chunks=10)
    out = drive(b, "xxxx.xx")
    assert out.count("duck") == 1


def test_no_duck_when_not_allowed_but_cut_still_fires():
    b = bucket(duck_chunks=3, barge_in_chunks=10)
    out = drive(b, "x" * 10, can_duck=False)
    assert "duck" not in out
    assert out[-1] == "cut"


def test_credit_never_exceeds_the_cut_threshold():
    b = bucket(duck_chunks=3, barge_in_chunks=100)
    seen = []
    for _ in range(500):
        b.update(True)
        seen.append(b.hot)
    assert max(seen) < 100
    assert seen.count(0) == 5  # one reset per cut


def test_reset_clears_state():
    b = bucket(duck_chunks=3)
    drive(b, "xxx")
    b.reset()
    assert (b.hot, b.miss_run, b.ducked) == (0, 0, False)
