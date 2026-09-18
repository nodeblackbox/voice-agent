# Tuning

Every number that decides how the agent *feels* is defined once in `src/shared/tuning.ts` and
surfaced in Settings → Tuning. This page explains what each knob does, how they interact, and what
to look at before touching one. It is written for whoever (or whatever) is asked to "make it feel
more natural" — including an AI reading a session trace.

Where values apply:

| group | consumed by | takes effect |
|---|---|---|
| `endpoint`, `runtime.levelEveryFrames` | ear sidecar (`config.endpoint` message) | live |
| `brain`, `speech`, `memory` | agent core | next turn (`ttsPoolSize`: next launch) |
| `playback` | renderer | live |
| `runtime` (rest) | main process | live |

Export a profile from Settings → Tuning to get a JSON file with the current values, the diff from
defaults and (after Phase 3) the last session's p50/p95 latencies. Import merges a profile over the
defaults, clamping every value to its range and dropping unknown keys.

## How a voice turn is timed

```
you stop talking ──minSilenceMs──▶ Smart Turn checks every checkEveryMs ──▶ "done" (p ≥ threshold)
                                   │                                          │
                                   └── maxSilenceMs ─────────────────────────▶ "timeout"
                                                                              ▼
                                                            final ASR ──▶ first token ──▶ first sentence ──▶ first audio
                                                            (asrMs)       (ttftMs)         (ttfsMs)         (speechEndToAudioMs)
```

`speechEndToAudioMs` is the number humans feel. Roughly: `minSilenceMs` + one or two Smart Turn
checks + `asrMs` + `ttftMs` + time to the first sentence break + Edge TTS first byte. Everything in
this document either shortens one of those stages or protects against cutting you off.

## Ears: turn taking (`endpoint`)

| key | default | old agent | what it does |
|---|---|---|---|
| `vadThreshold` | 0.5 | 0.5 | Silero probability that opens an utterance while listening. Lower catches quiet speech; too low and breaths/keyboard clicks start false turns (they are usually rejected as blips, but each one resets the VAD state). |
| `minSpeechMs` | 250 | 250 | Speech needed before an utterance counts. Under this it is a blip and never reaches ASR. Raise if coughs become turns; lower if very short answers ("yes") get dropped. |
| `minSilenceMs` | 250 | 250 | Silence before Smart Turn starts scoring. This is the *floor* of end-of-turn latency. Below ~200 the model scores mid-breath and cuts more. |
| `maxSilenceMs` | 1200 | 1200 | Hard end of turn regardless of the model. The safety net against a mis-scoring model. If turns often end with reason `timeout`, the model is not confident on your speech: look at `speech_end.checks[].p` in the trace before raising this. |
| `checkEveryMs` | 200 | 200 | Minimum extra silence between checks. Each check is one ONNX pass on 8 s of audio (10-30 ms CPU). Lower = earlier cut, more CPU. |
| `turnThreshold` | 0.7 | 0.7 | Below this the turn never ends. Raise if you get cut off mid-thought; lower if it waits for clear endings. |
| `turnHighThreshold` | 0.9 | 0.9 | At/above this the turn ends even if the live partial ends on a filler word. Between the two, a trailing "um / so / and / but…" holds the turn open (the `FILLER_ENDINGS` list in `sidecar/ear/endpoint.py`). Live testing showed raw Smart Turn cutting mid-hedge at 0.56-0.66, which is why the tiers exist. |
| `partialEveryMs` | 600 | 600 | New audio between live partial transcripts. Partials feed captions *and* the filler-word guard, so a slower cadence means the guard looks at staler words. |
| `prerollMs` | 1000 | 1000 | Audio kept before speech is detected and prepended to the utterance. **Must exceed `bargeInChunks × 32 ms`**: after a barge-in cut the new utterance is seeded from this buffer, and the cut only fires once that much speech has already gone by. At 300 ms (the previous default) the first word after an interruption was lost. |
| `maxUtteranceMs` | 30000 | 30000 | Cap on one utterance. |

## Ears: barge-in (`endpoint`)

Barge-in is a leaky bucket of *net* speech credit while the agent is speaking or thinking:

```
frame p ≥ bargeInThreshold → credit += 1 (capped at bargeInChunks + duckChunks)
frame p <  bargeInThreshold → credit -= bargeInDecay
credit ≥ duckChunks     → duck playback to duckGain      (a "mhm" gets this far)
credit ≥ bargeInChunks  → cut: cancel the turn, open a new utterance from preroll
ducked and bargeInReleaseChunks quiet frames → release: it was a backchannel, restore gain
```

| key | default | old agent | what it does |
|---|---|---|---|
| `bargeInThreshold` | 0.75 | 0.75 | VAD probability that counts as a hit while the agent is busy. Higher than `vadThreshold` so speaker bleed and room noise do not build credit. If the agent interrupts itself with open speakers, raise this first and check `stats.selfCutSuspects`. |
| `bargeInChunks` | 10 | 10 | Credits to cut (10 ≈ 320 ms of sustained speech). |
| `duckChunks` | 3 | 3 | Credits to duck (3 ≈ 96 ms). |
| `duckGain` | 0.25 | 0.25 | Volume while ducked; the renderer ramps to it over `playback.duckRampMs`. |
| `bargeInDecay` | 1 | 1 | Credit lost per quiet frame. Real speech is never uniformly above threshold; a hard reset on any miss (the old bug) meant sustained fluttery speech never reached the cut. Keep this small. |
| `bargeInReleaseChunks` | 6 | 6 | Quiet frames after a duck before it is called a backchannel (6 ≈ 190 ms). Too low and one utterance with micro-pauses flickers the volume and spams "backchannel" in the trace. |

## Brain (`brain`)

