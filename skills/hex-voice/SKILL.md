---
name: hex-voice
description: Manage and troubleshoot local voice transcription in BB via Hex (`apple_speech` and local GGUF models).
---

# Hex Voice Plugin

This plugin registers the `hex` AI service (`Hex (Apple Speech)`) with BB for the chat composer's microphone dictation button and `bb voice transcribe <audio-file>`.

## Commands

- Check AI service status:
  ```sh
  bb settings ai-services show
  ```
- Select Hex as BB's active voice transcription service:
  ```sh
  bb settings ai-services set voice hex
  ```
- Check Hex plugin status and loaded models:
  ```sh
  bb hex status
  ```
- Transcribe an audio file via BB:
  ```sh
  bb voice transcribe /path/to/audio.wav
  ```
