# Debugging a turn

"I said hello and it broke" is answerable from the files on disk. This page says where they are,
what is in them, and how to read the three common complaints. It is written so a fresh Claude
session (or a person) can debug from the files alone: paste the output of **Diagnostics → Copy
diagnostics** and this page is the decoder.

## Files

All under `%APPDATA%/Voice Agent/logs/` (Settings → Diagnostics → *Open logs folder*):

| file | what | flood control |
|---|---|---|
| `app.log` | human-readable lines from every process: main, agent core, sidecar stderr (scope `ear`), renderer console errors. Level from `runtime.logLevel`. | rotated at 5 MB × 3; same message ≤3× per 10 s then one `(repeated ×N more in 10s)` line; ≤20 lines/s per scope, excess counted |
| `errors.log` | warn and above only, with stacks | same guard |
| `sessions/<sessionId>.jsonl` | **the session trace**: one JSON object per line, everything needed to reconstruct a turn | ≤50 events of the same kind per second; VAD levels are never written |
| `searxng.log` | SearXNG process output | — |

Set `runtime.logTranscripts` off in Settings → Tuning to replace spoken/typed text in the trace with
its length (for sharing). `VA_TRACE=1 pnpm dev` prints the trace path on quit.

## The trace vocabulary

Every line has `t` (ISO time), `sid` (session), usually `turn`, and `ev`. Prefixes:

