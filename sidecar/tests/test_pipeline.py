from __future__ import annotations

import numpy as np

from ear import CHUNK, SR
from ear.config import EndpointConfig
from tests.conftest import FakeAsr, FakeTurn, FakeVad, frames, kinds

FRAME_MS = CHUNK * 1000 / SR  # 32 ms


def speak(pipeline, n: int) -> None:
    for f in frames(n):
        pipeline.process_frame(f)


def test_load_with_injected_models_reports_ready(make_pipeline, events):
    p = make_pipeline()
    assert p.ready and p.stage == "ready"


def test_full_utterance_emits_start_partial_end_final(make_pipeline, events):
    speech_frames = 40  # 1.28 s of speech
    vad = FakeVad([0.9] * speech_frames, default=0.0)
    p = make_pipeline(vad=vad, turn=FakeTurn(0.95), asr=FakeAsr("testing one two"))
    speak(p, speech_frames)
    # speech_start after minSpeechMs (250 ms => 8 frames after the opening frame)
    starts = [e for e in events if e["type"] == "speech_start"]
    assert len(starts) == 1
    assert kinds(events)[0] == "speech_start"
    # silence: min_silence 250 ms, first Smart Turn check at >= 250 ms => done
    speak(p, 12)
    assert "speech_end" in kinds(events)
    end = next(e for e in events if e["type"] == "speech_end")
    assert end["reason"] == "done" and end["turnP"] == 0.95 and 250 <= end["silenceMs"] <= 300
    assert end["capMs"] is None and end["segments"] == 0
    assert p.pending_decodes() == 1
    assert p.decode_next()
    final = next(e for e in events if e["type"] == "final")
    assert final["text"] == "testing one two" and final["reason"] == "done"
    assert events[-1]["type"] == "stats"
    # utterance = preroll + speech + trailing silence
    assert final["durationMs"] >= speech_frames * FRAME_MS
    assert p._state == "listening"


