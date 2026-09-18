# Architecture

Voice Agent is an Electron desktop app whose brain is TypeScript and whose ears are a small Python
sidecar. This page is the map: processes, the life of one voice turn, how an interruption cancels
everything, and where each concern lives. The planning history is in
[../NEW_ARCHITECTURE.md](../NEW_ARCHITECTURE.md); the ear protocol is in
[../sidecar/PROTOCOL.md](../sidecar/PROTOCOL.md).

## Processes

```mermaid
flowchart LR
  subgraph Electron
    direction TB
    R["Renderer<br/>React UI · mic capture (AudioWorklet)<br/>playback queue · loading cue"]
    P["Preload<br/>typed window.api bridge"]
    M["Main process<br/>window · IPC · service managers"]
    C["agent-core (pure TS)<br/>TurnController · providers · prompts<br/>speech · tools · memory"]
    R <-- "IPC: events, PCM frames, MP3 chunks" --> P
    P <--> M
    M --> C
  end

  E["ear-sidecar (Python)<br/>Silero VAD · Smart Turn v3.2 · Parakeet"]
  S["SearXNG<br/>127.0.0.1:8888"]
  X["MCP servers<br/>stdio / HTTP"]
  T["Edge TTS<br/>wss (Ava)"]
  L["LLM providers<br/>Anthropic · Groq · Gemini · xAI"]
  D[("SQLite + FTS5<br/>memory · sessions")]

  M -- "ws://127.0.0.1:port" --> E
  C -- "JSON API" --> S
  C -- "@modelcontextprotocol/sdk" --> X
  C -- "msedge-tts" --> T
  C -- "Vercel AI SDK" --> L
  C --> D
```

Everything outside the Electron box is a child process or a network service owned and supervised
by the main process. The renderer never talks to them directly.

| Concern | Where | Notes |
|---|---|---|
| Mic capture, device choice, AEC | `src/renderer/src/audio/capture*.ts` | Chromium's echo cancellation replaces the old cross-correlation echo gate. 16 kHz int16 frames. |
| Playback, ducking, ordering | `src/renderer/src/audio/playback.ts`, `chunk-queue.ts` | Chunks are MP3 per sentence; a pure `ChunkQueue` guarantees seq order and terminal markers. |
| Speech detection, end-of-turn, ASR, barge-in credit | `sidecar/ear/*` | Ported from the proven Python agent; magic numbers are config sent at connect time. |
| One turn: LLM stream → sentences → TTS → chunks | `src/core/turn/runner.ts`, `src/core/speech/*` | One `AbortSignal` per turn reaches every I/O. |
| Orchestration, state machine, sessions | `src/core/agent.ts`, `src/core/turn/state-machine.ts` | No Electron imports; unit-tested with mocks. |
| Providers, keys, fallback | `src/core/providers/*` | Model id strings `provider:model`; Groq key pool rotates on 429. |
| Prompts, styles, skills, speakable text | `src/core/prompts/*` | Style = full prompt body + length/format; skills are injected procedures. |
| Tools | `src/core/tools/*` | `web_search`/`read_page`/`research`, memory tools, `current_time`, MCP adapter. |
| Memory, sessions, projects | `src/core/memory/store.ts` | `node:sqlite` + FTS5 BM25; scopes = global + one per project. |
| Services | `src/main/services/*` | sidecar supervisor, SearXNG manager, MCP manager, settings + encrypted keys. |

## One voice turn

```mermaid
sequenceDiagram
  autonumber
  participant U as User
  participant R as Renderer
  participant E as ear-sidecar
  participant A as Agent (main)
  participant L as LLM
  participant T as Edge TTS

  U->>R: speaks
  R->>E: PCM frames (via main)
  E-->>A: speech_start · partial…
  E-->>A: speech_end (Smart Turn ≥ 0.7) → final{text}
  A->>A: compose system prompt<br/>(style · skills · time/location · memory)
  A->>L: streamText(tools, abortSignal)
  loop token stream
    L-->>A: text-delta
    A->>A: SpeakableFilter → SentenceChunker
    A->>T: synth(sentence)
    T-->>A: MP3
    A-->>R: AudioChunk{seq}
    R-->>U: plays (gapless, in order)
  end
  opt tool call
    L-->>A: tool-call{web_search}
    A->>T: filler "let me check that"
    A-->>R: cue on
    A->>A: run tool (same abortSignal)
    A->>L: tool-result
  end
  A->>T: last sentence · finish()
  R-->>A: playback drained
  A-->>R: state → listening
```

Measured on the reference machine (RTX 4090, Claude Haiku 4.5): end of speech → transcript
≈ 100 ms, → first audio ≈ 1.1–1.7 s.

## Interruption

Barge-in has to cancel *everything*, not just the audio. The sidecar decides, the agent cancels.

```mermaid
stateDiagram-v2
  [*] --> idle
  idle --> listening: mic on
  listening --> user_speaking: speech_start
  user_speaking --> thinking: speech_end / final
  thinking --> tool: tool-call
  tool --> thinking: tool-result
  thinking --> speaking: first audio played
  tool --> speaking: first audio played
  speaking --> listening: playback drained
  thinking --> interrupted: barge-in (cut)
  tool --> interrupted: barge-in (cut)
  speaking --> interrupted: barge-in (cut)
  interrupted --> user_speaking: user continues
  listening --> idle: mic off
```

