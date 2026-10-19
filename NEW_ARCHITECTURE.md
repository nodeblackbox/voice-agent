# VoiceAiChatBot — New Architecture (planning document)

Standalone desktop voice agent in **Electron + TypeScript**, informed by the analysis of the old
terminal agent (`D:\Downloads\voiceAgent\ARCHITECTURE.md`). No implementation yet — this is the
document to review before Phase A starts.

Conventions used below: **[reuse]** = pattern/logic carried over from the old project,
**[new]** = not in the old project, **[replace]** = old project did this differently and we are
deliberately not carrying it over, **[verify in A0]** = a library/API claim that must be confirmed by
a short spike before it is relied on.

---

## 1. Tech stack and why

| Concern | Choice | Status | Why |
|---|---|---|---|
| Shell | Electron (latest stable) + `electron-vite` + `electron-builder` | new | Standalone desktop app, fast dev loop, Chromium gives us mic capture with built-in echo cancellation/noise suppression and per-device output routing for free. |
| Language | TypeScript everywhere in-app (main, preload, renderer, agent core) | new | Requirement. One language for brain + UI. |
| UI | React 18 + Tailwind + `lucide-react` | new | Matches the JSX prototype (icon rail, sessions sidebar, floating input bar, right "at a glance" panel, dark token palette). Prototype is rewritten in TSX, not copied. |
| LLM abstraction | **Vercel AI SDK** (`ai` + `@ai-sdk/anthropic`, `@ai-sdk/groq`, `@ai-sdk/google`, `@ai-sdk/xai`) | reuse (shape) | This is the LiteLLM-equivalent for TS: one `streamText()` call site, provider swapped by a model-id string, streaming + tool calling + `abortSignal` cancellation built in. Replaces the old project's *two* parallel provider layers (LiteLLM and LangChain `init_chat_model`) with one. |
| Agent loop | AI SDK multi-step tool loop (`streamText` with tools + step cap) | reuse (shape) | Same shape as the old LangGraph `create_agent` loop (max steps, stall timeout, tools from several sources) without LangGraph. Hand-rolled fallback loop is trivial if the SDK loop ever gets in the way. |
| MCP | `@modelcontextprotocol/sdk` (official TS client, stdio + streamable-HTTP transports) | reuse (idea), replace (impl) | MCP is native to TS. Old project's MCP via `langchain-mcp-adapters` "didn't really work" — new design makes every MCP failure visible (status panel, per-server logs) instead of silently dropping tools. |
| TTS | **Edge TTS, voice `en-US-AvaNeural`** via an npm Edge-TTS client (`msedge-tts` or equivalent) | replace | Requirement. No resident model, no VRAM, no second venv. Streams MP3/PCM over a websocket per sentence. NeuTTS is gone. **Kokoro-82M is back only as a contingency** (`sidecar/mouth`, same venv as the ears): spawned on demand when Edge is unreachable, Windows voice covers while it loads (~30s), turns stay on it for 60s before Edge is retried. Also selectable as the engine. |
| STT | **Parakeet TDT 0.6B v2 on GPU via `onnx-asr`** in a **Python sidecar** | reuse | The only proven local Parakeet-on-CUDA path we have is Python (`onnx-asr`, hybrid CUDA-encoder/CPU-int8-decoder from `bench/common.py`). No Node binding matches it. Sidecar is spawned/owned by the Electron main process. |
| VAD / turn detection | Silero VAD + **Smart Turn v3.2 ONNX**, running *inside the same sidecar* | reuse | Both models and the tuned endpoint logic (`endpoint.py`, 3-tier confidence + filler-word hold) already exist and work. Putting them next to STT keeps the audio pipeline in one process. LiveKit considered and not recommended for this build — see §5.4 and Open Question 1. |
| Memory | SQLite via `better-sqlite3` with FTS5 (BM25) | reuse | Same schema idea as `memory.py`, plus scopes (global / per-project) and a real UI. |
| Web search | SearXNG, local, clone-and-start from source | reuse | Same pattern as `search/install_searxng.py` + `run_searxng.py`; Node just calls the JSON API. |
| Settings / secrets | JSON in `app.getPath('userData')`; API keys in Electron `safeStorage` | new | No `.env`-in-repo, no Windows-registry env-var trick (`winenv.py`). |
| Audio I/O | Renderer: `getUserMedia` + `AudioWorklet` (capture), Web Audio + `AudioContext.setSinkId()` (playback) | replace | Replaces `sounddevice`. Chromium's AEC replaces most of the old `EchoGate` cross-correlation hack. |

