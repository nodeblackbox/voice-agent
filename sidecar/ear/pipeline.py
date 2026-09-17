"""Audio -> events. One worker thread walks 32 ms frames through VAD, endpointing and barge-in credit;
a decode thread runs the final ASR pass so a slow decode never stalls the frame clock.

All timing is on the *audio* clock (samples received / 16 kHz), not wall time, so a replayed file
behaves exactly like a live mic and `--fast` replays are deterministic.
"""
from __future__ import annotations

import collections
import logging
import queue
import threading
import time
from pathlib import Path
from typing import Any, Callable, Protocol

import numpy as np

from . import CHUNK, SR
from .bargein import BargeInBucket
from .config import EndpointConfig, SttConfig
from .endpoint import Endpointer

log = logging.getLogger("ear.pipeline")

Emit = Callable[[dict[str, Any]], None]
Spawn = Callable[[Callable[..., None], tuple], None]

LISTENING = "listening"
USER_SPEAKING = "user_speaking"

LEVEL_EVERY_FRAMES = 3  # ~96 ms


class Vad(Protocol):
    def __call__(self, chunk: np.ndarray) -> float: ...
    def reset(self) -> None: ...


class TurnModel(Protocol):
    def __call__(self, audio: np.ndarray) -> float: ...


class Asr(Protocol):
    providers: list[str]
    load_s: float

    def recognize(self, audio: np.ndarray) -> str: ...
    def warm_up(self) -> None: ...


def _thread_spawn(fn: Callable[..., None], args: tuple) -> None:
    threading.Thread(target=fn, args=args, daemon=True).start()