| key | default | old agent | what it does |
|---|---|---|---|
| `firstTokenTimeoutMs` | 8000 | 8000 | No first token after this → retry once → one turn on the fallback model. |
| `stallTimeoutMs` | 8000 | 8000 | Gap between tokens mid-stream that abandons the reply. Already-chunked sentences are still spoken and the transcript says "response cut short". |
| `toolStallTimeoutMs` | 25000 | 25000 | Same, while a tool call is in flight. |
| `retryBackoffMs` | 400 | 400 | Pause before the same-model retry on a transient error. |
| `maxStepsAsk` / `maxStepsAgent` | 2 / 8 | — | Tool rounds per turn by mode. Hitting the cap is spoken ("I've dug through several pages…") and traced as `hitStepLimit`. |
| `historyMessages` | 40 | — | Most recent messages sent to the model. |
| `minUtteranceChars` | 2 | — | Transcripts shorter than this are dropped without a turn. |
| `toolResultKeepChars` | 700 | 700 | Characters of each tool result kept in history for later turns. The model already consumed the full result when it ran; this keeps later turns lean. |
| `temperature` | 0.6 | 0.6 | Sampling temperature. |
| `maxTokens` | 1000 | 300 | Output cap per call. The old agent was voice-only and short; comprehensive styles need headroom. |
| `groqReasoningEffort` | low | low | Reasoning budget for Groq reasoning models. Voice cannot wait for long thinking. |

## Speech (`speech`)

| key | default | old agent | what it does |
|---|---|---|---|
| `firstMinWords` | 6 | 6 | The first chunk may be released at a comma/colon/dash once it has this many words. "Yeah, let me think about that for a second, the answer is…" starts speaking after the first clause. The single biggest perceived-speed trick; 0 disables. |
| `maxChars` | 220 | 220 | Run-on sentences are force-cut at the last comma/space past this so a long sentence cannot stall first audio. |
| `fillerAfterMs` | 1500 | 1500 | If a tool is still running and nothing has played for this long, say one continuation filler ("Still looking."). Once per tool call. |
| `fillerMinGapMs` | 4000 | — | Skip the lead-in filler ("Let me check.") if another filler was spoken more recently than this, so back-to-back tool calls do not chatter. |
| `ttsPoolSize` | 3 | — | Edge TTS sockets kept open = sentences synthesized ahead of playback. Next launch. |
| `ttsTimeoutMs` | 12000 | — | Per-sentence Edge TTS timeout. |
| `ttsAttempts` | 2 | — | Tries per sentence before it is skipped (the text stays in the transcript). |
| `ttsDegradeAfter` | 3 | — | Consecutive failures before the rest of the turn uses the system voice (one toast). |

## Playback (`playback`)

| key | default | what it does |
|---|---|---|
| `duckRampMs` | 60 | Gain ramp when ducking/restoring. |
| `gapMs` | 20 | Minimum scheduling lead between chunks. |

## Memory injection (`memory`)

| key | default | old agent | what it does |
|---|---|---|---|
| `profileLimit` | 40 | — | Profile entries always injected. |
| `relevantLimit` | 6 | — | BM25 memory hits for the utterance. |
| `relevantMinScore` | 0 | — | Floor on \|bm25\| for a hit to be injected; 0 = always inject the top hits. Raise (try 2-4) if unrelated memories keep appearing in `turn.start.memoryHints`. |
| `historyHits` | 3 | 3 | Matching messages from *other* sessions injected as hints. |
| `hintMaxChars` | 200 | 200 | Truncation per hint. |

## Runtime and logging (`runtime`)

| key | default | what it does |
|---|---|---|
| `idleShutdownMs` | 300000 | Unload the ear models after the mic has been off this long; 0 never. A restart is a full cold load (Silero + Smart Turn + Parakeet), so audio spoken during it is buffered and replayed once ready. |
| `levelEveryFrames` | 3 | Frames between VAD level events for the UI meter (~10 Hz). Never written to logs. |
| `logTranscripts` | true | Include spoken text in the session trace on disk. |
| `logLevel` | info | Minimum level for `app.log`; `errors.log` always gets warn+. |

## Tuning recipes

Read the session trace (`docs/DEBUGGING.md`) before changing anything; every symptom below has a
field that confirms it.

- **It cuts me off mid-thought.** `speech_end.reason == 'done'` with `checks[-1].p` between 0.7 and
  0.9 and the last partial word not in the filler list → raise `turnThreshold` a notch (0.75) or add
  the word to `FILLER_ENDINGS`. If `p ≥ 0.9` the model is confident: lengthen your pauses or raise
  `turnHighThreshold`.
- **It waits too long after I finish.** Reason is `timeout` most of the time → the model never
  crossed `turnThreshold`; lower it to 0.6 before touching `maxSilenceMs`. If reason is `done` but
  late, lower `checkEveryMs` or `minSilenceMs`.
- **My "mhm" interrupts it.** `bargein` shows `cut` after a short burst → raise `bargeInChunks` (12)
  or `bargeInThreshold`. `release` events are the healthy outcome for a backchannel.
- **I have to shout to interrupt it.** Raise nothing; lower `bargeInThreshold` (0.65) and check
  `bargeInDecay` is 1, not higher.
- **It interrupts itself with speakers on.** `stats.selfCutSuspects > 0` → raise `bargeInThreshold`;
  if that is not enough the echo gate (Phase 4) is the fix, not more threshold.
- **First word after I interrupt is missing.** `prerollMs` ≤ `bargeInChunks × 32`. Raise preroll.
- **It goes quiet during searches.** `fillerAfterMs` too high, or fillers disabled in Behaviour.
- **Replies start late but the model was fast.** `ttfsMs - ttftMs` large → the first sentence is
  long; lower `firstMinWords` (4) or `maxChars`.