**Explicitly dropped from the old project:** Kokoro as the main voice (it returned as the offline fallback, see TTS above), NeuTTS, the two-venv torch split, the
Windows-Job-Object subprocess dance, `winenv.py`, the JSON-file duplicate memory in `brain.py`, the
Rich/Textual TUI, the slash-command router as the primary UI (a few slash commands may survive in the
text box as power-user shortcuts, but every capability gets a real UI control).

---

## 2. Module breakdown and data flow

### 2.1 Processes

```
┌──────────────────────────────── Electron ────────────────────────────────┐
│                                                                          │
│  Renderer (React/TSX)                 Main process (Node/TS)             │
│  ┌──────────────────────┐   IPC       ┌────────────────────────────────┐ │
│  │ UI views              │◀──────────▶│ agent-core (pure TS library)   │ │
│  │ audio/capture (mic)   │  PCM 16k   │  ├ TurnController (cancel)     │ │
│  │ audio/playback (spk)  │◀───────────│  ├ providers (AI SDK)          │ │
│  │ state indicator       │  audio +   │  ├ prompt composer             │ │
│  └──────────────────────┘  events     │  ├ sentence chunker            │ │
│             ▲                         │  ├ tools: search, memory, mcp  │ │
│             │ preload (typed bridge)  │  ├ memory store (SQLite)       │ │
│             ▼                         │  └ tts (Edge TTS client)       │ │
│                                       │ services                       │ │
│                                       │  ├ sidecar manager ───────────┐│ │
│                                       │  ├ searxng manager ─────────┐ ││ │
│                                       │  └ mcp manager ───────────┐ │ ││ │
│                                       └───────────────────────────┼─┼─┼┘ │
└───────────────────────────────────────────────────────────────────┼─┼─┼──┘
                                                                    │ │ │
              child processes, all localhost, all owned by main:    │ │ │
              ┌──────────────────────────┐  ┌──────────────┐  ┌─────┴─┴─┴──────┐
              │ MCP servers (stdio)      │  │ SearXNG      │  │ ear-sidecar    │
              │ (npx / uvx / python)     │  │ 127.0.0.1:   │  │ (Python)       │
              └──────────────────────────┘  │ 8888         │  │ Silero VAD     │
                                            └──────────────┘  │ Smart Turn v3  │
                                                              │ Parakeet (GPU) │
                                                              │ ws://127.0.0.1 │
                                                              └────────────────┘
```

- **agent-core** has zero Electron imports. It exposes an event emitter + command API so it can later
  move to a `utilityProcess` if main-thread contention shows up. Phase A runs it in main.
- **ear-sidecar** is the *only* Python in the new project. It does audio → text and nothing else. If a
  Node-native Parakeet+GPU path appears later, it is a drop-in swap behind one websocket protocol.

### 2.2 One voice turn, end to end

```
mic ─▶ AudioWorklet (48k→16k mono int16, 32 ms frames)
        │ IPC (ArrayBuffer)
        ▼
    main: sidecar-manager ─▶ ws binary frames ─▶ ear-sidecar
                                                   │ Silero VAD per frame
                                                   │ utterance buffer
                                                   │ Smart Turn on silence ≥250 ms, every 200 ms, ≤1200 ms cap
                                                   │ partial transcripts every ~700 ms (captions + filler heuristic)
                                                   ▼ events (JSON): speech_start, partial, speech_end, final{text, conf}
    main: TurnController.onUserFinal(text)
        │  (cancel any in-flight assistant turn first — see §3.4)
        ▼
    prompt composer: [style body] + [format rules] + [context: time/tz/location/project] + [memory block]
        │
        ▼
    AI SDK streamText(model, messages, tools, abortSignal) ── tool calls ──▶ search / memory / mcp (all take the same signal)
        │ text deltas
        ▼
    SentenceChunker ─▶ per sentence: EdgeTTS.synth(sentence, signal) ─▶ audio chunks
        │ IPC (audio chunks, ordered, with sentence ids)
        ▼
    renderer: playback queue (Web Audio) ─▶ selected output device
        │ playback progress events back to main (for "speaking" state + barge-in duck/cut)
```

### 2.3 Source layout

