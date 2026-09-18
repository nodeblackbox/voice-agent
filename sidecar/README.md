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

The app looks for Python in this order: Settings → Voice input → *Python path* (`stt.pythonPath`), the
`VA_PYTHON` environment variable, `sidecar\.venv\Scripts\python.exe`, then `python` on PATH. Any venv
with the same pins works (for example an existing one from another project); point the setting at its
`python.exe` instead of installing twice.

Models: Parakeet is fetched from Hugging Face on first start (honours `HF_HOME`); `install.ps1` downloads the
Smart Turn ONNX file (`pipecat-ai/smart-turn-v3`, `smart-turn-v3.2-cpu.onnx`) into `..\models\`.

## Run standalone

```powershell
cd sidecar
.\.venv\Scripts\python.exe -m ear --port 0        # prints "EAR_PORT <port>" on stdout
python -m ear --stt-model nemo-parakeet-tdt-0.6b-v3 --stt-device cpu
```

Replay a recording against it (real-time by default, `--fast` to skip the pacing):

```powershell
python tests\replay_client.py --port <port> path\to\utterance.wav
python tests\replay_client.py --port <port> first.wav --bargein second.wav
```

Exit codes: `3` = CUDA requested but not available (use `--stt-device cpu`), `1` = other fatal load error.

## Tests

The unit tests need only `numpy`, `websockets` and `pytest` (`requirements-dev.txt`): every model is
injected as a fake, and the heavy imports (torch, onnxruntime, onnx-asr) are lazy, so CI runs them
without a GPU. Run them from this directory (the `tests` package name can collide with a `tests`
package installed in the user site-packages when run from elsewhere):

```powershell
cd sidecar
python -m pytest tests -q
$env:EAR_INTEGRATION=1; python -m pytest tests -q -m integration   # real models + wav replay
```

`test_vad.py` needs `onnxruntime` and `silero-vad` installed and is skipped otherwise; it asserts the
VAD runs without importing torch.

What is covered: endpoint tiers and cadence (`test_endpoint.py`), the barge-in leaky bucket
(`test_bargein.py`), config parsing against PROTOCOL.md (`test_config.py`), Smart Turn feature
extraction (`test_whisper_features.py`), the protocol dispatch and the websocket handler
(`test_server_*.py`), and the frame pipeline's event sequences with scripted VAD/turn/ASR fakes
(`test_pipeline.py`).
