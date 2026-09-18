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

**Changing a default.** `settings.json` only stores tuning values that differ from the defaults
(`stripTuningDefaults`), so a new default reaches everyone who never touched that knob. Files written
by older builds pinned every value; for those, each parameter lists its earlier defaults in
`superseded` and a stored value equal to one of them is replaced at load (`app.log`:
`settings: migrated defaults …`, and `settings.migrated` in the trace). When you change a `default`
in `tuning.ts`, add the old value to `superseded` in the same edit.

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
checks + `asrMs` + `ttftMs` + time to the first sentence break + Edge TTS first byte + `rendererMs`
(the UI decoding and scheduling the first chunk; normally 20–60 ms). Everything in this document
either shortens one of those stages or protects against cutting you off. If `rendererMs` climbs past
~150 ms the transcript is too busy to play audio on time: only the newest 80 messages are mounted and
streaming updates are batched (`uiFlushMs`), so a rising value now points at something else hogging
the renderer (DevTools, an extension, a huge tool result).

## Ears: turn taking (`endpoint`)

| key | default | old agent | what it does |
|---|---|---|---|
| `vadThreshold` | 0.5 | 0.5 | Silero probability that opens an utterance while listening. Lower catches quiet speech; too low and breaths/keyboard clicks start false turns (they are usually rejected as blips, but each one resets the VAD state). |
| `minSpeechMs` | 250 | 250 | Speech needed before an utterance counts. Under this it is a blip and never reaches ASR. Raise if coughs become turns; lower if very short answers ("yes") get dropped. |
| `minSilenceMs` | 250 | 250 | Silence before Smart Turn starts scoring. This is the *floor* of end-of-turn latency. Below ~200 the model scores mid-breath and cuts more. |
| `maxSilenceMs` | 1500 | 1200 | Hard end of turn while Smart Turn is *unsure* (score between `turnLowThreshold` and `turnThreshold`). If turns often end with reason `timeout` and `capMs` = this value, the model is on the fence about your endings: look at `speech_end.checks[].p` before raising it. |
| `turnLowThreshold` | 0.3 | — | Below this score Smart Turn is *sure you are not done*, and the cap switches to `maxSilenceLowMs`. This is what lets you stop and think mid-sentence. |
| `maxSilenceLowMs` | 3000 | — | How long a thinking pause may last while the model says "not done". In the stress-test session 55 of 60 timeouts happened with a last score under 0.5 — the user was thinking and the 1.2 s cap cut them. Raise if `capMs=3000` timeouts still show up in the trace while you are mid-thought; lower if the reply feels slow after you *really* stopped on a low score (rare: a real ending usually scores high). |
| `checkEveryMs` | 200 | 200 | Minimum extra silence between checks. Each check is one ONNX pass on 8 s of audio (10-30 ms CPU). Lower = earlier cut, more CPU. |
| `turnThreshold` | 0.7 | 0.7 | Below this the turn never ends. Raise if you get cut off mid-thought; lower if it waits for clear endings. |
| `turnHighThreshold` | 0.9 | 0.9 | At/above this the turn ends even if the live partial ends on a filler word — except once per utterance when `fillerHoldsHighTier` is on. Between the two, a trailing filler word always holds the turn open. Live testing showed raw Smart Turn cutting mid-hedge at 0.56-0.66, which is why the tiers exist. |
| `fillerWords` | (list) | 29 words | Comma-separated words that mean "not finished" when a pause lands right after them. The default now covers what people actually pause on: `then, basically, also, I'll, I'm, gonna, to, of, kind, sort, really, just…`. Add your own hedges. The core uses the same list to decide whether a transcript is a fragment (see `continuationWindowMs`). |
| `fillerHoldsHighTier` | true | false | A trailing filler word holds the turn once even at a confident score; the next check (200 ms later) decides. Two-thirds of confident ends in the stress test closed at the *first* check, 256 ms after the last word — this gives a hedge one more beat. |
| `silencePartialMs` | 100 | — | A pause this long forces one partial transcript so the guard reads your real last word; in the stress test 13 checks saw *no* caption at all and many saw one up to 600 ms old. Costs one extra decode per pause. |
| `partialEveryMs` | 600 | 600 | New audio between live partial transcripts. Partials feed captions *and* the filler-word guard, so a slower cadence means the guard looks at staler words. |
| `prerollMs` | 1000 | 1000 | Audio kept before speech is detected and prepended to the utterance. **Must exceed `bargeInChunks × 32 ms`**: after a barge-in cut the new utterance is seeded from this buffer, and the cut only fires once that much speech has already gone by. At 300 ms (the previous default) the first word after an interruption was lost. |
| `segmentEveryMs` | 30000 | — | While you keep talking, the older part of the utterance is transcribed every this often (`segment` events) and appears in your bubble; the turn stays open. 35 of the stress test's timeouts were 30 s monologues cut by the old cap. |
| `maxUtteranceMs` | 120000 | 30000 | Absolute cap on one utterance; with segmentation this only stops a stuck microphone. |

