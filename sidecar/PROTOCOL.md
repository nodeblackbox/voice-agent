# ear-sidecar protocol

The sidecar is the app's ears: it turns microphone PCM into speech events and final transcripts.
It owns Silero VAD, the Smart Turn v3.2 end-of-turn model, the Parakeet ASR model, and the
barge-in credit logic. It knows nothing about LLMs, TTS or the UI.

## Process

- Spawned by the Electron main process: `python -m ear --port 0 [--models-dir <dir>]` with cwd
  `sidecar/`. `--port 0` = pick a free port on 127.0.0.1.
- First line on **stdout** once the websocket is listening: `EAR_PORT <port>`. Everything else the
  sidecar logs goes to **stderr** (one line per event, prefixed with a level).
- Exit code non-zero on fatal errors (CUDA missing when required, model download failure). The
  parent restarts it with backoff.
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
`vadThreshold` (0.5), `minSpeechMs` (250), `minSilenceMs` (250), `maxSilenceMs` (1200),
`checkEveryMs` (200), `turnThreshold` (0.7), `turnHighThreshold` (0.9), `bargeInThreshold` (0.75),
`bargeInChunks` (10), `duckChunks` (3), `duckGain` (0.25), `bargeInDecay` (1),
`bargeInReleaseChunks` (6), `partialEveryMs` (600), `prerollMs` (1000), `maxUtteranceMs` (30000),
`levelEveryFrames` (3).

`prerollMs` must exceed `bargeInChunks` x 32 ms: after a barge-in `cut` the new utterance is seeded
from the preroll buffer, and the cut only fires once that much speech has already gone by. The
app derives every value here from `src/shared/tuning.ts`; see `docs/TUNING.md`.

## Server -> client messages

| type | fields | when |
|---|---|---|
| `status` | `stage: 'loading_vad' \| 'loading_turn' \| 'loading_asr' \| 'warming' \| 'ready'`, `detail?` | Model loading progress. |
| `ready` | `asrModel`, `device` (`cuda`/`hybrid`/`cpu`), `providers: string[]`, `loadS: number` | All models loaded and warmed. Audio is ignored until this is sent. |
| `level` | `p: number` | VAD speech probability for the last frame, throttled to ~10 Hz. For the UI meter only. |
| `speech_start` | `t: number` (perf-counter seconds) | VAD crossed threshold for `minSpeechMs` while the agent was not speaking/thinking. |
| `partial` | `text: string` | Live transcript of the open utterance (every `partialEveryMs`). |
| `speech_end` | `reason: 'done' \| 'timeout'`, `silenceMs: number`, `turnP: number \| null` | Endpointer fired. The final decode starts now. |
| `final` | `text: string`, `durationMs: number`, `asrMs: number`, `turnP: number \| null`, `reason` | Final transcript for the utterance. Empty `text` is possible (the client decides whether to drop it). |
| `bargein` | `stage: 'duck' \| 'cut' \| 'release'` | Only while `agent_speaking`/`agent_thinking` is on. `duck`: sustained speech credit reached `duckChunks` (client lowers playback gain to `duckGain`). `release`: it was a short backchannel, restore gain. `cut`: credit reached `bargeInChunks`; the sidecar has already opened a new utterance (with preroll) and the client must cancel the current turn. A `speech_start` follows immediately after `cut`. |
| `stats` | `asrRtf`, `turnCostMs`, `gpuMiB?` | Occasional. |
| `error` | `message`, `fatal: bool` | Non-fatal errors keep the connection open. |
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