| prefix | source | events |
|---|---|---|
| `state` | agent state machine | `{from, to, event}` — every transition (`idle`, `listening`, `user_speaking`, `thinking`, `tool`, `speaking`, `interrupted`) |
| `ear.*` | sidecar events (never `level`) | `speech_start{earT}`, `partial{text}`, `speech_end{reason, silenceMs, turnP, speechMs, checks[{silenceMs,p,heldOnFiller,lastWord,capMs}], afterCut, capMs, segments}`, `segment{text, index}` (older part of a long utterance, turn still open), `final{text, durationMs, asrMs, asrRtf, queuedMs, afterCut, segments}`, `bargein{stage: duck|cut|release, prerollMs}`, `status{stage}`, `ready{loadS}`, `stats{turns, turnChecks, turnCostP50Ms, heldOnFiller, backchannels, cuts, cutsEmptyFinal}`, `error` |
| `turn.*` | agent core | `start{via, text, asrMs, queuedMs, endReason, silenceMs, turnP, model, style, mode, tools, memoryHints…}`, `first_token{ttftMs}`, `first_sentence{ttfsMs}`, `first_audio{ttfaMs, speechEndToAudioMs, ttsFirstMs, ttsFirstByteMs, rendererMs}`, `tool_start{id, name, summary}`, `tool_end{id, name, ok, ms, detail}`, `filler{kind: lead-in|continuation, text}`, `attempt{reason, model}`, `attempt_failed{error, transient}`, `stall{reason}`, `step_limit`, `notice{text}`, `self_cut_suspect{overlap}`, `dropped{reason}`, `spoken_split{seq, offsetS, durationS}`, `cancel{reason, spokenText, unspokenText, metrics}`, `drain_timeout{waitMs}` (the renderer never reported the audio finished, e.g. audio device error), `end{metrics, fillers, ttsDroppedFrames}`, `error{message}`, `mergeable{reason}` (this transcript looked unfinished; a resume inside the window merges), `continuation{gapMs}` (the user resumed: reply cancelled silently), `merged{parts, text}` (the joined transcript starts a turn), `segment{index}` |
| `tts.warm` | agent | `{turnId, ms}` — the Edge socket pre-opened at turn start (only logged when it had to reconnect or succeeded) |
| `tts.sentence` | speaker | `{seq, kind, chars, ms, firstByteMs, attempts, outcome: ok|skip|fallback, engine}` |
| `playback.*` | renderer via agent | `started{seq, kind}`, `finished{seq}`, `drained{chunks}` |
| `sidecar.*` | process supervisor | `spawn`, `connected{port, retries}`, `buffer_flushed{frames, ms}`, `ws_close{code, processAlive}`, `heartbeat_lost`, `restart{delayMs, reason?}` (`asr_broken` = the ears reloaded the speech model, kept failing, and exited with code 4), `idle_shutdown`, `exit{code}`, `handler_error{event}` (an exception inside the app's handler for a sidecar event, logged with its stack in errors.log) |
| `app.crash` | main process | `{kind: uncaughtException|unhandledRejection, message, stack}` — the app keeps running; the user gets one toast |
| `session.*` | | `start`, `select`, `summary{turns, latency{p50,p95}…}` |
| `settings.changed` | | `{changed: {'endpoint.prerollMs': 1000, …}}` |
| `ui.toast` | | what the user was shown |
| `trace.dropped` | | the trace's own ceiling fired |

## Reading a voice turn

A healthy voice turn looks like this (relative times from Diagnostics → Last turn):

```
+0       ear.speech_start
+…       ear.partial            text="what's the weather"
+1410    ear.speech_end         reason=done silenceMs=270 turnP=0.94 checks=[{silenceMs:270,p:0.94,…}]
+1500    ear.final              text="what's the weather like" asrMs=88
+1502    turn.start             via=voice model=… memoryHints=2
+1503    state                  from=user_speaking to=thinking
+1890    turn.first_token       ttftMs=388
+1950    turn.tool_start        name=web_search
+1955    turn.filler            kind=lead-in text="Let me check that."
+2100    tts.sentence           seq=0 kind=filler ms=140 firstByteMs=95
+2180    playback.started       seq=0 kind=filler
+3400    turn.tool_end          ok=true ms=1450
+3900    turn.first_sentence    ttfsMs=2398
+4100    turn.first_audio       speechEndToAudioMs=2690 ttsFirstMs=170
+…       playback.finished / drained
+7200    turn.end               metrics={…}
```

The number that matters is `speechEndToAudioMs` on `turn.first_audio`: it is `silenceMs` (how long
the ears waited) + `asrMs` + `ttftMs` + time to the first sentence + `ttsFirstMs` + `rendererMs`
(the chunk leaving main → the renderer starting it: IPC, MP3 decode, scheduling; normally 20–60 ms).
Each of those has a knob in `docs/TUNING.md`.

**"The text is all there but the voice starts seconds later."** `rendererMs` is large (it reached
3 s after 90 minutes of chat before the transcript was windowed and streaming updates were batched):
the renderer main thread is too busy to run the audio callbacks. `app.log` also has
`renderer:playback: seq 0 scheduled N ms after it arrived`. Check what else is loading the window
(DevTools, a huge tool result, an extension) and `uiFlushMs`.

## Three complaints

**"I said hello and nothing happened."** Look for the last `ear.*` events.
- No `ear.speech_start` at all → the mic never reached the ears. Check `sidecar.spawn`/`ready` and
  `sidecar.buffer_flushed` (frames captured while loading are replayed). `app.log` scope
  `renderer:capture` shows the device that was opened.
- `speech_start` but no `speech_end` → the turn never closed: `minSpeechMs` not reached (blip) or
  `maxSilenceMs` not reached yet. See the `checks[]` on the next `speech_end`.
- `ear.final` with empty `text` → `turn.dropped reason=empty-transcript`; the ASR heard nothing usable.
- `turn.start` but no `turn.first_token` → the model: look for `turn.attempt_failed`, `turn.stall`
  or `turn.error`. `attempt{reason: fallback}` means the primary was down.

**"It cut me off while I was thinking."** On the `ear.speech_end`: `reason=timeout` and `capMs`
tells you which cap fired (1500 = the model was unsure, 3000 = it said "not done" but you paused longer
than `maxSilenceLowMs`). Then look for `turn.mergeable` → `turn.continuation` → `turn.merged` on the
next turn: if they are there, the app joined your fragment with what you said next and only the merged
text got a reply.

**"It cut me off."** On the `ear.speech_end` that ended the turn, read `checks[]`:
- last `p` between `turnThreshold` and `turnHighThreshold` with `heldOnFiller=false` → the tiers
  worked as designed but the score was borderline: raise `turnThreshold` a notch.
- `p ≥ 0.9` → the model was confident; you probably paused. Raise `turnHighThreshold` or lengthen
  `minSilenceMs`.
- `reason=timeout` → not a cut; the hard cap fired.

**"It talked over me / interrupted itself."** Look at `ear.bargein`:
- `duck` then `release` → correct handling of a backchannel ("mhm"); nothing to fix.
- `cut` followed by `turn.self_cut_suspect` → the agent heard its own speaker output (empty transcript
  or high word overlap with what it was saying). `ear.stats.cutsEmptyFinal` counts these. Raise
  `bargeInThreshold`; if it keeps happening with speakers on, the echo gate (Phase 4) is the fix.
- `cut` with a real transcript → a genuine interruption; check `turn.cancel` shows `spokenText` /
  `unspokenText` split sensibly, and that the next `turn.start` follows.

**"It stopped understanding me / every transcript came back empty."** `ear.error` lines with
`decode failed: … CUBLAS failure` or `Failed to allocate memory` mean the GPU ran out of memory
(another app took the VRAM; `ear.stats.gpuMiB` shows the trend). After `asrFailureLimit` failures
the ears reload the model (`error: speech recognition was reloaded…`), and if that does not help they
exit with code 4 (`sidecar.exit{code:4}` → `sidecar.restart{reason:'asr_broken'}`) and the app shows a
toast. If the restart loops, free the GPU or switch STT to CPU in Settings.

**"It answered in the transcript but I heard nothing."** `tts.sentence` lines exist but no
`playback.started` follows, and `turn.drain_timeout` closes the turn → the renderer could not play:
`app.log` shows `renderer: The AudioContext encountered an error from the audio device`. Usually another
app (or a second copy of this one) holds the output device, or the selected output device is gone.

**"It goes quiet during searches."** Between `turn.tool_start` and `turn.tool_end` there should be a
`turn.filler kind=lead-in` and, past `speech.fillerAfterMs`, `kind=continuation`. If there is none,
fillers are off in Behaviour or `fillerMinGapMs` suppressed the lead-in.

## Turn-taking analysis and the tuning advisor

The Diagnostics view's **Turn-taking analysis** section is `analyzeSession()` (`src/core/diagnostics.ts`)
run over the current session's trace: turn ends by Smart Turn vs hard cap (and which cap), the score
histogram at the end, the last word at each timeout, fragments/continuations/merges, cancels, barge-in
stages, self-cut suspects, and the trouble counters (drops, stalls, fallbacks, ASR failures, crashes,
VRAM). The same numbers are in the **Copy diagnostics** report, so a bug report carries them.

**Suggest tuning** sends the parameter catalogue (every tunable with its doc, range and current value)
plus that analysis to the current chat model and asks for at most six single-parameter changes with a
reason each. Nothing changes until you press Apply; values are clamped to the parameter's range and no-op
suggestions are dropped (`parseSuggestions`). The run is traced as `tuning.suggested{model, suggestions}`
and the applied change as the usual `settings.changed`. Rough rules the advisor follows: hard-cap ends
with a low score → `maxSilenceLowMs` / `turnLowThreshold`; normal-cap ends with a mid score →
`maxSilenceMs` / `turnThreshold`; done-at-first-check plus continuations → filler words / hold; self-cut
suspects → `bargeInThreshold`; slow speech end → audio → `firstMinWords` / `maxTokens`.

## Scripted reproduction

```powershell
$env:VA_WAV = 'utterance.wav'; $env:VA_WAV2 = 'bargein.wav'; $env:VA_TRACE = '1'; pnpm dev
```

replays a 16 kHz mono wav through the ears, injects a second one while the agent speaks, and prints
the trace path on quit. Expect, in order: `ear.speech_end` with `checks`, `turn.start`,
`turn.first_audio` with `speechEndToAudioMs`, `ear.bargein stage=cut`, `turn.cancel` with
`spokenText`/`unspokenText`, `turn.spoken_split`, a second `turn.start` whose model history carries
the interruption note, and `ear.stats`. No `ear.level` lines should exist in the file.