While the agent is speaking the sidecar runs a leaky-bucket credit on speech probability:

```mermaid
flowchart LR
  F["VAD ≥ bargeInThreshold?"] -- yes --> H["credit += 1 (capped)"]
  F -- no --> D["credit -= decay"]
  H --> Q1{"credit ≥ duckChunks (≈100 ms)?"}
  Q1 -- yes --> DUCK["duck playback to duckGain"]
  H --> Q2{"credit ≥ bargeInChunks (≈320 ms)?"}
  Q2 -- yes --> CUT["cut: cancel turn, open new utterance"]
  D --> Q3{"ducked and misses ≥ releaseChunks?"}
  Q3 -- yes --> REL["release: it was a backchannel, restore gain"]
```

On `cut` the agent aborts the turn's `AbortController`. That single signal is threaded into the
LLM stream, every tool call (SearXNG `fetch`, MCP `callTool` → `notifications/cancelled`), the Edge
TTS sockets, the filler and loading cue, and the renderer's playback queue. The partially spoken
reply is kept in the transcript marked *interrupted*, with `spokenText` set to the sentences that
actually played, so the next model call sees what the user really heard.

## Prompt composition

Every turn rebuilds the system prompt from parts, so switching style or toggling a skill takes
effect immediately:

```mermaid
flowchart TB
  P["Persona<br/>(voice-first rules, listening rules)"] --> S["Style body<br/>Short · Balanced · Comprehensive · custom"]
  S --> F["Format rules<br/>plain speech vs markdown-to-transcript"]
  F --> T["Tool rules<br/>+ filler contract"]
  T --> K["Skills (enabled)<br/>trigger → procedure"]
  K --> C["Context<br/>now · timezone · location · project"]
  C --> M["Memory<br/>profile entries + BM25 hits for this utterance"]
  M --> OUT(["system prompt"])
```

For markdown styles, `SpeakableFilter` runs on the token stream before the sentence chunker: fenced
code becomes "the code is in the conversation", lists and links are flattened for the voice, and the
transcript keeps the full markdown.

## Error policy

| Failure | Behaviour |
|---|---|
| Utterance too short / empty transcript | Dropped silently; stays listening. |
| Sidecar crash / CUDA missing | Restart with backoff (1 s, 3 s, 10 s); exit code 3 → "switch STT to CPU" hint. Typed chat keeps working. |
| No first token in 8 s, stall > 8 s (25 s during a tool) | Retry once on the same model → one turn on the fallback model → spoken notice. If text was already spoken, keep it and note the cut. |
| Provider 429 (Groq) | Key pool benches the key for 60 s and rotates. |
| Tool error / SearXNG down | Returned to the model as an error string; pill turns amber; one `ensureRunning()` attempt first. |
| Edge TTS failure | Retry the sentence once → skip it → after 3 consecutive failures, system voice for the rest of the turn + one toast. |
| Barge-in during a tool | Same cancel path; late tool results are discarded by turn id. |

## Observability

Every behavioural number is a documented tuning parameter (`src/shared/tuning.ts`,
[TUNING.md](TUNING.md)); every turn is reconstructible from the session trace
(`logs/sessions/<sessionId>.jsonl`, [DEBUGGING.md](DEBUGGING.md)).

```mermaid
flowchart LR
  subgraph sources
    C["agent core<br/>state · turn.* · tts.* · playback.*"]
    E["ear sidecar<br/>speech_start/end · final · bargein · stats"]
    S["sidecar supervisor<br/>spawn · ready · reconnect · idle"]
    R["renderer<br/>console errors · capture/playback warnings"]
  end
  G["flood guard<br/>≤3 repeats / 10 s per template<br/>≤20 lines / s per scope"]
  C --> T["sessions/&lt;sid&gt;.jsonl<br/>structured trace"]
  E --> T
  S --> T
  C --> G
  E --> G
  S --> G
  R --> G
  G --> A["app.log (rotated)"]
  G --> X["errors.log (warn+)"]
  T --> D["Diagnostics view<br/>last-turn timeline · p50/p95 · ear stats<br/>Copy diagnostics → Markdown"]
```

Per-frame data (VAD levels) never reaches disk. Transcript text can be redacted from the trace with
`runtime.logTranscripts`.

## Testing

```mermaid
flowchart LR
  subgraph "pnpm test (vitest)"
    N["node project<br/>core · main services<br/>mock LLM (ai/test) · temp SQLite · mocked fetch/electron"]
    W["web project (jsdom)<br/>store reducer · chunk queue · formatters"]
  end
  subgraph "pytest (sidecar)"
    Y["fake VAD/turn/ASR<br/>endpoint tiers · barge-in bucket · pipeline sequences · protocol"]
    I["integration (opt-in)<br/>real models + wav replay"]
  end
```

CI runs the TypeScript suite on Windows and the Python unit suite on Linux without torch or a GPU.
