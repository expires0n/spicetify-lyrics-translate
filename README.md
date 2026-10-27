# Lyrics Translate

<p align="center">
  <img src="assets/logo.png" alt="Lyrics Translate logo" width="420">
</p>

A [Spicetify](https://spicetify.app) extension that shows translations directly below Spotify's lyrics.

> **Status: experimental.** This project is a work in progress and is not stable yet. Lyrics come from Spotify's internal endpoints, and Google Translate uses an unofficial endpoint. An update to either one can break things at any time, so expect bugs and rough edges. Please report problems in the issues tab.

## Features

- Translations appear under each lyric line.
- Choose a translation provider:
  - **Google Translate**: default, no API key needed (unofficial, see below).
  - **DeepL**: your API key plus a small local proxy included in this repository.
  - **Microsoft Translator**: your API key and resource region.
  - **Google Cloud Translation**: your API key, with billing enabled on the project.
- Choose the target and source language. The language list is in English, and language codes are converted automatically for each provider.
- A translation button appears next to Spotify's lyrics button in the playback bar:
  - Left-click: show or hide the translation.
  - Right-click: open the settings.
- If the selected provider fails (missing key, proxy not running, error, or quota used up), the extension uses Google for that request and shows why.
- Translations are cached per track, so the same song is not translated twice.
- If Google rate-limits requests, the extension pauses Google requests for a growing period instead of retrying constantly.

## Requirements

- Spicetify, installed and working with Spotify.
- Node.js 18 or newer, only if you want to use DeepL.

## Installation

1. Copy `lyrics-translate.js` into your Spicetify extensions folder:
   - Windows: `%appdata%\spicetify\Extensions\`
   - Linux/macOS: `~/.config/spicetify/Extensions/`
2. In a terminal, run:

   ```
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

## Google Translate (default, no key)

The extension uses the same unofficial endpoint as Google's translate web widget (`translate.googleapis.com`). Keep these points in mind:

- It needs no key and no setup. It is also the fallback for every other provider.
- It is **not an official API**. Google does not support it for third-party use, does not promise it will keep working, and can change or block it at any time.
- Google rate-limits heavy use (HTTP 429). The extension reduces requests by translating each song in batches of up to 30 lines and by caching results. If you play many songs in a short time, Google may still block your connection for a while.
- When Google blocks a request, the browser shows **"Failed to fetch"**. A blocked response does not include the header a browser needs to read its status code, so the browser only reports a generic network failure.
- The extension then pauses Google requests: 2 minutes after the first block, then 4, 8, 16, and at most 30 minutes. Automatic retries stop during that time, and the error message shows how long is left. The wait is stored in Spotify's local storage, so **restarting Spotify does not clear it**. Clicking the button does not bypass it either.
- For reliable translations, use DeepL, Microsoft Translator, or Google Cloud Translation with your own key. The extension still falls back to Google if they fail.

## DeepL (API key + local proxy)

Browsers do not allow web pages to call the DeepL API directly (CORS policy). So the extension sends its requests to a small local proxy, `deepl-proxy.mjs`, running on your computer. The proxy adds your key and forwards the request to DeepL. It only forwards the two DeepL endpoints the extension uses, and it does not store or log your key.

1. **Create a DeepL API account** at https://www.deepl.com/pro-api. The free plan is enough to start and includes 500,000 characters per month.
   Use a key from your DeepL **API** account. Keys shown in a DeepL Pro (consumer) account are not the ones the API accepts.
2. **Copy your key** from https://www.deepl.com/your-account/keys (the "API Keys" tab).
   - Free-plan keys end with `:fx`. The proxy sends those to `api-free.deepl.com` automatically.
   - Paid keys are sent to `api.deepl.com` automatically.
3. **Install Node.js 18 or newer** from https://nodejs.org. Check it with `node --version`.
4. **Start the proxy.** Open a terminal in the folder that contains `deepl-proxy.mjs` and run:

   ```
   node deepl-proxy.mjs
   ```

   You should see `DeepL proxy is running: http://127.0.0.1:8787`. Keep this window open while you want DeepL translations. Press Ctrl+C to stop it. You can also run it from any folder with `node "C:\path\to\deepl-proxy.mjs"`.

5. **Configure the extension.** Right-click the microphone button, set **Translation provider** to **DeepL**, paste your key into **DeepL API key**, and click **Save**. The default proxy address is `http://127.0.0.1:8787`. Change it only if you started the proxy on another port (the proxy reads the `PORT` environment variable).
6. Open a song with lyrics and left-click the translation button.

When DeepL is not available, the extension uses Google for that request and shows the reason:

- **"Could not reach the DeepL proxy"**: the proxy is not running, or it is on a different port.
- **"DeepL error: …"**: DeepL rejected the request. Usually the key is wrong or the monthly quota is used up. Check your usage in your DeepL account.

## Microsoft Translator (API key + region)

The extension calls Azure AI Translator (v3) directly from the browser, so no proxy is needed.

1. In the Azure portal, create a **Translator** resource. The free F0 tier is available.
2. Open the resource's **Keys and Endpoint** page and copy a key and the resource **region** (for example `westeurope`).
3. Right-click the microphone button, select **Microsoft Translator**, enter the key and the region, and click **Save**.

## Google Cloud Translation (API key + billing)

The extension calls the official Cloud Translation API (v2) directly from the browser.

1. In a Google Cloud project, enable the **Cloud Translation API** and link a billing account. Billing is required even for the free quota.
2. Under **Credentials**, create an API key and restrict it to the Cloud Translation API.
3. Right-click the microphone button, select **Google Cloud Translation**, enter the key, and click **Save**.

The free quota is 500,000 characters per month. Usage beyond that is billed.

## Roadmap

- **AI model providers:** planned support for LLM-based translation, such as Google Gemini and Alibaba's Qwen, using your own API key. This is not available yet.

## Security

- API keys are stored in Spotify's local storage through Spicetify. They are never written to files in this repository, so do not add a key to the repository.
- The DeepL proxy listens only on `127.0.0.1`.
- Translated text is sent to the provider you select, and to Google when a fallback happens.

## Known limitations

- Lyrics come from Spotify's internal, undocumented endpoint. It may stop working if Spotify changes it.
- Translated lines are matched to Spotify's page elements by their text. Interface changes can break this matching.
- The Google Translate endpoint is unofficial and can be rate-limited or blocked at any time.

## Troubleshooting

- **The translation button is missing:** run `spicetify apply` and restart Spotify.
- **No translation appears under the lyrics:** open the lyrics view and make sure translation is turned on.
- **"Failed to fetch" or "Google is not responding right now":** Google is rate-limiting your connection. Wait for the time shown in the message, or use another provider.
- **"Could not reach the DeepL proxy":** start `node deepl-proxy.mjs` and keep its window open.
- **"DeepL error":** check that the key is from the DeepL API account and that your monthly quota is not used up.
- **After updating the extension:** run `spicetify apply` again and restart Spotify.
- **After a Spotify update breaks the extension:** run `spicetify restore backup apply`.