```
VoiceAiChatBot/
  package.json, electron.vite.config.ts, tsconfig*.json, tailwind.config.ts
  src/
    main/                      Electron main: window, IPC wiring, service managers
      ipc/                     typed channel definitions + handlers (one file per domain)
      services/
        sidecar.ts             spawn/health/restart ear-sidecar, ws client, audio forwarding
        searxng.ts             ensureRunning(), healthz poll, log capture
        mcp.ts                 load mcp.json, connect servers, expose tools, status/log per server
        settings.ts            JSON settings file + safeStorage for keys
    preload/index.ts           contextBridge: window.api.* (typed)
    core/                      agent-core (no Electron imports)
      turn/                    TurnController, StateMachine, cancellation
      providers/               model registry, AI SDK provider factory, key pool
      prompts/                 built-in styles, composer, voice-text sanitizer
      speech/                  SentenceChunker, EdgeTTS client, filler/loading-cue policy
      tools/                   search.ts, memory.ts, mcp-adapter.ts, time.ts
      memory/                  schema.ts, store.ts (better-sqlite3 + FTS5), scopes
      context/                 time/timezone/location providers
    renderer/                  React app
      audio/                   capture.worklet.ts, capture.ts, playback.ts (queue + setSinkId)
      views/                   Chat, Prompts, Memory, Projects, Settings  (Skills, ClaudeCode → Phase C)
      components/              primitives from the prototype (Bars, Dot, IconBtn, Toggle, Btn, Select, Card, Dropdown, MenuItem)
      state/                   zustand (or equivalent) store mirroring agent events
      theme.ts                 the T token object from the prototype
  sidecar/                     Python ear-sidecar
    ear/                       server.py, vad.py, endpoint.py (ported), turn_model.py, asr.py, whisper_features.py (copied)
    requirements.txt           onnx-asr, onnxruntime-gpu, silero-vad, websockets, numpy
    install.ps1 / README.md
  search/
    install_searxng.ts (or .ps1)   download pinned SearXNG, create venv, apply patches
    settings.template.yml          checked in, no secret
    run.ts                         used by main/services/searxng.ts
  mcp/
    mcp.json                       server list (checked in, no secrets, ${ROOT} substitution)
    servers/demo/                  tiny first-party server used as the end-to-end MCP smoke test
  models/                        gitignored: smart-turn-v3.2-cpu.onnx, silero.onnx (downloaded by sidecar/install)
```

---

## 3. Requirement → module mapping

### 3.1 Platform / "quick to open"

- Window opens immediately; agent-core initialises synchronously (SQLite open, settings read, provider
  registry) — sub-100 ms.
- **Cold-start work happens in the background with visible status**: sidecar spawn + Parakeet load
  (multi-second on GPU), SearXNG start (lazy, on first search or a settings toggle "start at launch"),
  MCP server connects. The status indicator shows *warming up* per service; **typed input works
  immediately** even while the sidecar is still loading, because text turns don't need it.
- Edge TTS needs no warm-up (one websocket per sentence request).

### 3.2 LLM providers (`src/core/providers/`)

- One `ModelRef = { provider: 'anthropic'|'groq'|'google'|'xai', model: string }` and a registry of
  presentable entries (label, provider, capabilities). Default `anthropic / claude-haiku-4-5`.
- `createModel(ref)` returns an AI SDK `LanguageModel`; call sites only ever see `streamText()`.
- **[reuse]** Groq key pool (`GroqKeyPool` semantics: round-robin, bench on 429 for 60 s, permanent on
  401, probe with `GET /models`) — but keys are passed per request via the provider factory, never
  through a mutated global env (the old cross-SDK `os.environ` handoff is gone).
- **[reuse]** Overload fallback: retry once on the same model for 529/503/502/timeout, then one turn
  on a configured `fast` model, then back. Time-to-first-token / time-to-first-sentence are recorded
  per turn and shown in the header (the prototype's "84ms").
- Provider quirks (reasoning-effort knobs etc.) live in a per-provider options table keyed by exact
  model id, not `startsWith` string matching.

### 3.3 Prompts / switchable styles (`src/core/prompts/`)

- A **style** is a saved object: `{ id, label, desc, kind: 'built-in'|'custom', body, length:
  'short'|'balanced'|'comprehensive', format: 'plain'|'markdown' }`. Built-ins: Short, Balanced,
  Comprehensive (bodies from the prototype, refined). Custom styles are created in the Prompts view,
  including the prototype's "create a style with AI" flow (a one-shot `generateText` call with a
  drafting prompt; user edits then saves).
