# Changelog

All notable changes to this project are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

This file starts with the changes that added AI translation. Earlier history is not recorded.

## [Unreleased]

### Added

- AI translation provider backed by `llm-proxy.mjs`, with Gemini 3.5 Flash-Lite (Google), Qwen 3.8 27B (Groq), and GPT-OSS 120B (Groq).
- Model picker with Auto, Gemini, Qwen, and GPT-OSS options. Auto follows the server's `MODEL_ORDER`.
- Optional bearer token for the AI server, a per-address request limit, a `/health` endpoint, and automatic model fallback on failure or rate limit.
- Health pings on song changes while music plays, so a free Render instance stays awake.
- README setup guide for local and Render deployments, and this changelog.

### Changed

- The README, manifest, and extension description now list AI translation as a provider.
- DeepL and the AI server require Node.js 18 or newer.
- The settings button is described as a globe button in the documentation.

### Fixed

- A translation failure now applies its five-minute back-off only to the track that failed. The next track loads normally.
- A new track now starts loading from a debounce timer instead of waiting for the next polling tick. Rapid track changes load only the last track.
- A cached translation is used before the target-language check, so a song with a saved translation no longer shows an empty result.
- `CosmosAsync` status codes are mapped to typed lyrics errors only for numeric values of 400 or higher. String codes now fall back to the generic fetch error.
- The now-playing bar is ignored when the extension matches lyric text, so its text no longer triggers a false match.
- A translation cached by the selected provider is kept when the provider's API key is removed later, instead of being replaced by the Google fallback.
