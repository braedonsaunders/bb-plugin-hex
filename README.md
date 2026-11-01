# bb-plugin-hex

On-device voice dictation for BB's chat composer and `bb voice transcribe`, powered by [`anomalyco/hex`](https://github.com/anomalyco/hex) and macOS 26's built-in Apple Speech (`SpeechTranscriber` + `SpeechAnalyzer`) or local GGUF speech models.

## Features

- **Composer microphone integration**: Registers `Hex (Apple Speech)` (`hex`) as a BB voice AI service via `bb.experimental_aiServices.register`.
- **Right-click microphone provider picker**: Right-clicking the microphone button in the BB composer shows a **Provider** picker right below **Input device**, listing all configured voice providers (`Hex (Apple Speech)`, `Codex`, etc.) so you can switch providers on the fly.
- **Zero-download Apple Speech on macOS 26**: Uses macOS 26's built-in `SpeechTranscriber` + `SpeechAnalyzer` (`apple_speech`) by default, or any of Hex's local GGUF models (`parakeet_unified_en`, `parakeet_v2`, `parakeet_v3`, `whisper_large_v3_turbo`, `qwen3_asr06_b`, `cohere_transcribe`, `nemotron_3_5_asr`).
- **Automatic lifecycle**: Starts `hex service --embedded` on demand, keeps it warm across dictations, and terminates it automatically on plugin reload or when BB exits (`bb.onDispose` + stdin lease).
- **Browser audio transcoding**: Converts `MediaRecorder` clips (`audio/webm`, `audio/mp4`, `audio/ogg`) to 16 kHz mono 16-bit PCM WAV via `ffmpeg`.

## Setup

1. Install `ffmpeg` (`brew install ffmpeg`) and ensure `hex` (`hex service --embedded`) is on `PATH` (e.g. `/opt/homebrew/bin/hex` or `~/.local/bin/hex`) or set `hexBinaryPath` in the plugin settings.
2. Install the plugin:
   ```sh
   bb plugin install https://github.com/braedonsaunders/bb-plugin-hex
   ```
3. Select `Hex (Apple Speech)` for voice input (or right-click the microphone button in the composer and choose it under **Provider**):
   ```sh
   bb settings ai-services set voice hex
   ```
4. Check status or test from the CLI:
   ```sh
   bb hex status
   bb voice transcribe /path/to/audio.wav
   ```