def test_partials_are_emitted_on_the_timer(make_pipeline, events):
    n = 60  # 1.92 s of continuous speech: no pause, so only the cadence fires
    p = make_pipeline(vad=FakeVad([0.9] * n, default=0.9), asr=FakeAsr("partial text"))
    speak(p, n)
    partials = [e for e in events if e["type"] == "partial"]
    # one partial per `partial_every_ms` of utterance audio (600 ms default over ~1.9 s => three)
    expected = int(n * FRAME_MS // p.cfg.partial_every_ms)
    assert len(partials) == expected
    assert partials[0]["text"] == "partial text"


def test_speech_start_timing(make_pipeline, events):
    p = make_pipeline(vad=FakeVad([0.9] * 30, default=0.0))
    for i, f in enumerate(frames(30), 1):
        p.process_frame(f)
        if any(e["type"] == "speech_start" for e in events):
            break
    # frame 1 opens the utterance; 250 ms of further speech = 8 more frames
    assert i == 9


def test_too_short_speech_is_a_silent_blip(make_pipeline, events):
    vad = FakeVad([0.9] * 3, default=0.0)
    p = make_pipeline(vad=vad, turn=FakeTurn(0.99))
    speak(p, 3 + 45)  # blip then > max_silence of quiet
    assert kinds(events) == []
    assert p.pending_decodes() == 0
    assert p._state == "listening"
    assert vad.resets >= 1


def test_timeout_when_model_is_unsure_uses_the_normal_cap(make_pipeline, events):
    p = make_pipeline(vad=FakeVad([0.9] * 20, default=0.0), turn=FakeTurn(0.5))
    speak(p, 20 + 50)  # 1.6 s of silence > max_silence 1500 ms
    end = next(e for e in events if e["type"] == "speech_end")
    assert end["reason"] == "timeout"
    assert 1500 <= end["silenceMs"] < 1600
    assert end["capMs"] == 1500


def test_timeout_waits_for_the_low_cap_when_the_model_says_not_done(make_pipeline, events):
    p = make_pipeline(vad=FakeVad([0.9] * 20, default=0.0), turn=FakeTurn(0.05))
    speak(p, 20 + 60)  # 1.9 s of silence: past the normal cap, under the low cap
    assert "speech_end" not in kinds(events)
    speak(p, 40)  # ~3.2 s of silence in total
    end = next(e for e in events if e["type"] == "speech_end")
    assert end["reason"] == "timeout" and end["capMs"] == 3000 and end["silenceMs"] >= 3000


def test_max_utterance_cuts_a_monologue(make_pipeline, events):
    cfg = EndpointConfig(max_utterance_ms=1000, segment_every_ms=100000)
    p = make_pipeline(vad=FakeVad(default=0.9), endpoint=cfg)
    speak(p, 40)  # 1.28 s of continuous speech
    end = next(e for e in events if e["type"] == "speech_end")
    assert end["reason"] == "timeout" and end["capMs"] == 1000


def test_long_utterance_is_segmented_while_it_stays_open(make_pipeline, events):
    cfg = EndpointConfig(segment_every_ms=1000, max_utterance_ms=100000)
    # speech with a quiet frame every 10th frame so there is a clean cut point
    scores = [0.2 if i % 10 == 9 else 0.9 for i in range(80)]
    p = make_pipeline(vad=FakeVad(scores, default=0.0), endpoint=cfg, asr=FakeAsr("part"))
    speak(p, 80)  # 2.56 s of speech -> two segments handed off, utterance still open
    assert p._state == "user_speaking"
    assert p._segments == 2
    assert p.pending_decodes() == 2
    assert p.decode_next() and p.decode_next()
    segs = [e for e in events if e["type"] == "segment"]
    assert [s["index"] for s in segs] == [0, 1]
    assert all(s["text"] == "part" for s in segs)
    # the tail is short: the utterance buffer restarted at the cut point
    assert len(p._utt) * FRAME_MS < 1000
    speak(p, 50)  # silence -> the tail ends the turn
    end = next(e for e in events if e["type"] == "speech_end")
    assert end["segments"] == 2
    p.decode_next()
    final = next(e for e in events if e["type"] == "final")
    assert final["segments"] == 2 and final["durationMs"] < 2000


def test_pause_triggers_an_immediate_partial_for_the_filler_guard(make_pipeline, events):
    asr = FakeAsr("and then I'll")
    p = make_pipeline(vad=FakeVad([0.9] * 12, default=0.0), asr=asr)
    speak(p, 12)  # 384 ms of speech: past minSpeech, well under the 600 ms partial cadence
    partials_before = len([e for e in events if e["type"] == "partial"])
    speak(p, 4)  # 128 ms of silence >= silencePartialMs
    assert len([e for e in events if e["type"] == "partial"]) == partials_before + 1
    # only one forced partial per pause
    speak(p, 3)
    assert len([e for e in events if e["type"] == "partial"]) == partials_before + 1


def test_barge_in_ducks_then_cuts_and_opens_an_utterance(make_pipeline, events):
    p = make_pipeline(vad=FakeVad(default=0.9))
    p.set_agent_speaking(True)
    speak(p, 3)
    assert kinds(events) == ["bargein"] and events[-1]["stage"] == "duck"
    speak(p, 7)
    ks = kinds(events)
    assert ks == ["bargein", "bargein", "speech_start"]
    assert events[-2]["stage"] == "cut"
    assert not p.agent_speaking and not p.agent_thinking
    assert p._state == "user_speaking"


def test_barge_in_uses_the_higher_threshold(make_pipeline, events):
    p = make_pipeline(vad=FakeVad(default=0.6))  # above vad_threshold, below barge_in_threshold
    p.set_agent_speaking(True)
    speak(p, 30)
    assert kinds(events) == []
    p.set_agent_speaking(False)
    speak(p, 1)
    assert p._state == "user_speaking"


def test_backchannel_is_released_not_cut(make_pipeline, events):
    p = make_pipeline(vad=FakeVad([0.9] * 4, default=0.0))
    p.set_agent_speaking(True)
    speak(p, 4 + 6)
    assert [e["stage"] for e in events if e["type"] == "bargein"] == ["duck", "release"]
    assert p._state == "listening"


def test_thinking_barge_in_cuts_without_ducking(make_pipeline, events):
    p = make_pipeline(vad=FakeVad(default=0.9))
    p.set_agent_thinking(True)
    speak(p, 10)
    assert [e["stage"] for e in events if e["type"] == "bargein"] == ["cut"]


def test_muted_pipeline_drops_audio(make_pipeline, events):
    p = make_pipeline(vad=FakeVad(default=0.9))
    p.set_muted(True)
    p.feed(b"\x00\x01" * CHUNK)
    assert p._in_q.qsize() == 1  # only the reset marker
    p.set_muted(False)
    p.feed(b"\x00\x01" * CHUNK)
    assert p._in_q.qsize() == 2


def test_feed_is_ignored_before_ready(events, tmp_path):
    from ear.config import SttConfig
    from ear.pipeline import Pipeline

    p = Pipeline(events.append, tmp_path, EndpointConfig(), SttConfig(), vad=FakeVad(), turn=FakeTurn(), asr=FakeAsr(),
                 start_threads=False)
    p.feed(b"\x00" * 1024)
    assert p._in_q.qsize() == 0


def test_frame_loop_rechunks_arbitrary_byte_sizes(make_pipeline, events):
    p = make_pipeline(vad=FakeVad(default=0.0))
    p.feed(b"\x00\x00" * 700)
    p.feed(b"\x00\x00" * 400)
    p._in_q.put(None)
    p._frame_loop()
    assert p._frame_n == 2
    assert len(p._pending) == 1100 - 2 * CHUNK


def test_configure_hot_swaps_endpoint_settings(make_pipeline, events):
    p = make_pipeline()
    p.configure({"minSpeechMs": 64, "prerollMs": 64}, {"device": "cpu"})
    assert p.cfg.min_speech_ms == 64 and p.stt.device == "cpu"
    assert p._preroll.maxlen == 3


def test_asr_failure_becomes_a_non_fatal_error_and_empty_final(make_pipeline, events):
    class Broken(FakeAsr):
        def recognize(self, audio: np.ndarray) -> str:
            raise RuntimeError("boom")

    p = make_pipeline(vad=FakeVad([0.9] * 20, default=0.0), asr=Broken())
    speak(p, 20 + 12)
    p.decode_next()
    ks = kinds(events)
    assert "error" in ks and "final" in ks
    final = next(e for e in events if e["type"] == "final")
    assert final["text"] == ""
    assert next(e for e in events if e["type"] == "error")["fatal"] is False


# ---------------------------------------------------------------- ported from the old agent's fixes_test.py
def bargein_stages(events) -> list[str]:
    return [e["stage"] for e in events if e["type"] == "bargein"]


def test_old_hard_reset_logic_would_have_failed_on_fluttery_speech():
    # sanity check for the leaky bucket: with a dip every 6th frame the longest run is 5 < 10, so a
    # reset-on-any-miss counter never cuts, while the bucket does (see next test)
    scores = [0.4 if i % 6 == 5 else 0.85 for i in range(40)]
    hot, cut = 0, False
    for p in scores:
        if p >= 0.75:
            hot += 1
            if hot >= 10:
                cut = True
                break
        else:
            hot = 0
    assert not cut


def test_sustained_speech_with_flutter_still_cuts(make_pipeline, events):
    scores = [0.4 if i % 6 == 5 else 0.85 for i in range(40)]
    p = make_pipeline(vad=FakeVad(scores, default=0.0))
    p.set_agent_speaking(True)
    speak(p, 40)
    assert "cut" in bargein_stages(events)


def test_one_utterance_with_micro_pauses_cuts_without_release_spam(make_pipeline, events):
    # 67 % duty cycle speech: escalates to a real interrupt and never flickers "release" on the way
    scores = ([0.85] * 4 + [0.3] * 2) * 5
    p = make_pipeline(vad=FakeVad(scores, default=0.0))
    p.set_agent_speaking(True)
    speak(p, len(scores))
    stages = bargein_stages(events)
    assert "cut" in stages
    assert stages.count("release") == 0


def test_three_separate_bursts_are_three_backchannels(make_pipeline, events):
    scores = ([0.85] * 4 + [0.1] * 10) * 3
    p = make_pipeline(vad=FakeVad(scores, default=0.0))
    p.set_agent_speaking(True)
    speak(p, len(scores))
    stages = bargein_stages(events)
    assert "cut" not in stages
    assert stages.count("duck") == 3 and stages.count("release") == 3
    assert p._bucket.backchannels == 3


def test_cut_seeds_the_utterance_with_the_speech_that_triggered_it(make_pipeline, events):
    p = make_pipeline(vad=FakeVad(default=0.9))
    p.set_agent_speaking(True)
    speak(p, 10)  # exactly barge_in_chunks frames of speech -> cut
    cut = next(e for e in events if e["type"] == "bargein" and e["stage"] == "cut")
    assert p._state == "user_speaking"
    # the frames that built the credit are already in the utterance, not lost
    assert len(p._utt) * FRAME_MS >= p.cfg.barge_in_chunks * FRAME_MS
    assert cut["prerollMs"] >= p.cfg.barge_in_chunks * FRAME_MS
    assert p._after_cut


def test_preroll_default_covers_the_cut_window():
    cfg = EndpointConfig()
    assert cfg.preroll_ms > cfg.barge_in_chunks * FRAME_MS


def test_speech_end_carries_the_smart_turn_checks_and_final_carries_after_cut(make_pipeline, events):
    p = make_pipeline(vad=FakeVad([0.9] * 20, default=0.0), turn=FakeTurn(0.95))
    speak(p, 20 + 12)
    end = next(e for e in events if e["type"] == "speech_end")
    assert end["checks"] and end["checks"][-1]["p"] == 0.95 and end["checks"][-1]["heldOnFiller"] is False
    assert end["afterCut"] is False and end["speechMs"] >= 500
    p.decode_next()
    final = next(e for e in events if e["type"] == "final")
    assert final["afterCut"] is False and "asrRtf" in final


def test_stats_are_emitted_after_each_final(make_pipeline, events):
    p = make_pipeline(vad=FakeVad([0.9] * 20, default=0.0))
    speak(p, 20 + 12)
    p.decode_next()
    stats = [e for e in events if e["type"] == "stats"]
    assert len(stats) == 1
    assert stats[0] == {"type": "stats", "turns": 1, "turnChecks": 1, "turnCostP50Ms": stats[0]["turnCostP50Ms"],
                        "heldOnFiller": 0, "backchannels": 0, "cuts": 0, "cutsEmptyFinal": 0,
                        "asrFailures": 0, "asrReloads": 0, "gpuMiB": None}
    assert stats[0]["turnCostP50Ms"] is not None


def test_empty_final_after_a_cut_counts_as_a_self_cut_suspect(make_pipeline, events):
    p = make_pipeline(vad=FakeVad([0.9] * 20, default=0.0), asr=FakeAsr(""))
    p.set_agent_speaking(True)
    speak(p, 20 + 12)
    p.decode_next()
    final = next(e for e in events if e["type"] == "final")
    assert final["afterCut"] is True and final["text"] == ""
    assert events[-1]["type"] == "stats" and events[-1]["cutsEmptyFinal"] == 1 and events[-1]["cuts"] == 1


class FlakyAsr(FakeAsr):
    """Fails every decode until `reload()` is called `heal_after` times."""

    def __init__(self, heal_after: int = 1) -> None:
        super().__init__("healed")
        self.heal_after = heal_after
        self.reloads = 0

    def recognize(self, audio: np.ndarray) -> str:
        if self.reloads < self.heal_after:
            raise RuntimeError("CUBLAS failure 3: the resource allocation failed")
        return super().recognize(audio)

    def reload(self) -> None:
        self.reloads += 1


def drive_finals(p, n: int) -> None:
    for _ in range(n):
        speak(p, 20 + 12)  # speech, then silence -> speech_end -> queued final
        p.decode_next()


def test_repeated_decode_failures_reload_the_model_once_and_recover(make_pipeline, events):
    asr = FlakyAsr(heal_after=1)
    p = make_pipeline(vad=FakeVad(default=0.0), asr=asr, turn=FakeTurn(0.95))
    p.vad = FakeVad([0.9] * 20 * 4 + [0.0] * 200, default=0.0)  # four utterances worth of speech, then quiet
    fatal: list[int] = []
    p.on_fatal = fatal.append
    # partial decodes count too: two partials plus the final of the first utterance fail -> reload;
    # every later decode succeeds
    for i in range(4):
        p.vad.probs = [0.9] * 20 + [0.0] * 12
        drive_finals(p, 1)
    finals = [e for e in events if e["type"] == "final"]
    assert [f["text"] for f in finals] == ["", "healed", "healed", "healed"]
    assert asr.reloads == 1 and fatal == [] and p.fatal_code is None
    stats = [e for e in events if e["type"] == "stats"][-1]
    assert stats["asrFailures"] == 3 and stats["asrReloads"] == 1
    assert any(e["type"] == "error" and "reloaded" in e["message"] for e in events)


def test_decode_failures_after_a_reload_are_fatal_with_exit_code_4(make_pipeline, events):
    asr = FlakyAsr(heal_after=99)
    p = make_pipeline(vad=FakeVad(default=0.0), asr=asr, turn=FakeTurn(0.95))
    fatal: list[int] = []
    p.on_fatal = fatal.append
    for i in range(6):
        p.vad.probs = [0.9] * 20 + [0.0] * 12
        drive_finals(p, 1)
    assert asr.reloads == 1
    assert fatal == [4] and p.fatal_code == 4
    err = next(e for e in events if e["type"] == "error" and e.get("fatal"))
    assert err["code"] == "asr_broken"


def test_a_persistent_frame_fault_is_rate_limited(make_pipeline, events):
    p = make_pipeline()

    def explode(chunk):
        raise RuntimeError("bad frame")

    p.process_frame = explode  # type: ignore[method-assign]
    for _ in range(100):
        p.feed(b"\x00\x00" * CHUNK)
    p._in_q.put(None)
    p._frame_loop()
    errors = [e for e in events if e["type"] == "error"]
    assert len(errors) == 3
    assert all("bad frame" in e["message"] for e in errors)
