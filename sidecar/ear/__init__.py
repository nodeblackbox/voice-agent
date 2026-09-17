"""ear-sidecar: microphone PCM in, speech events and transcripts out. See ../PROTOCOL.md."""

SR = 16000
CHUNK = 512
CHUNK_MS = CHUNK * 1000 / SR
