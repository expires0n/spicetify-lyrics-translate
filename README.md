# Lyrics Translate

<p align="center">
  <img src="assets/logo.png" alt="Lyrics Translate logo" width="420">
</p>

A [Spicetify](https://spicetify.app) extension that shows translations directly below Spotify's lyrics.

> **Status: experimental.** This project is a work in progress and is not stable yet. Lyrics come from Spotify's internal endpoints, Google Translate uses an unofficial endpoint, and AI translation depends on your own server and provider keys. An update to any of them can break things at any time, so expect bugs and rough edges. Please report problems in the issues tab.

## Features

- Translations appear under each lyric line.
- Choose a translation provider:
  - **Google Translate**: default, no API key needed (unofficial, see below).
  - **DeepL**: your API key plus a small local proxy included in this repository.
  - **Microsoft Translator**: your API key and resource region.
  - **Google Cloud Translation**: your API key, with billing enabled on the project.
  - **AI translation**: your own `llm-proxy.mjs` server, with Gemini, Qwen on Groq, or GPT-OSS 120B; pick a model or let the server decide.
- Choose the target and source language. The language list is in English, and language codes are converted automatically for each provider.
- A translation button (globe icon) appears next to Spotify's lyrics button in the playback bar:
  - Left-click: show or hide the translation.
  - Right-click: open the settings.
- If the selected provider fails (missing key, proxy not running, AI server unreachable, error, or quota used up), the extension uses Google for that request and shows why.
- Translations are cached per track, so the same song is not translated twice.
- If Google rate-limits requests, the extension pauses Google requests for a growing period instead of retrying constantly.

## Requirements

- Spicetify, installed and working with Spotify.
- Node.js 18 or newer, for DeepL or the AI server. Google Translate, Microsoft Translator, and Google Cloud Translation run without it.

## Installation

1. Copy `lyrics-translate.js` into your Spicetify extensions folder:
   - Windows: `%appdata%\spicetify\Extensions\`
   - Linux/macOS: `~/.config/spicetify/Extensions/`
2. In a terminal, run:

   ```sh
   spicetify config extensions lyrics-translate.js
   spicetify apply
   ```

3. Restart Spotify.

## Providers at a glance

| Provider | Key needed | Setup | Free tier |
| --- | --- | --- | --- |
| Google Translate | No | None | Unofficial endpoint, may be rate-limited or blocked |
| DeepL | Yes (DeepL API key) | Local proxy (Node.js) | 500,000 characters per month |
| Microsoft Translator | Yes (key and region) | Azure Translator resource | Free F0 tier |
| Google Cloud Translation | Yes (API key) | Billing enabled on the project | 500,000 characters per month |
| AI translation | Yes (Gemini and/or Groq key) | Self-hosted `llm-proxy.mjs` (Node.js) | Free tiers at Google AI Studio and Groq |

## Google Translate (default, no key)

The extension uses the same unofficial endpoint as Google's translate web widget (`translate.googleapis.com`). Keep these points in mind:

- It needs no key and no setup. It is also the fallback for every other provider.
- It is **not an official API**. Google does not support it for third-party use, does not promise it will keep working, and can change or block it at any time.
- Google rate-limits heavy use (HTTP 429). The extension reduces requests by translating each song in batches of up to 30 lines and by caching results. If you play many songs in a short time, Google may still block your connection for a while.
- When Google blocks a request, the browser shows **"Failed to fetch"**. A blocked response does not include the header a browser needs to read its status code, so the browser only reports a generic network failure.
- The extension then pauses Google requests: 2 minutes after the first block, then 4, 8, 16, and at most 30 minutes. Automatic retries stop during that time, and the error message shows how long is left. The wait is stored in Spotify's local storage, so **restarting Spotify does not clear it**. Clicking the button does not bypass it either.
- For reliable translations, use DeepL, Microsoft Translator, Google Cloud Translation, or the AI server with your own key. The extension still falls back to Google if they fail.

## DeepL (API key + local proxy)

Browsers do not allow web pages to call the DeepL API directly (CORS policy). So the extension sends its requests to a small local proxy, `deepl-proxy.mjs`, running on your computer. The proxy adds your key and forwards the request to DeepL. It only forwards the two DeepL endpoints the extension uses, and it does not store or log your key.

1. **Create a DeepL API account** at https://www.deepl.com/pro-api. The free plan is enough to start and includes 500,000 characters per month.
   Use a key from your DeepL **API** account. Keys shown in a DeepL Pro (consumer) account are not the ones the API accepts.
2. **Copy your key** from https://www.deepl.com/your-account/keys (the "API Keys" tab).
   - Free-plan keys end with `:fx`. The proxy sends those to `api-free.deepl.com` automatically.
   - Paid keys are sent to `api.deepl.com` automatically.
3. **Install Node.js 18 or newer** from https://nodejs.org. Check it with `node --version`.
4. **Start the proxy.** Open a terminal in the folder that contains `deepl-proxy.mjs` and run:

   ```sh
   node deepl-proxy.mjs
   ```

   You should see `DeepL proxy is running: http://127.0.0.1:8787`. Keep this window open while you want DeepL translations. Press Ctrl+C to stop it. You can also run it from any folder with `node "C:\path\to\deepl-proxy.mjs"`.

5. **Configure the extension.** Right-click the globe button, set **Translation provider** to **DeepL**, paste your key into **DeepL API key**, and click **Save**. The default proxy address is `http://127.0.0.1:8787`. Change it only if you started the proxy on another port (the proxy reads the `PORT` environment variable).
6. Open a song with lyrics and left-click the translation button.

When DeepL is not available, the extension uses Google for that request and shows the reason:

- **"Could not reach the DeepL proxy"**: the proxy is not running, or it is on a different port.
- **"DeepL error: …"**: DeepL rejected the request. Usually the key is wrong or the monthly quota is used up. Check your usage in your DeepL account.

## Microsoft Translator (API key + region)

The extension calls Azure AI Translator (v3) directly from the browser, so no proxy is needed.

1. In the Azure portal, create a **Translator** resource. The free F0 tier is available.
2. Open the resource's **Keys and Endpoint** page and copy a key and the resource **region** (for example `westeurope`).
3. Right-click the globe button, select **Microsoft Translator**, enter the key and the region, and click **Save**.

## Google Cloud Translation (API key + billing)

The extension calls the official Cloud Translation API (v2) directly from the browser.

1. In a Google Cloud project, enable the **Cloud Translation API** and link a billing account. Billing is required even for the free quota.
2. Under **Credentials**, create an API key and restrict it to the Cloud Translation API.
3. Right-click the globe button, select **Google Cloud Translation**, enter the key, and click **Save**.

The free quota is 500,000 characters per month. Usage beyond that is billed.

## AI translation (own server)

The AI provider sends the whole song to `llm-proxy.mjs`, a dependency-free Node.js server. The server asks a large language model for one translation per line, tries its models in order, and returns the first complete answer. If the server or every model fails, the extension falls back to Google.

The server is set up for three models:

- **Gemini**: `gemini-3.5-flash-lite`, through a Google AI Studio key.
- **Qwen**: `qwen/qwen3.8-27b`, through a Groq key.
- **GPT-OSS**: `openai/gpt-oss-120b`, through a Groq key.

`MODEL_ORDER` controls the order and defaults to `gemini,groq,gptoss`. Gemma (`gemma-4-31b-it`) is available when you add `gemma` to `MODEL_ORDER` and set `GEMINI_API_KEY`.

### Get the API keys

- Create a Gemini key at https://aistudio.google.com/apikey.
- Create a Groq key at https://console.groq.com/keys.

You need at least one key. A key turns on every model that uses it: `GEMINI_API_KEY` turns on Gemini and Gemma, and `GROQ_API_KEY` turns on Qwen and GPT-OSS.

### Run the server locally

1. Open a terminal in the folder that contains `llm-proxy.mjs`.
2. Set the keys you have for your shell and start the server:

   ```powershell
   $env:GEMINI_API_KEY="your_gemini_key_here"
   $env:GROQ_API_KEY="your_groq_key_here"
   node llm-proxy.mjs
   ```

   On Linux or macOS, use `export NAME=value` for the same variables.
3. Confirm the startup line: `LLM proxy is running: http://127.0.0.1:8788`. The next line lists the models that are set up.
4. Right-click the globe button, select **AI translation**, enter `http://127.0.0.1:8788` as the server address, and click **Save**.

### Deploy the server

Render runs the same file without changes. Create a web service, set the start command to `node llm-proxy.mjs`, add the keys, and set `ACCESS_TOKEN` before you make the service public. Render sets `PORT`, so the server listens on `0.0.0.0` and accepts requests from the extension.

- `GET /health` returns `{"ok":true,"models":["gemini","groq","gptoss"]}` when both keys are set. An empty list means no key is set.
- The free Render plan sleeps after 15 minutes without requests. The extension sends a health request when a song changes, at most once every 5 minutes, so the server stays awake while music plays. The first request after a sleep can take about a minute.
- Set `ACCESS_TOKEN` on the server and paste the same value into **AI access token** in the extension. Without a token, anyone who knows the address can spend your quota.
- `ALLOWED_ORIGIN` controls CORS. The default `*` works for every Spotify origin; set a specific origin if you want to restrict it.

### Request limits

| Limit | Value |
| --- | --- |
| Lines per request | 400 |
| Characters per line | 500 |
| Total characters | 20,000 |
| Requests per IP address | 40 per 10 minutes |
| Request timeout | 40s total, 20s per model |

The server rejects a request outside these limits. After a provider rate limit (HTTP 429), that model is paused for 60s and the next model is tried. Missing or empty lines count as a failed answer, so the server rejects the whole reply and moves on. `IP_MAX_REQUESTS`, `GROQ_MAX_TOKENS`, and the model ID variables change the defaults. The comments at the top of `llm-proxy.mjs` list every variable.

### Choose a model

The **AI model** setting has four values:

- **Auto** uses the server order.
- **Gemini**, **Qwen (Groq)**, and **GPT-OSS (Groq)** start with that model and fall back to the rest.

Changing the model does not replace saved translations. Use **Re-translate this song** to refresh the current song.

## Security

- API keys are stored in Spotify's local storage through Spicetify. They are never written to files in this repository, so do not add a key to the repository.
- The DeepL proxy listens only on `127.0.0.1`.
- The AI server listens on `127.0.0.1` when you run it locally. Set `ACCESS_TOKEN` before you expose it on the internet; without it, anyone who knows the address can use your provider keys.
- Translated text is sent to the provider you select, and to Google when a fallback happens. AI translation sends the lyrics to your server and then to Google (Gemini, Gemma) or Groq (Qwen, GPT-OSS).

## Known limitations

- Lyrics come from Spotify's internal, undocumented endpoint. It may stop working if Spotify changes it.
- Translated lines are matched to Spotify's page elements by their text. Interface changes can break this matching.
- The Google Translate endpoint is unofficial and can be rate-limited or blocked at any time.
- AI translation quality depends on the model and the song. The server rejects replies with missing or empty lines, but a model can still produce a weak translation. If every model fails, Google translates the song instead.
- The free Render plan puts the AI server to sleep after 15 minutes without requests. The extension keeps it awake while music plays, but the first song after a pause can wait about a minute.

## Troubleshooting

- **The translation button is missing:** run `spicetify apply` and restart Spotify.
- **No translation appears under the lyrics:** open the lyrics view and make sure translation is turned on.
- **"Failed to fetch" or "Google is not responding right now":** Google is rate-limiting your connection. Wait for the time shown in the message, or use another provider.
- **"Could not reach the DeepL proxy":** start `node deepl-proxy.mjs` and keep its window open.
- **"DeepL error":** check that the key is from the DeepL API account and that your monthly quota is not used up.
- **"Could not reach the AI server":** start `node llm-proxy.mjs`, check the server address, and confirm the access token matches `ACCESS_TOKEN`.
- **"AI server error":** open the server log. The message names the provider error, usually a wrong key or an exhausted quota. `GET /health` shows the models that are running.
- **AI translation falls back to Google:** the server returned no complete answer. Check the model order and the provider keys, or pick a single model in the settings.
- **The first AI translation takes about a minute:** the free Render instance was asleep. It wakes when the extension sends the health request.
- **After updating the extension:** run `spicetify apply` again and restart Spotify.
- **After a Spotify update breaks the extension:** run `spicetify restore backup apply`.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for notable changes.