- **Composition every turn** (`composeSystemPrompt(style, ctx)`):
  1. style `body`
  2. format rules — `plain`: the old project's speech rules verbatim (no markdown/lists/code/URLs,
     spoken numbers); `markdown`: markdown and code blocks allowed *in the transcript*, with the
     instruction to narrate code rather than read it
  3. context block: current local time + timezone, location (set or IP-derived), active project name
  4. memory block: profile entries always + FTS-retrieved relevant entries
  5. tool guidance: when to search, when to `remember`, the filler-phrase contract (§3.7)
- **Voice-text sanitizer** (`toSpeakable(text, format)`): for `markdown` styles strips fences,
  replaces a code block with "the code is in the conversation", flattens list markers, drops URLs to
  their domain. The transcript keeps the full text; only TTS gets the sanitized stream. This is the
  "real branch" the old project lacked.
- Style is selectable at runtime from the input bar (prototype's style dropdown) and per project as a
  default. Length/format are stored on the style, so the two axes stay independent in data even though
  the UI presents named presets. (Open Question 3.)

### 3.4 Turn detection, barge-in, and cancellation (`sidecar/ear/`, `src/core/turn/`)

**Sidecar side [reuse, ported nearly verbatim from `endpoint.py` / `talk.py`]:**
- Silero VAD per 32 ms frame → speech probability.
- Utterance buffer; `speech_start` emitted once VAD crosses threshold for N consecutive frames.
- Endpointing: after ≥250 ms silence, run Smart Turn v3.2 on the last 8 s every 200 ms; 3 tiers
  (<0.7 never end; 0.7–0.9 end unless last partial word is a filler/conjunction; ≥0.9 end); hard cap
  1200 ms silence. All numbers are config, sent from the app at connect time (Settings → Advanced).
- Partial transcripts on a timer (non-blocking, never contends with the final decode).
- `final` carries `{ text, durationMs, confidence? }`. Parakeet TDT doesn't emit a clean confidence;
  we use utterance duration + VAD ratio + empty/very-short text as the "misrecognition" signal (§3.10).

**App side [new design, reusing the old state machine]:**
- `StateMachine`: `idle | listening | user_speaking | thinking | speaking | interrupted` (the old enum
  plus `idle` for "mic off / text only"), logged transitions, barge-in legal only from
  `thinking | speaking`.
- **`TurnController`** owns exactly one assistant turn at a time. It creates one `AbortController`
  whose signal is threaded into *everything* that turn spawns:
  - `streamText({ abortSignal })` — stops token generation and the tool loop
  - each tool call receives the same signal: SearXNG `fetch(url, { signal })`, page reads,
    memory queries (synchronous SQLite, but checked before/after), MCP `callTool(..., { signal })`
    which sends `notifications/cancelled` to the server [verify in A0]
  - `EdgeTTS.synth(sentence, signal)` — closes the websocket mid-sentence
  - renderer playback — `cancel(turnId)` flushes the queue and stops the current source node
  - the filler phrase and loading cue (§3.7) are part of the turn and die with it
- **Barge-in trigger**: the sidecar emits `speech_start` with a running "hot" credit
  **[reuse leaky-bucket]**: duck playback volume after ~96 ms of net speech credit (possible
  backchannel), cut after ~320 ms. Ducking is a renderer gain ramp; cutting calls
  `TurnController.cancel('barge-in')`. Because Chromium's AEC removes most speaker bleed, the old
  `EchoGate` cross-correlation gate is **not** ported in Phase A; the sidecar keeps an "agent is
  speaking" flag and a higher VAD threshold while speaking as the cheap guard. If AEC proves
  insufficient on the Yeti (it's a good mic — it will pick up speakers), the EchoGate math is ported
  as a Phase A.7 hardening item using the played-audio reference the renderer already has.
- After a cut, the partially-spoken assistant text is committed to the transcript marked
  `interrupted` (as the old `turns.interrupted` column did), so the next prompt sees what was actually
  heard, not what was generated.

### 3.5 STT (`sidecar/ear/asr.py`)

- **[reuse]** `load_parakeet()` from `bench/common.py`: `onnx-asr` loading
  `istupakov/parakeet-tdt-0.6b-v2-onnx` (v2 per requirement; v3 is what the old project ran — Open
  Question 2), hybrid CUDA encoder / CPU-int8 decoder, hard-fail if CUDA silently fell back.
- Mic audio arrives already 16 kHz mono int16 from the renderer worklet; no resampling in Python.
- Sidecar protocol (websocket on `127.0.0.1:<port>` chosen by the sidecar and printed on stdout at
  startup; main reads it):
  - client → server: binary frames = PCM; text frames = `{"cmd":"config",...}`,
    `{"cmd":"agent_speaking", "on":true}`, `{"cmd":"reset"}`
  - server → client: `ready{model, device}`, `speech_start`, `partial{text}`, `speech_end`,
    `final{text,...}`, `error{...}`, `stats{rtf, gpu}`
- Main restarts the sidecar with backoff on crash; UI shows *reconnecting*; typed input unaffected.

### 3.6 TTS (`src/core/speech/`)

- **[reuse]** `SentenceChunker`: port the regex splitter — end at `.!?…`, clause-break allowed for the
  *first* chunk only (time-to-first-audio), char-length fallback for run-ons.
- `EdgeTTS` client: one request per sentence, voice `en-US-AvaNeural` (Ava; Ava Multilingual as the
  alternate), output MP3 24 kHz (decoded in renderer with `decodeAudioData`) or raw PCM if the endpoint
  supports it for lower decode latency [verify in A0]. Requests for sentence N+1 are issued while
  sentence N plays (bounded lookahead of 2) so the queue never starves.
- Renderer playback: ordered queue keyed by `(turnId, sentenceIdx)`, gain node for ducking,
  `setSinkId` for output device, progress events back to main.
- **Risk**: Edge TTS is an unofficial endpoint (Edge "Read Aloud"); it has broken client libraries
  before when Microsoft changed token requirements. Mitigation: keep the client behind a
  `TTSEngine` interface with a **fallback engine** = Windows built-in voice via the renderer's
  `speechSynthesis` (zero dependencies, ugly voice, never fails). Announce the fallback once (§3.10).

### 3.7 Response pacing

- Normal replies: no artificial delay anywhere. First sentence is spoken as soon as the chunker
  yields it; target time-to-first-audio ≈ LLM TTFT + Edge TTS first-byte (~300–600 ms total on Haiku).
- Tool calls: when the model emits a tool call, the `TurnController`
  1. immediately speaks a short filler chosen from a small rotating set keyed by tool
     (`search` → "let me check that", `memory` → "one sec", generic → "hold on") — configurable, can
     be disabled (prototype's Behaviour toggle)
  2. starts the **loading cue**: a soft looping tone from the renderer at low gain (a synthesized
     Web Audio oscillator/noise loop, no asset needed), stopped when the tool returns or the turn is
     cancelled
  3. the tool result goes back into the loop and the model's follow-up is spoken normally
- Filler and cue are both tied to the turn's abort signal.
- The filler is *not* added to the transcript as an assistant message; it's shown as the tool pill
  (prototype's "Searching the web · SearXNG · 0:03").

### 3.8 Web search tool (`search/`, `src/core/tools/search.ts`, `src/main/services/searxng.ts`)

- **[reuse]** clone-and-start pattern: `search/install_searxng.*` downloads a **pinned** SearXNG
  commit (not master — the old regex patching against master is the fragile part), extracts to
  `search/searxng-src/`, creates `.venv-searxng` (uv, Python 3.11), installs SearXNG's requirements,
  applies the Windows import patch (`pwd/grp/fcntl/resource/termios/pty` → no-op on ImportError) from
  a **checked-in patch file** rather than inline regexes.
- `settings.template.yml` is checked in with the engine choices from the old project (Google, Brave,
  Startpage, Wikipedia, GitHub, StackOverflow, arXiv on; DDG/Qwant/Bing off), `format: json` enabled,
  `secret_key: __GENERATED__`. The installer writes `settings.local.yml` (gitignored) with a random
  key.
- `searxng.ts`: `ensureRunning()` — `GET /healthz`, else spawn `python -m searx.webapp` with
  `SEARXNG_SETTINGS_PATH`, poll ≤25 s, capture logs to `userData/logs/searxng.log`.
- Tools: `web_search(query)` (top 6 + answers/infobox), `read_page(url)` via `@mozilla/readability` +
  `jsdom` (with the PyPI JSON special case kept), `research(query, n)` (search then parallel reads).
  All accept the turn abort signal.
- **Public-repo packaging:**
  - include: installer script, `settings.template.yml`, the Windows patch file, `run.ts`, README
    steps (Python 3.11 + uv required)
  - exclude (gitignore): `search/searxng-src/`, `.venv-searxng/`, `settings.local.yml`, logs
  - no API keys involved; SearXNG hits public engines directly
  - alternative for users with Docker: document `docker run searxng/searxng` with the same
    `settings.local.yml` mounted — same URL, zero Python (Open Question 10)

### 3.9 Memory (`src/core/memory/`, Memory view)

- Schema (better-sqlite3, FTS5 with triggers, as in `memory.py`):
  - `scopes(id, name, path?, created_at)` — `global` + one per project
  - `entries(id, scope_id, kind: 'profile'|'fact'|'decision'|'todo', key, value, tags, source:
    'user'|'agent'|'ui', created_at, updated_at)` + `entries_fts`
  - `turns(id, session_id, ts, role, text, interrupted)` + `turns_fts` (history search; sessions are
    per-run in this build — Phase C makes them resumable)
- **Injection each turn** (not a tool): all `profile` entries for `global` + active scope (preferred
  gym, home location, mic…) + top-k BM25 hits from `entries`/`turns` for the user text above a
  `min_score`. Formatted as a compact block in the system prompt (§3.3 step 4).
- **Context block** each turn: `now` (local ISO + weekday + timezone), `location` from Settings
  (manual string wins; else optional IP lookup cached for the session; else "unknown, ask if needed").
- Tools: `remember(key, value, kind, tags)`, `forget(id)`, `recall(query)`, `search_history(query)`.
  `remember` respects the **confirm-before-save** toggle: when on, the write is queued and the chat
  shows the prototype's inline "Save 'Preferred gym'? Yes" chip.
- **Memory view** (prototype's notebook layout): scope list on the left (Global + projects), search,
  list with key/value/tags, inline edit, delete, add. All CRUD goes through IPC to the same store the
  agent uses — one source of truth.
- **Project scoping** (Projects view): a project = `{ name, path, default_style, scope_id }`. Active
  project decides which scope is loaded alongside `global` and which style is default. Mirrors how this
  planning session's own memory is scoped per working directory.

### 3.10 Error handling policy

| Failure | Detect | Behaviour |
|---|---|---|
| STT: empty / <2 chars / <300 ms speech | sidecar `final` | Drop silently; stay listening. No spoken "pardon". |
| STT: plausible but garbled (long speech, very short text; or model asks) | heuristic on duration vs. length | Show the transcript as-is (user can see it), let the model answer; if the model's tool/answer makes no sense the user just re-speaks. No auto-retry — re-decoding the same audio yields the same text. |
| Sidecar crash / GPU fail at load | process exit / `error` | Restart with backoff (1 s, 3 s, 10 s, then stop); banner "voice input unavailable"; typed input keeps working. CUDA-missing → offer CPU mode in the banner (slower, works). |
| Provider timeout (no first token in 8 s) / 5xx / 429 | AI SDK error, own timer | Retry once same model → one turn on `fast` fallback → announce once ("Claude isn't responding, I'll use Groq for now") and show it in the header. Groq 429 rotates the key pool first. |
| Provider stall mid-stream (>8 s between tokens, >25 s during a tool) | own timer | Abort the turn; speak what was already chunked; append "[response cut short]" to the transcript. |
| Tool error (SearXNG down, page fetch fails, MCP server error) | exception | Result returned to the model as an error string so it can answer from knowledge or say it couldn't check; UI tool pill turns amber with the reason. SearXNG down triggers one `ensureRunning()` attempt first. |
| TTS failure mid-sentence (socket error, empty audio) | EdgeTTS promise rejects | Retry that sentence once; if it fails again **skip it** and continue (text is still in the transcript). 3 consecutive failures → switch this turn to the fallback engine and speak "voice is degraded" once; header shows the engine. |
| Output device disappears | `setSinkId` rejects | Fall back to default device, toast. |
| Barge-in during a tool call | `speech_start` while `thinking` | Same cancel path; tool's abort signal fires; filler/cue stop; the user's new utterance becomes the next turn. Cancelled tool results are discarded even if they arrive later (turn id check). |

### 3.11 UI (React, from the prototype)

Kept for this build: icon rail (Chat, Prompts, Memory, Projects, Settings), sessions sidebar (current
run only), chat transcript with user/assistant/tool-pill messages, "read aloud"/copy actions, the
floating input bar with mode / model / style dropdowns, the **Voice** button with live ring + bars, the
right "at a glance" panel (services status, injected context, active style), Settings (voice list with
preview, mic + output device selects, GPU toggle, behaviour toggles, provider keys).

- **State indicator**: header pill + Voice button colour driven by `StateMachine` state and service
  status: `listening` (cyan bars), `thinking` (violet pulse), `searching`/tool name (violet pill with
  elapsed time), `speaking` (cyan bars on the message), `warming up`/`reconnecting` (amber).
- **Text input**: same textarea; Enter sends, Shift+Enter newline; typed turns go through the same
  `TurnController` and are spoken unless muted; typing while the agent speaks does *not* barge in —
  sending does.
- **Audio devices**: `enumerateDevices()` lists inputs/outputs; default pick = first device whose
  label matches `/yeti/i`, else system default; persisted by deviceId with label fallback (ids change
  across reinstalls). Output device applied via `setSinkId`.
- **Mode dropdown** (Ask / Agent) maps to step cap: Ask = 1 tool round max, Agent = up to 6 rounds
  (Open Question 9).
- Views deferred to Phase C: Claude Code, Skills. Their rail icons are omitted (not greyed) until then.

### 3.12 MCP (working this time) (`src/main/services/mcp.ts`, `src/core/tools/mcp-adapter.ts`, `mcp/`)

- Client: `@modelcontextprotocol/sdk` `Client` + `StdioClientTransport` / `StreamableHTTPClientTransport`.
  One long-lived connection per enabled server (reconnect per call is ~1 s, as the old project found).
- `mcp/mcp.json` format kept compatible in spirit with the old one (`stdio` with `command/args/env`,
  `http` with `url`, `enabled`), `${ROOT}` substitution for paths, **no absolute paths checked in**.
- Tools are namespaced `mcp__<server>__<tool>` and converted to AI SDK tool definitions (JSON schema
  passthrough). Every call passes the turn's abort signal.
- **Why it will work where the old one didn't**: (1) TS reference SDK instead of an adapter layer,
  (2) a Settings → MCP panel showing each server's state (starting / connected / failed + stderr
  tail + listed tools), (3) a checked-in first-party `mcp/servers/demo` (TS, `@modelcontextprotocol/sdk`
  server: `get_time`, `calculate`) that the smoke test connects to on first launch — if the demo
  server's tools don't show up in the panel, MCP is broken and we know immediately, (4) a "test call"
  button per tool in that panel.
- Trust model: `mcp.json` runs arbitrary commands; it's a local single-user file, but the panel
  shows exactly what command each server runs, and servers added via UI require confirmation.

---

## 4. Phased build order

### Phase A — core voice loop

**A0 — spikes (throwaway scripts, 1–2 days). Each produces a yes/no and a number.**
1. Edge TTS from Node: synthesize one sentence with `en-US-AvaNeural`, measure first-byte latency,
   confirm output formats and mid-stream cancellation. Confirm the npm client still works against the
   current endpoint.
2. Ear-sidecar: Python websocket server with Silero + Smart Turn + Parakeet v2 on this GPU; feed a
   wav, get `speech_start/partial/final`; measure end-of-speech → final latency. Confirms the
   CUDA/cuDNN pins on the target machine (the old README flags these as machine-specific).
3. Electron audio: `getUserMedia` with a chosen `deviceId` + AudioWorklet producing 16 kHz int16
   frames; playback queue with `setSinkId`; confirm AEC actually suppresses the agent's own voice
   from the Yeti at normal volume.
4. AI SDK: `streamText` with Anthropic/Groq/Google/xAI, tools, and `abortSignal`; confirm the
   step loop aborts cleanly mid-tool.
5. MCP: `@modelcontextprotocol/sdk` client → the demo server over stdio; list tools, call one, cancel
   one in flight.

**A1 — scaffold**: electron-vite + React + TS + Tailwind; theme tokens; typed IPC; settings service;
`StateMachine`; empty Chat view rendering fake turns.

**A2 — text-only turn**: providers + prompt composer + `TurnController` + streaming transcript; typed
input works end to end with no audio. Model/style dropdowns live.

**A3 — speak**: `SentenceChunker` + Edge TTS + renderer playback queue + output device select; typed
turns are spoken sentence-by-sentence; mute; read-aloud/stop per message.

**A4 — listen**: sidecar manager + audio capture + device select + partial captions; the Voice button
goes live; endpointing produces turns.

**A5 — barge-in & cancellation**: leaky-bucket duck/cut, `TurnController.cancel` wired to LLM, TTS,
playback, filler/cue; `interrupted` transcript marking. This is the phase to tune the magic numbers.

**A6 — state indicator & polish**: header states, warming-up/reconnecting banners, latency readout.

**A7 — hardening**: the §3.10 table implemented and tested by fault injection (kill sidecar, unplug
device, block Edge endpoint, fake 529). EchoGate port only if A0.3 showed AEC is not enough.

**Exit criteria for Phase A**: talk → hear the first sentence within ~1 s on Haiku; interrupt the
agent mid-sentence and it stops within ~350 ms and answers the new question; unplug the GPU path and
typed chat still works.

### Phase B — tools, memory, preferences

- B1 SearXNG installer + manager + `web_search/read_page/research` tools + filler phrase + loading cue
  + tool pills.
- B2 Memory store + injection + `remember/forget/recall/search_history` + confirm-before-save.
- B3 Memory view (CRUD) + Projects view + scope switching + per-project default style.
- B4 Context block: time/timezone + location (manual + optional IP lookup).
- B5 Prompts view: built-ins editable-as-copies, custom styles, "create with AI".
- B6 MCP manager + Settings → MCP panel + demo server smoke test + `mcp.json` UI editing.
- B7 Settings → Providers: key entry via `safeStorage`, Groq key pool UI, per-provider health dot.
- B8 Public-repo packaging pass: gitignores, `settings.template.yml`, README setup (Python 3.11 + uv,
  CUDA notes), no absolute paths, no personal audio.

### Phase C — future / out of scope now (architecture must not block these)

- **Claude Code SDK integration**: sessions list, lock-in, triggers ("when session X finishes, read
  the result"), voice answers to needs-input prompts, background agent spawning. The prototype's
  Claude Code view and toast. Kept possible by: agent-core is event-driven and Electron-free; the
  Projects model already has `path`; the tool registry accepts new sources.
- **Skills** (trigger + procedure snippets the agent reads before acting) — prototype's Skills view.
- **Cross-session persistence**: resumable sessions, sessions sidebar backed by the `turns` table
  (schema already has `session_id`), context summarisation on resume.
- Expose the agent itself as an MCP server (so Claude Code can call "speak"/"ask the user").
- Semantic memory (embeddings) behind the same `recall` interface.
- Packaging/installer with the sidecar bundled (pyinstaller or a managed venv), auto-update.
- Non-Windows support (sidecar CUDA pins, `setSinkId` availability).

---

## 5. Open questions / decisions needed before Phase A

1. **Turn detection framework — LiveKit vs. sidecar (recommendation: sidecar).** LiveKit Agents is
   the established option, but: the Node SDK is younger and would still need a custom Parakeet plugin;
   the mature Python SDK would pull the whole agent loop (LLM, TTS, tools) into Python, defeating the
   TS requirement; either way it needs a LiveKit server process and a WebRTC room even for a purely
   local app. Pipecat (Python) is the other established framework — Smart Turn is *their* model — but
   has the same "brain moves to Python" problem. The sidecar approach reuses the exact, already-tuned
   endpoint logic from the old project and keeps the brain in TS. **Confirm this, or tell me you'd
   rather accept a Python brain to get LiveKit/Pipecat's interruption handling for free.**
2. **Parakeet v2 vs v3**: requirement says v2; the old project runs `parakeet-tdt-0.6b-v3` (v3 adds
   multilingual, same size). Any reason to prefer v2, or should it be "whatever `onnx-asr` loads
   fastest on your GPU" decided in A0.2?
3. **Prompt style model**: named presets that each carry length + format (as the prototype shows) vs.
   two independent toggles in the input bar. I've designed data for both; which UI do you want?
4. **Memory write policy default**: silent writes (old behaviour) or confirm-before-save on by default?
5. **Location source**: manual only, or allow the IP-based lookup (external call to a geo-IP service,
   city-level, cached per session)? Which service, if any, are you comfortable with?
6. **API keys**: Settings UI + `safeStorage` only, or also honour a dev `.env` for convenience?
7. **MCP first servers**: beyond the demo smoke-test server, which real ones do you want enabled by
   default — official `filesystem` (scoped to the active project path), `fetch`, something else?
8. **Ask/Agent mode**: include in Phase A as a simple step-cap switch (cheap) or leave it out until B?
9. **Sessions sidebar in Phase A**: show current-run sessions only (in-memory, lost on quit), or hide
   the sidebar entirely until Phase C persistence? Showing it with in-memory data matches the
   prototype but might set a false expectation.
10. **SearXNG delivery**: from-source installer (as before, Python 3.11 + uv required) as the primary
    path with Docker documented as optional — or the reverse?
11. **Edge TTS fallback**: is the Windows built-in voice acceptable as the emergency fallback, or do
    you want a second cloud voice (e.g. a paid TTS API) wired in from the start?
12. **Target machine**: is this being built and run only on the current PC (same GPU/driver as the old
    project) for now? If yes, A0.2 reuses the old CUDA pins verbatim; if not, I need the target
    GPU/driver.
