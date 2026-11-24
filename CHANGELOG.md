# Changelog

All notable changes to this project are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

This file starts with the changes that added AI translation. Earlier history is not recorded.

## [Unreleased]

### Removed

- Microsoft Translator and Google Cloud Translation providers, with their settings. Saved settings that pointed to them fall back to Google Translate.

### Added

- Turkish README (`README.tr.md`).
- Gemini 3.5 Flash option in the AI model picker.
- AI translation provider backed by `llm-proxy.mjs`, with Gemini 3.5 Flash-Lite (Google), Qwen 3.8 27B (Groq), and GPT-OSS 120B (Groq).
- Model picker with Auto, Gemini, Qwen, and GPT-OSS options. Auto follows the server's `MODEL_ORDER`.
- Optional bearer token for the AI server, a per-address request limit, a `/health` endpoint, and automatic model fallback on failure or rate limit.
- Health pings on song changes while music plays, so a free Render instance stays awake.
- README setup guide for local and Render deployments, and this changelog.

### Changed

- Improved AI translation quality with a rewritten prompt. The model now reads the whole song first, works out the speaker and mood, and translates meaning and feeling instead of word for word.
- Better handling of rap and hip-hop lyrics: slang is translated by its meaning with matching slang in the target language, the tone is kept, and the n-word is kept as written instead of being translated.
- Much better Japanese translations: the prompt now covers dropped subjects, sentences that run over several lines, onomatopoeia, katakana loanwords and romaji. Korean and Chinese lyrics get similar guidance.
- The extension now sends the song title, artist and Spotify's lyrics language to the AI server as optional context hints.
- Repeated lines now get the same translation, and instructions hidden inside lyrics are ignored.
- The AI server now tries Gemini 3.8 Flash first, then Gemini 3.5 Flash when the 3.8 Flash quota runs out, then Qwen and GPT-OSS. Default model order is `gemini,gemini35,groq,gptoss`, and Gemini uses the `low` thinking level by default.
- A model whose daily quota is used up is skipped for an hour instead of a minute.
- Google Translate now sends a whole song (up to 120 lines or 5,000 characters) in one request, and splits a batch in half instead of retrying line by line when lines come back merged. This cuts the number of requests and makes rate limits much rarer.
- When Google Translate is rate limited and an AI server address is set, the AI server translates instead of failing.
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
