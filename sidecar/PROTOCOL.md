# ear-sidecar protocol

The sidecar is the app's ears: it turns microphone PCM into speech events and final transcripts.
It owns Silero VAD, the Smart Turn v3.2 end-of-turn model, the Parakeet ASR model, and the
barge-in credit logic. It knows nothing about LLMs, TTS or the UI.

## Process

- Spawned by the Electron main process: `python -m ear --port 0 [--models-dir <dir>]` with cwd
  `sidecar/`. `--port 0` = pick a free port on 127.0.0.1.
- First line on **stdout** once the websocket is listening: `EAR_PORT <port>`. Everything else the
  sidecar logs goes to **stderr** (one line per event, prefixed with a level).
- Exit code non-zero on fatal errors: `3` = CUDA requested but unavailable, `4` = the ASR model kept
  failing after a reload (GPU memory pressure), `1` = other load failures. The parent restarts it with
  backoff (immediately once for `4`).
- Models load *after* the port is announced so the client can connect and show progress.

## Transport

One websocket connection at a time on `ws://127.0.0.1:<port>/`.
- **Binary frames** (client -> server): little-endian **int16 PCM, 16 kHz, mono**. Any length;
  the sidecar re-chunks into 512-sample (32 ms) VAD frames internally.
- **Text frames**: UTF-8 JSON objects with a `type` field, both directions.

If the client disconnects, the sidecar resets all state and waits for the next connection; it does
not exit.

## Client -> server messages

| type | fields | meaning |
|---|---|---|
| `config` | `endpoint: {...}` (see below), `stt: {model, device}` | Apply settings. `endpoint` is hot-swappable at any time; `stt` changes only take effect on the next model load (the client restarts the sidecar for that). |
| `agent_speaking` | `on: bool` | The app is playing TTS audio. While `on`, the sidecar uses the barge-in threshold and emits `bargein` events instead of `speech_start`. |
| `agent_thinking` | `on: bool` | LLM/tool is running, no audio yet. Barge-in is legal (a `cut` cancels the turn) but no ducking is needed. |
| `mute` | `on: bool` | Drop incoming audio entirely; reset any open utterance. |
| `reset` | – | Drop the current utterance buffer and VAD state. |
| `ping` | – | Reply with `pong`. |

`endpoint` fields (all optional, defaults in parentheses):
`vadThreshold` (0.5), `minSpeechMs` (250), `minSilenceMs` (250), `maxSilenceMs` (1500),
`checkEveryMs` (200), `turnThreshold` (0.7), `turnHighThreshold` (0.9), `turnLowThreshold` (0.3),
`maxSilenceLowMs` (3000), `bargeInThreshold` (0.75), `bargeInInstant` (true), `bargeInChunks` (10),
`duckChunks` (3), `duckGain` (0.25), `bargeInDecay` (1), `bargeInReleaseChunks` (6), `partialEveryMs` (600),
`silencePartialMs` (100), `prerollMs` (1000), `maxUtteranceMs` (120000), `segmentEveryMs` (30000),
`fillerWords` (see below), `fillerHoldsHighTier` (true), `levelEveryFrames` (3), `asrFailureLimit` (3).

- The silence cap adapts to Smart Turn: while its last score is below `turnLowThreshold` (the user
  is clearly mid-thought) the turn stays open for `maxSilenceLowMs`; otherwise `maxSilenceMs`.
- `fillerWords` is a comma-separated list; a live partial ending on one of them holds the turn in the
  middle tier, and once per utterance in the high tier when `fillerHoldsHighTier` is on.
- `silencePartialMs` forces one partial decode as soon as a pause is that long, so the guard reads the
  real last word.
- Utterances longer than `segmentEveryMs` are transcribed in segments (see `segment` below) and only
  end at `maxUtteranceMs`.
- `prerollMs` must exceed `bargeInChunks` x 32 ms: after a barge-in `cut` the new utterance is seeded
  from the preroll buffer, and the cut only fires once that much speech has already gone by.