class Pipeline:
    def __init__(self, emit: Emit, models_dir: Path, endpoint: EndpointConfig, stt: SttConfig, *,
                 vad: Vad | None = None, turn: TurnModel | None = None, asr: Asr | None = None,
                 start_threads: bool = True, spawn: Spawn = _thread_spawn,
                 clock: Callable[[], float] = time.perf_counter) -> None:
        self.emit = emit
        self.models_dir = models_dir
        self.cfg = endpoint
        self.stt = stt
        self.ready = False
        self.stage = "starting"

        self.agent_speaking = False
        self.agent_thinking = False
        self.muted = False

        # Injected components win over the real models (tests, alternative engines).
        self.vad: Vad | None = vad
        self.turn: TurnModel | None = turn
        self.asr: Asr | None = asr
        self.ep: Endpointer | None = None
        self._spawn = spawn
        self._clock = clock

        self._in_q: queue.Queue[bytes | None] = queue.Queue()
        self._decode_q: queue.Queue[tuple | None] = queue.Queue()
        self._asr_lock = threading.Lock()
        self._partial_busy = threading.Event()
        self._reset_flag = threading.Event()
        self._last_partial_text = ""

        self._pending = np.zeros(0, dtype=np.float32)
        self._t_audio = 0.0
        self._frame_n = 0
        self._state = LISTENING
        self._preroll: collections.deque[np.ndarray] = collections.deque(maxlen=1)
        self._utt: list[np.ndarray] = []
        self._t_on = 0.0
        self._t_last = 0.0
        self._announced = False
        self._last_partial_len = 0
        self._bucket = BargeInBucket(self.cfg)

        if start_threads:
            threading.Thread(target=self._frame_loop, name="ear-frames", daemon=True).start()
            threading.Thread(target=self._decode_loop, name="ear-decode", daemon=True).start()

    # ------------------------------------------------------------------ lifecycle
    def load(self) -> None:
        t0 = time.perf_counter()
        if self.vad is None:
            from .vad import SileroVad

            self._status("loading_vad")
            self.vad = SileroVad()
        if self.turn is None:
            from .turn import SmartTurn

            self._status("loading_turn")
            self.turn = SmartTurn(self.models_dir)
            self.turn(np.zeros(SR, dtype=np.float32))
        self.ep = Endpointer(self.cfg, self.turn)
        if self.asr is None:
            from .asr import Parakeet

            self._status("loading_asr", f"{self.stt.model} on {self.stt.device}")
            self.asr = Parakeet(self.stt.model, self.stt.device)
        self._status("warming")
        self.asr.warm_up()
        self._apply_preroll()
        self.ready = True
        self.stage = "ready"
        self._status("ready")
        self.emit(self.ready_event(time.perf_counter() - t0))
        log.info("ready: %s on %s, providers=%s, load %.1fs", self.stt.model, self.stt.device,
                 self.asr.providers, time.perf_counter() - t0)

    def ready_event(self, load_s: float | None = None) -> dict[str, Any]:
        assert self.asr is not None
        return {"type": "ready", "asrModel": self.stt.model, "device": self.stt.device,
                "providers": self.asr.providers, "loadS": round(load_s if load_s is not None else self.asr.load_s, 2)}

    def _status(self, stage: str, detail: str | None = None) -> None:
        self.stage = stage
        msg: dict[str, Any] = {"type": "status", "stage": stage}
        if detail:
            msg["detail"] = detail
        self.emit(msg)

    # ------------------------------------------------------------------ commands (any thread)
    def feed(self, pcm: bytes) -> None:
        if self.ready and not self.muted:
            self._in_q.put(pcm)

    def configure(self, endpoint: dict[str, Any] | None, stt: dict[str, Any] | None) -> None:
        if endpoint:
            ignored = self.cfg.update(endpoint)
            if ignored:
                log.warning("config: ignored endpoint keys %s", ignored)
            self._apply_preroll()
        if stt:
            before = (self.stt.model, self.stt.device)
            self.stt.update(stt)
            if self.ready and before != (self.stt.model, self.stt.device):
                log.info("config: stt change to %s/%s applies on next start", self.stt.model, self.stt.device)

    def set_agent_speaking(self, on: bool) -> None:
        self.agent_speaking = on
        if not on:
            self._bucket.ducked = False

    def set_agent_thinking(self, on: bool) -> None:
        self.agent_thinking = on

    def set_muted(self, on: bool) -> None:
        self.muted = on
        if on:
            self.reset()

    def reset(self) -> None:
        self._reset_flag.set()
        self._in_q.put(b"")

    def _apply_preroll(self) -> None:
        frames = max(1, int(self.cfg.preroll_ms / 1000 * SR / CHUNK) + 1)
        self._preroll = collections.deque(self._preroll, maxlen=frames)

    # ------------------------------------------------------------------ frame worker
    def _frame_loop(self) -> None:
        while True:
            item = self._in_q.get()
            if item is None:
                return
            if self._reset_flag.is_set():
                self._reset_flag.clear()
                self._do_reset()
            if not item:
                continue
            samples = np.frombuffer(item, dtype="<i2").astype(np.float32) / 32768.0
            self._pending = np.concatenate([self._pending, samples]) if self._pending.size else samples
            while len(self._pending) >= CHUNK:
                chunk = np.ascontiguousarray(self._pending[:CHUNK])
                self._pending = self._pending[CHUNK:]
                try:
                    self.process_frame(chunk)
                except Exception:  # noqa: BLE001
                    log.exception("frame processing failed; resetting")
                    self.emit({"type": "error", "message": "frame processing failed", "fatal": False})
                    self._do_reset()

    def _do_reset(self) -> None:
        self._pending = np.zeros(0, dtype=np.float32)
        self._state = LISTENING
        self._utt = []
        self._preroll.clear()
        self._bucket.reset()
        self._announced = False
        self._last_partial_text = ""
        if self.vad is not None:
            self.vad.reset()

    def process_frame(self, chunk: np.ndarray) -> None:
        """Walk one 512-sample float32 frame through VAD, barge-in credit and endpointing."""
        assert self.vad is not None and self.ep is not None
        cfg = self.cfg
        self._t_audio += CHUNK / SR
        self._frame_n += 1
        now = self._t_audio
        p = self.vad(chunk)
        if self._frame_n % LEVEL_EVERY_FRAMES == 0:
            self.emit({"type": "level", "p": round(p, 3)})

        if self._state == LISTENING:
            self._preroll.append(chunk)
            busy = self.agent_speaking or self.agent_thinking
            thr = cfg.barge_in_threshold if busy else cfg.vad_threshold
            if not busy:
                self._bucket.reset()
                if p >= thr:
                    self._open_utterance(now)
                return
            stage = self._bucket.update(p >= thr, can_duck=self.agent_speaking)
            if stage == "cut":
                self.agent_speaking = self.agent_thinking = False
                self.emit({"type": "bargein", "stage": "cut"})
                self._open_utterance(now, announce=True)
            elif stage is not None:
                self.emit({"type": "bargein", "stage": stage})
            return

        # USER_SPEAKING
        self._utt.append(chunk)
        if p >= cfg.vad_threshold:
            self._t_last = now
        if not self._announced and (self._t_last - self._t_on) * 1e3 >= cfg.min_speech_ms:
            self._announced = True
            self.emit({"type": "speech_start", "t": self._clock()})

        total = len(self._utt) * CHUNK
        if (self._announced and total - self._last_partial_len >= int(cfg.partial_every_ms / 1000 * SR)
                and not self._partial_busy.is_set()):
            self._last_partial_len = total
            self._partial_busy.set()
            self._spawn(self._partial_job, (np.concatenate(self._utt),))

        sil_ms = (now - self._t_last) * 1e3
        decision = self.ep.update(lambda: np.concatenate(self._utt), sil_ms, self._last_partial_text)
        if decision is None and (now - self._t_on) * 1e3 >= cfg.max_utterance_ms:
            decision = "timeout"
        if decision is None:
            return

        audio = np.concatenate(self._utt)
        if self._announced:
            turn_p = self.ep.last_p
            self.emit({"type": "speech_end", "reason": decision, "silenceMs": round(sil_ms),
                       "turnP": None if turn_p is None else round(turn_p, 3)})
            log.debug("turn end: %s after %.0f ms silence (smart-turn %s)", decision, sil_ms,
                      f"{turn_p:.2f}" if turn_p is not None else "n/a")
            self._decode_q.put((audio, decision, turn_p, self._clock()))
        self._close_utterance()

    def _open_utterance(self, now: float, announce: bool = False) -> None:
        assert self.ep is not None
        self._state = USER_SPEAKING
        self.ep.start_utterance()
        self._t_on = self._t_last = now
        self._utt = list(self._preroll)
        self._last_partial_len = 0
        self._last_partial_text = ""
        self._bucket.reset()
        self._announced = announce
        if announce:
            self.emit({"type": "speech_start", "t": self._clock()})

    def _close_utterance(self) -> None:
        assert self.vad is not None
        self._state = LISTENING
        self._utt = []
        self._preroll.clear()
        self.vad.reset()
        self._bucket.reset()
        self._announced = False
        self._last_partial_text = ""

    # ------------------------------------------------------------------ ASR threads
    def _partial_job(self, audio: np.ndarray) -> None:
        assert self.asr is not None
        try:
            if not self._asr_lock.acquire(timeout=0.05):
                return
            try:
                text = self.asr.recognize(audio[-SR * 15:])
            finally:
                self._asr_lock.release()
            self._last_partial_text = text
            if self._state == USER_SPEAKING and text:
                self.emit({"type": "partial", "text": text})
        except Exception:  # noqa: BLE001
            log.exception("partial decode failed")
        finally:
            self._partial_busy.clear()

    def _decode_loop(self) -> None:
        while True:
            item = self._decode_q.get()
            if item is None:
                return
            self.decode_one(item)

    def pending_decodes(self) -> int:
        return self._decode_q.qsize()

    def decode_next(self) -> bool:
        """Run one queued final decode on the calling thread (tests / single-threaded use)."""
        try:
            item = self._decode_q.get_nowait()
        except queue.Empty:
            return False
        if item is not None:
            self.decode_one(item)
        return True

    def decode_one(self, item: tuple) -> None:
        audio, reason, turn_p, t_end = item
        assert self.asr is not None
        t0 = self._clock()
        try:
            with self._asr_lock:
                text = self.asr.recognize(audio)
        except Exception as exc:  # noqa: BLE001
            log.exception("final decode failed")
            self.emit({"type": "error", "message": f"ASR failed: {exc}", "fatal": False})
            text = ""
        asr_ms = (self._clock() - t0) * 1e3
        self.emit({"type": "final", "text": text, "durationMs": round(len(audio) / SR * 1e3),
                   "asrMs": round(asr_ms), "turnP": None if turn_p is None else round(turn_p, 3),
                   "reason": reason, "queuedMs": round((t0 - t_end) * 1e3)})
        log.info("final (%.0f ms asr, %.1f s audio): %s", asr_ms, len(audio) / SR, text or "<empty>")