## Ears: barge-in (`endpoint`)

Barge-in is a leaky bucket of *net* speech credit while the agent is speaking or thinking. **You
always have priority**: in the default *instant* mode the agent is cut the moment `duckChunks` of
credit exist (≈100 ms of speech), there is no ducked phase and nothing is ever released. What you
said then decides what happens: a backchannel ("mhm", "yeah") or "go on" resumes the reply from the
cut sentence with no model call (see `resumePhrases`); anything else is your new turn.

```
frame p ≥ bargeInThreshold → credit += 1 (capped at bargeInChunks + duckChunks)
frame p <  bargeInThreshold → credit -= bargeInDecay
instant mode: credit ≥ duckChunks → cut: cancel the turn, open a new utterance from preroll
staged mode:  credit ≥ duckChunks     → duck playback to duckGain      (a "mhm" gets this far)
              credit ≥ bargeInChunks  → cut
              ducked and bargeInReleaseChunks quiet frames → release: backchannel, restore gain
```

| key | default | old agent | what it does |
|---|---|---|---|
| `bargeInInstant` | true | — | Instant mode (above). Turn off for the staged duck → cut → release behaviour, which tolerates backchannels but lets the agent talk over you for ~300 ms. |
| `bargeInThreshold` | 0.75 | 0.75 | VAD probability that counts as a hit while the agent is busy. Higher than `vadThreshold` so speaker bleed and room noise do not build credit. If the agent interrupts itself with open speakers, raise this first (0.85) and check `self-cut suspects` in Diagnostics. |
| `bargeInChunks` | 10 | 10 | Staged mode only: credits to cut (10 ≈ 320 ms of sustained speech). |
| `duckChunks` | 3 | 3 | Credits to cut (instant) or duck (staged); 3 ≈ 100 ms. The second knob for self-cuts with speakers (5 ≈ 160 ms). |
| `duckGain` | 0.25 | 0.25 | Volume while ducked; the renderer ramps to it over `playback.duckRampMs`. |
| `bargeInDecay` | 1 | 1 | Credit lost per quiet frame. Real speech is never uniformly above threshold; a hard reset on any miss (the old bug) meant sustained fluttery speech never reached the cut. Keep this small. |
| `bargeInReleaseChunks` | 6 | 6 | Staged mode only: quiet frames after a duck before it is called a backchannel (6 ≈ 190 ms). Too low and one utterance with micro-pauses flickers the volume and spams "backchannel" in the trace. |

## Brain (`brain`)

| key | default | old agent | what it does |
|---|---|---|---|
| `firstTokenTimeoutMs` | 8000 | 8000 | No first token after this → retry once → one turn on the fallback model. |
| `stallTimeoutMs` | 8000 | 8000 | Gap between tokens mid-stream that abandons the reply. Already-chunked sentences are still spoken and the transcript says "response cut short". |
| `toolStallTimeoutMs` | 25000 | 25000 | Same, while a tool call is in flight. |
| `retryBackoffMs` | 400 | 400 | Pause before the same-model retry on a transient error. |
| `maxStepsAsk` / `maxStepsAgent` | 4 / 8 | — | Tool rounds per turn by mode (a recall plus a few memory edits needs three or four). Hitting the cap before the model said anything is spoken ("I've hit my limit for tool calls this turn…") and traced as `hitStepLimit`. |
| `uiFlushMs` | 40 | — | How often a streaming reply is pushed to the transcript and saved while tokens arrive. Per-token pushes made every token a full re-render, which starved audio playback after an hour of chat (`rendererMs` grew to 3 s). 0 = every token. |
| `historyMessages` | 40 | — | Most recent messages sent to the model. |
| `minUtteranceChars` | 2 | — | Transcripts shorter than this are dropped without a turn. |
| `toolResultKeepChars` | 700 | 700 | Characters of each tool result kept in history for later turns. The model already consumed the full result when it ran; this keeps later turns lean. |
| `temperature` | 0.6 | 0.6 | Sampling temperature. |
| `maxTokens` | 1000 | 300 | Output cap per call. The old agent was voice-only and short; comprehensive styles need headroom. |
| `groqReasoningEffort` | low | low | Reasoning budget for Groq reasoning models. Voice cannot wait for long thinking. |
| `continuationWindowMs` | 2500 | — | A transcript that looks unfinished (ends on a filler word, fewer than `mergeMinWords`, a timeout on a low score, or dangling punctuation) is still answered, but if you start speaking again within this long the reply is cancelled silently and the two pieces become one turn ("and then I'll." + "finish it off."). In the stress test 36 turns were followed by a continuation within 4 s. 0 disables. Trace: `turn.mergeable`, `turn.continuation`, `turn.merged`. |
| `mergeMinWords` | 4 | — | Transcripts shorter than this always count as unfinished ("Yeah, so basically"). |
| `mergeHoldMs` | 0 | — | Wait this long before sending an unfinished-looking transcript to the model, so a continuation merges without a reply ever starting. Costs that much latency on real endings that look unfinished; 0 = reply immediately and cancel if you continue. |