- After `asrFailureLimit` consecutive decode failures (typically a CUDA/cuBLAS allocation error when
  another process took the VRAM) the sidecar reloads the ASR model once; if decoding still fails it
  sends `error{fatal:true, code:'asr_broken'}` and exits with code **4** so the app restarts it.

The app derives every value here from `src/shared/tuning.ts`; see `docs/TUNING.md`.

## Server -> client messages

| type | fields | when |
|---|---|---|
| `status` | `stage: 'loading_vad' \| 'loading_turn' \| 'loading_asr' \| 'warming' \| 'ready'`, `detail?` | Model loading progress. |
| `ready` | `asrModel`, `device` (`cuda`/`hybrid`/`cpu`), `providers: string[]`, `loadS: number` | All models loaded and warmed. Audio is ignored until this is sent. |
| `level` | `p: number` | VAD speech probability for the last frame, throttled to ~10 Hz. For the UI meter only. |
| `speech_start` | `t: number` (perf-counter seconds) | VAD crossed threshold for `minSpeechMs` while the agent was not speaking/thinking. |
| `partial` | `text: string` | Live transcript of the open utterance (every `partialEveryMs`). |
| `speech_end` | `reason: 'done' \| 'timeout'`, `silenceMs`, `turnP: number \| null`, `speechMs`, `checks: [{silenceMs, p, heldOnFiller, lastWord, capMs}]`, `afterCut`, `capMs: number \| null` (which cap fired on a timeout), `segments` | Endpointer fired. The final decode starts now. |
| `segment` | `text: string`, `index: number`, `durationMs`, `asrMs` | The older part of a long utterance, transcribed while the user keeps talking (every `segmentEveryMs`). The client concatenates segments in `index` order, then the `final` tail. |
| `final` | `text: string`, `durationMs: number`, `asrMs: number`, `asrRtf`, `queuedMs`, `turnP: number \| null`, `reason`, `afterCut`, `segments: number` | Final transcript for the tail of the utterance (`segments` earlier parts were sent as `segment`). Empty `text` is possible (the client decides whether to drop it). |
| `bargein` | `stage: 'duck' \| 'cut' \| 'release'` | Only while `agent_speaking`/`agent_thinking` is on. With `bargeInInstant` (the default) only `cut` is ever sent: credit reached `duckChunks` (~100 ms), the sidecar has already opened a new utterance (with preroll) and the client must cancel the current turn. In staged mode (`bargeInInstant: false`): `duck`: credit reached `duckChunks` (client lowers playback gain to `duckGain`); `release`: it was a short backchannel, restore gain; `cut`: credit reached `bargeInChunks`. A `speech_start` follows immediately after `cut`. |
| `stats` | `turns`, `turnChecks`, `turnCostP50Ms`, `heldOnFiller`, `backchannels`, `cuts`, `cutsEmptyFinal`, `asrFailures`, `asrReloads`, `gpuMiB?` (from `nvidia-smi` when available) | After every final, and every 30 s while barge-in activity happened. |
| `error` | `message`, `fatal: bool`, `code?` (`asr_broken`) | Non-fatal errors keep the connection open. |
| `pong` | – | |

## Turn flow (normal)

```
client: config -> (audio frames...)
server: level ... speech_start -> partial* -> speech_end -> final
```

## Turn flow (barge-in while the agent speaks)

```
client: agent_speaking{on:true}
server: bargein{duck} ... bargein{cut} -> speech_start -> partial* -> speech_end -> final
client: (on cut) cancel turn, agent_speaking{on:false}
```

## ASR device modes

- `hybrid` (default): encoder on CUDA, decoder_joint on CPU int8 (fastest measured).
- `cuda`: all on GPU.
- `cpu`: everything on CPU (slow but always works).
If CUDA is requested and not available, the sidecar exits with code 3 and a clear stderr message;
the client offers CPU mode.
