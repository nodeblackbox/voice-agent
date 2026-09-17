# ear-sidecar

The app's ears. A small Python process that takes 16 kHz microphone PCM over a localhost websocket and
emits speech events and transcripts: Silero VAD for speech detection, Smart Turn v3.2 for end-of-turn,
Parakeet TDT 0.6B (via `onnx-asr`, GPU) for transcription, plus the two-stage barge-in logic. The exact
message protocol is in `PROTOCOL.md`.

It is the only Python in the project; everything else is TypeScript.

## Setup

```powershell
.\install.ps1        # creates .\.venv with the pinned CUDA 12.4 stack (needs uv)
```

Dev shortcut: the old terminal agent's environment at `D:\Downloads\voiceAgent\.venv` already has every
dependency at the same pins, so pointing the app's *Python path* setting at
`D:\Downloads\voiceAgent\.venv\Scripts\python.exe` works without installing anything.

Models: Parakeet is fetched from Hugging Face on first start (honours `HF_HOME`); `install.ps1` downloads the
Smart Turn ONNX file (`pipecat-ai/smart-turn-v3`, `smart-turn-v3.2-cpu.onnx`) into `..\models\`.

## Run standalone

```powershell
cd sidecar
..\..\voiceAgent\.venv\Scripts\python.exe -m ear --port 0        # prints "EAR_PORT <port>" on stdout
python -m ear --stt-model nemo-parakeet-tdt-0.6b-v3 --stt-device cpu
```

Replay a recording against it (real-time by default, `--fast` to skip the pacing):

```powershell
python tests\replay_client.py --port <port> D:\Downloads\voiceAgent\audio\handy-1787878656.wav
python tests\replay_client.py --port <port> first.wav --bargein second.wav
```

Exit codes: `3` = CUDA requested but not available (use `--stt-device cpu`), `1` = other fatal load error.

## Tests

The unit tests need only `numpy`, `websockets` and `pytest` (`requirements-dev.txt`): every model is
injected as a fake, and the heavy imports (torch, onnxruntime, onnx-asr) are lazy, so CI runs them
without a GPU. From the repo root, with either the sidecar venv or the old project's venv:

```powershell
python -m pytest sidecar/tests -q
EAR_INTEGRATION=1 python -m pytest sidecar/tests -q -m integration   # real models + wav replay
```

What is covered: endpoint tiers and cadence (`test_endpoint.py`), the barge-in leaky bucket
(`test_bargein.py`), config parsing against PROTOCOL.md (`test_config.py`), Smart Turn feature
extraction (`test_whisper_features.py`), the protocol dispatch and the websocket handler
(`test_server_*.py`), and the frame pipeline's event sequences with scripted VAD/turn/ASR fakes
(`test_pipeline.py`).