## Speech (`speech`)

| key | default | old agent | what it does |
|---|---|---|---|
| `firstMinWords` | 4 | 6 | The first chunk may be released at a comma/colon/dash once it has this many words. "Yeah, let me think about that for a second, the answer is…" starts speaking after the first clause. The single biggest perceived-speed trick; 0 disables. Lowered from 6 after the stress test (first sentence took 313 ms of the 2.2 s median). The Edge socket is also pre-opened at turn start (`tts.warm` in the trace) so the first sentence skips the handshake. |
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
| `gapMs` | 20 | Minimum scheduling lead between chunks. The first chunk after silence uses 5 ms regardless: nothing is queued that it could collide with. |

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
| `asrFailureLimit` | 3 | Consecutive failed decodes before the ears reload the speech model once; failing again restarts the ears (exit code 4) with a toast. The stress test lost the last 5 minutes to a CUDA allocation failure that nothing recovered from. |
| `logTranscripts` | true | Include spoken text in the session trace on disk. |
| `logLevel` | info | Minimum level for `app.log`; `errors.log` always gets warn+. |

## Tuning recipes

Read the session trace (`docs/DEBUGGING.md`) before changing anything; every symptom below has a
field that confirms it.

- **It cuts me off while I think.** Look at the `speech_end` that ended the turn:
  `reason=timeout, capMs=1500` → the model was unsure (score between low and done thresholds) and the
  normal cap fired: lower `turnLowThreshold` is wrong here; raise `maxSilenceMs` a little or lower
  `turnThreshold`. `reason=timeout, capMs=3000` → you paused longer than the thinking cap: raise
  `maxSilenceLowMs`. `reason=timeout, capMs=120000` → the absolute cap; should never happen.
  `reason=done` with `checks[-1].lastWord` a hedge that is not in `fillerWords` → add it. If the next
  `turn.start` came within 2–3 s, `turn.merged` should have joined the pieces; if it did not, the
  fragment did not look unfinished — raise `mergeMinWords` or add the trailing word to `fillerWords`.
- **It cuts me off mid-sentence (no pause).** `speech_end.reason == 'done'` with `checks[-1].p` between
  0.7 and 0.9 and `lastWord` not a filler → raise `turnThreshold` a notch (0.75). If `p ≥ 0.9` the model
  is confident: raise `turnHighThreshold` or keep `fillerHoldsHighTier` on.
- **It waits too long after I finish.** Reason is `timeout` most of the time → the model never
  crossed `turnThreshold`; lower it to 0.6 before touching the caps. If reason is `done` but late, lower
  `checkEveryMs` or `minSilenceMs`. If it replies to a real ending only after `mergeHoldMs`, set that to 0.
- **My "mhm" interrupts it.** `bargein` shows `cut` after a short burst → raise `bargeInChunks` (12)
  or `bargeInThreshold`. `release` events are the healthy outcome for a backchannel.
- **I have to shout to interrupt it.** Raise nothing; lower `bargeInThreshold` (0.65) and check
  `bargeInDecay` is 1, not higher.
- **It interrupts itself with speakers on.** `stats.selfCutSuspects > 0` → raise `bargeInThreshold`;
  if that is not enough the echo gate (Phase 4) is the fix, not more threshold.
- **First word after I interrupt is missing.** `prerollMs` ≤ `bargeInChunks × 32`. Raise preroll.
- **It goes quiet during searches.** `fillerAfterMs` too high, or fillers disabled in Behaviour.
- **Replies start late but the model was fast.** `ttfsMs - ttftMs` large → the first sentence is
  long; lower `firstMinWords` (3) or `maxChars`.
