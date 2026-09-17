# Creates sidecar/.venv (Python 3.11) with the pinned CUDA 12.4 stack. Requires `uv` on PATH.
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
  Write-Error "uv not found. Install it from https://docs.astral.sh/uv/ and re-run."
}

if (-not (Test-Path ".venv")) {
  uv venv --python 3.11 .venv
}
uv pip install --python .venv\Scripts\python.exe -r requirements.txt

$models = Join-Path (Split-Path -Parent $here) "models"
New-Item -ItemType Directory -Force $models | Out-Null
if (-not (Test-Path (Join-Path $models "smart-turn-v3.2-cpu.onnx"))) {
  Write-Host "Downloading Smart Turn v3.2 (pipecat-ai/smart-turn-v3)..."
  & .venv\Scripts\python.exe -c "from huggingface_hub import hf_hub_download; import shutil; p = hf_hub_download('pipecat-ai/smart-turn-v3', 'smart-turn-v3.2-cpu.onnx'); shutil.copy(p, r'$models\smart-turn-v3.2-cpu.onnx'); print('saved', r'$models\smart-turn-v3.2-cpu.onnx')"
}

Write-Host ""
Write-Host "ear-sidecar environment ready:" -ForegroundColor Green
Write-Host "  python: $here\.venv\Scripts\python.exe"
Write-Host "In the app, Settings > Voice input > Python path should point at that file (it is the default when it exists)."
Write-Host "Parakeet downloads from Hugging Face on first start (set HF_HOME to choose the cache dir)."
