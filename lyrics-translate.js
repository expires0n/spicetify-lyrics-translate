// NAME: Lyrics Translate
// DESCRIPTION: Adds translations below Spotify lyrics using Google Translate, DeepL, Microsoft Translator, Google Cloud Translation or a self-hosted AI server. Globe button: left-click toggles the translation, right-click opens the settings.
// VERSION: 2.1.0
//
// PERFORMANCE NOTES (2.1.0 "low-footprint" rewrite):
// - No fixed polling loops. Work is event-driven: songchange + History.listen + a MutationObserver
//   scoped to the lyrics container only (never document.body). A single adaptive heartbeat remains
//   as a cheap safety net and does zero DOM walks when idle.
// - DOM mutations are coalesced into one batched scan per ~120ms; huge re-renders collapse into a
//   single container-scoped walk.
// - norm() has a fast path (skips regex replaces for plain text) plus a bounded memo cache.
// - Injected elements are tracked in a Set: cleanup is O(injected), not a document-wide query.
// - Settings are parsed once and kept in memory.
// - Window hidden / lyrics view closed / translation off => observer detached, timers stopped.
// - Automatic mode does not even fetch lyrics while the lyrics view is closed.
// - Repeated lines (choruses) are deduplicated before hitting the translation provider.
// - All provider fetches have timeouts so a hung request can never wedge the extension.
// - The playbar button is placed via a childList-only observer on the playbar, not a 2s interval.

var LyricsTranslate = (function () {
  "use strict";

  const PREFIX = "lyricsTranslate:";
  const SETTINGS_KEY = PREFIX + "settings";
  const CACHE_INDEX_KEY = PREFIX + "cacheIndex";
  const CACHE_LIMIT = 150;
  const BATCH_SIZE = 50;
  const STYLE_ID = "lyricsTranslate-style";
  const INLINE_ATTR = "data-lt-tr";
  const INIT_RETRY_LIMIT = 100;
  const SONG_CHANGE_DEBOUNCE_MS = 1500;

  // Scheduler tuning. The heartbeat never walks the DOM; it only checks a few element references.
  const SCAN_BATCH_MS = 120;
  const SCREEN_CHECK_MS = 600;
  const PLACEMENT_DEBOUNCE_MS = 250;
  const PLACEMENT_SAFETY_MS = 5000;
  const HEARTBEAT_ACTIVE_MS = 1500;
  const HEARTBEAT_IDLE_MS = 6000;
  const HEARTBEAT_NO_VIEW_MS = 3000;
  const HEARTBEAT_HIDDEN_MS = 20000;
  const FETCH_TIMEOUT_MS = 20000;
  const NORM_CACHE_MAX = 2000;
  const MAX_TEXT_LEN = 300;
  const MAX_ANCESTOR_LEN = 1000;
  const SCAN_NODE_BURST = 300;

  const DEFAULT_PROXY = "http://127.0.0.1:8787";
  const GTX_ENDPOINT = "https://translate.googleapis.com/translate_a/single";
  const GTX_MAX_LINES = 30;
  const GTX_MAX_CHARS = 1500;
  const MS_ENDPOINT = "https://api.cognitive.microsofttranslator.com/translate";
  const MS_MAX_LINES = 50;
  const MS_MAX_CHARS = 40000;
  const GCLOUD_ENDPOINT = "https://translation.googleapis.com/language/translate/v2";
  const GCLOUD_MAX_LINES = 50;
  const GCLOUD_MAX_CHARS = 5000;
  const LYRICS_ENDPOINT = "https://spclient.wg.spotify.com/color-lyrics/v2/track/";
  const LLM_TIMEOUT_MS = 60 * 1000;
  const LLM_WAKE_MS = 5 * 60 * 1000;

  // Known lyrics roots. If none match (Spotify redesign), the /lyrics route falls back to the main
  // view, which still excludes the playbar and sidebars. injectNow() keeps a one-shot body fallback.
  const CONTAINER_SELECTOR =
    '.lyrics-lyricsContainer-LyricsContainer,.lyrics-lyrics-container,[data-testid="lyrics-container"],[data-testid="lyrics-page"],.Root__lyrics-cinema';

  const LINKS = {
    deeplSignup: "https://www.deepl.com/pro-api",
    deeplKeys: "https://www.deepl.com/your-account/keys",
    nodejs: "https://nodejs.org",
  };

  const DEFAULTS = {
    provider: "google",
    deeplKey: "",
    deeplProxy: DEFAULT_PROXY,
    msKey: "",
    msRegion: "",
    gcKey: "",
    llmUrl: "",
    llmToken: "",
    llmModel: "auto",
    targetLang: "TR",
    sourceLang: "auto",
    inline: true,
    deeplGuideShown: false,
  };

  const DEEPL_SOURCE = ["AR", "BG", "CS", "DA", "DE", "EL", "EN", "ES", "ET", "FI", "FR", "HU", "ID", "IT", "JA", "KO", "LT", "LV", "NB", "NL", "PL", "PT", "RO", "RU", "SK", "SL", "SV", "TR", "UK", "ZH"];
  const DEEPL_TARGET = ["AR", "BG", "CS", "DA", "DE", "EL", "EN-GB", "EN-US", "ES", "ET", "FI", "FR", "HU", "ID", "IT", "JA", "KO", "LT", "LV", "NB", "NL", "PL", "PT-BR", "PT-PT", "RO", "RU", "SK", "SL", "SV", "TR", "UK", "ZH"];

  const GOOGLE_CODE_MAP = { EN: "en", "EN-GB": "en", "EN-US": "en", PT: "pt", "PT-BR": "pt", "PT-PT": "pt", ZH: "zh-CN", NB: "no" };
  const MS_CODE_MAP = { "EN-GB": "en", "EN-US": "en", PT: "pt", "PT-BR": "pt", "PT-PT": "pt-pt", ZH: "zh-Hans" };

  const ICON =
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="8" cy="8" r="6.4"/><path d="M1.6 8h12.8M8 1.6c-2.3 2.3-2.3 10.5 0 12.8M8 1.6c2.3 2.3 2.3 10.5 0 12.8"/></svg>';

  const CSS = `
[${INLINE_ATTR}]::after{content:attr(${INLINE_ATTR});display:block;box-sizing:border-box;width:100%;flex-basis:100%;font-size:max(.5em,12px);line-height:1.3;font-weight:500;margin-top:.3em;opacity:.92;white-space:normal;text-transform:none;letter-spacing:normal;}
.lt-overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:100000;display:flex;align-items:center;justify-content:center;}
.lt-modal{background:var(--spice-main,#181818);color:var(--spice-text,#fff);border-radius:8px;width:min(640px,92vw);max-height:85vh;display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,.5);}
.lt-header{display:flex;align-items:center;justify-content:space-between;padding:16px 20px 8px;}
.lt-header h2{margin:0;font-size:18px;font-weight:700;}
.lt-body{padding:8px 20px;overflow-y:auto;flex:1 1 auto;}
.lt-footer{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;padding:12px 20px 16px;}
.lt-btn{background:var(--spice-button,#1db954);color:var(--spice-button-text,#000);border:0;border-radius:500px;padding:8px 16px;font-weight:700;cursor:pointer;}
.lt-btn.lt-ghost{background:transparent;color:var(--spice-text,#fff);box-shadow:inset 0 0 0 1px var(--spice-subtext,#b3b3b3);}
.lt-note{font-size:13px;color:var(--spice-subtext,#b3b3b3);margin:6px 0;line-height:1.5;}
.lt-note ol{padding-left:20px;}
.lt-warn{background:rgba(255,183,0,.12);border-left:3px solid #ffb700;padding:8px 12px;border-radius:4px;font-size:13px;margin:8px 0;}
.lt-field{display:flex;flex-direction:column;gap:4px;margin:10px 0;font-size:13px;}
.lt-field input,.lt-field select{background:var(--spice-card,#242424);color:var(--spice-text,#fff);border:1px solid #333;border-radius:4px;padding:8px;font-size:14px;}
.lt-row{display:flex;align-items:center;gap:8px;margin:10px 0;font-size:14px;}
.lt-link{color:var(--spice-button,#1db954);text-decoration:underline;cursor:pointer;word-break:break-all;}
`;

  let buttonRef = null;
  let initAttempts = 0;
  let namesCache = null;
  let settingsCache = null;

  // DOM engine references. Everything here is either connected-checkable or bounded in size.
  let containerRef = null;
  let containerObserver = null;
  let barRef = null;
  let playbarRef = null;
  let placementObserver = null;
  let placementTimer = null;
  let micRef = null;
  let heartbeatTimer = null;
  let wasHidden = false;
  let scanTimer = null;
  let scanFull = false;
  let screenCheckTimer = null;
  let lastScreenCheck = 0;
  let screenPrep = null;
  let pokeTimers = [];
  const pendingNodes = new Set();
  const injected = new Set();
  const normCache = new Map();

  const state = { inline: false, trackId: null, token: 0, loading: false, map: null, words: null, pendingTrackId: null, pendingSince: 0, failedUntil: 0, failedTrackId: null, pendingTimer: null };

  class LtError extends Error {
    constructor(message, code, status) {
      super(message);
      this.name = "LtError";
      this.code = code || "ERROR";
      this.status = status || 0;
    }
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const chunk = (items, size) => {
    const out = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
  };

  function batchByLimits(items, maxLines, maxChars) {
    const batches = [];
    let current = [];
    let size = 0;
    for (const item of items) {
      const cost = item.length + 1;
      if (current.length && (current.length >= maxLines || size + cost > maxChars)) {
        batches.push(current);
        current = [];
        size = 0;
      }
      current.push(item);
      size += cost;
    }
    if (current.length) batches.push(current);
    return batches;
  }

  const toGoogleCode = (code) => {
    const upper = String(code).toUpperCase();
    return GOOGLE_CODE_MAP[upper] || upper.toLowerCase();
  };

  const trackIdFromUri = (uri) => {
    const match = /^spotify:track:([A-Za-z0-9]+)$/.exec(uri || "");
    return match ? match[1] : null;
  };

  const hasLetters = (text) => /\p{L}/u.test(text);

  // Same normalization as before, but plain ASCII text skips every replace() and results are memoized.
  const NORM_SPECIAL = /[\u00a0\u2000-\u200b\u202f\u3000\u2018\u2019\u2032`\u00b4\u201c\u201d]/;
  const NORM_SPACES_G = /[\u00a0\u2000-\u200b\u202f\u3000]/g;
  const NORM_SQUOTES_G = /[\u2018\u2019\u2032`\u00b4]/g;
  const NORM_DQUOTES_G = /[\u201c\u201d]/g;
  const NORM_WS_TEST = /[\n\r\t\v\f]|\s\s/;
  const NORM_WS_G = /\s+/g;

  function norm(s) {
    const str = String(s);
    const hit = normCache.get(str);
    if (hit !== undefined) return hit;
    let out = str;
    if (NORM_SPECIAL.test(out)) {
      out = out.replace(NORM_SPACES_G, " ").replace(NORM_SQUOTES_G, "'").replace(NORM_DQUOTES_G, '"');
    }
    if (NORM_WS_TEST.test(out)) out = out.replace(NORM_WS_G, " ");
    out = out.trim().toLowerCase();
    if (normCache.size >= NORM_CACHE_MAX) normCache.clear();
    normCache.set(str, out);
    return out;
  }

  // Repeated lines (choruses) are sent to the provider once; "back" maps every line to its unique index.
  function dedupeTexts(texts) {
    const uniq = [];
    const index = new Map();
    const back = [];
    for (const t of texts) {
      const k = norm(t);
      let i = index.get(k);
      if (i === undefined) {
        i = uniq.length;
        index.set(k, i);
        uniq.push(t);
      }
      back.push(i);
    }
    return { uniq, back };
  }

  const langName = (code) => {
    if (!code || code === "auto") return "Auto-detect";
    try {
      if (!namesCache) namesCache = new Intl.DisplayNames(["en"], { type: "language" });
      return namesCache.of(String(code).toLowerCase()) || code;
    } catch (e) {
      return code;
    }
  };

  const notify = (message, isError) => {
    try {
      Spicetify.showNotification(message, !!isError);
    } catch (e) {
      console.log("[Lyrics Translate]", message);
    }
  };

  const store = {
    get(key) {
      try {
        return Spicetify.LocalStorage.get(key);
      } catch (e) {
        return null;
      }
    },
    set(key, value) {
      try {
        Spicetify.LocalStorage.set(key, value);
        return true;
      } catch (e) {
        return false;
      }
    },
    remove(key) {
      try {
        Spicetify.LocalStorage.remove(key);
      } catch (e) {
      }
    },
  };

  // Settings are parsed once per session; saveSettings keeps the memory copy in sync.
  function loadSettings() {
    if (!settingsCache) {
      try {
        settingsCache = JSON.parse(store.get(SETTINGS_KEY) || "{}") || {};
      } catch (e) {
        settingsCache = {};
      }
    }
    return Object.assign({}, DEFAULTS, settingsCache);
  }

  function saveSettings(settings) {
    settingsCache = Object.assign({}, settings);
    return store.set(SETTINGS_KEY, JSON.stringify(settings));
  }

  const cacheKey = (trackId, provider, targetLang, sourceLang) =>
    `${PREFIX}cache:${trackId}:${provider}:${targetLang}:${sourceLang}`;

  function readIndex() {
    try {
      const list = JSON.parse(store.get(CACHE_INDEX_KEY) || "[]");
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  }

  function cacheRead(key, lineCount) {
    try {
      const entry = JSON.parse(store.get(key) || "null");
      if (entry && entry.n === lineCount && Array.isArray(entry.t)) return entry;
    } catch (e) {
    }
    return null;
  }

  function cacheWrite(key, lineCount, translated, provider) {
    if (!store.set(key, JSON.stringify({ n: lineCount, t: translated, p: provider }))) return;
    const index = readIndex().filter((k) => k !== key);
    index.push(key);
    while (index.length > CACHE_LIMIT) store.remove(index.shift());
    store.set(CACHE_INDEX_KEY, JSON.stringify(index));
  }

  function cacheClear() {
    const index = readIndex();
    index.forEach((k) => store.remove(k));
    store.remove(CACHE_INDEX_KEY);
    return index.length;
  }

  // Every network call gets a timeout so a hung request cannot leave the extension "loading" forever.
  async function fetchTimed(url, options, ms) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms || FETCH_TIMEOUT_MS);
    try {
      return await fetch(url, Object.assign({}, options, { signal: controller.signal }));
    } finally {
      clearTimeout(timer);
    }
  }

  // Spicetify 2.45.0 routes spclient URLs to Spotify's native resolver when the Spotify client is 1.3.x,
  // which fails with "Resolver not found!" (see PR #1). So the lyrics request is sent with fetch first, using
  // the token and headers Spicetify's own CosmosAsync wrapper injects for spclient URLs
  // (src/jsHelper/spicetifyWrapper/platform.js in spicetify-cli). CosmosAsync remains the fallback.
  function spClientHeaders() {
    try {
      const platform = Spicetify.Platform;
      const token = platform && platform.AuthorizationAPI && platform.AuthorizationAPI.getState().token.accessToken;
      if (!token) return null;
      return {
        Authorization: "Bearer " + token,
        "Spotify-App-Version": platform.version || "",
        "App-Platform": (platform.PlatformData && platform.PlatformData.app_platform) || "",
      };
    } catch (e) {
      return null;
    }
  }

  async function requestLyricsDirect(url) {
    const headers = spClientHeaders();
    if (!headers || typeof fetch !== "function") {
      throw new LtError("Direct lyrics request is not available.", "NO_DIRECT");
    }
    const res = await fetchTimed(url, { headers });
    if (res.status === 429) lyricsRetryAfterMs = (Number(res.headers.get("Retry-After")) || 0) * 1000;
    if (!res.ok) throw new LtError(`Spotify returned HTTP ${res.status}.`, "LYRICS_HTTP", res.status);
    return res.json();
  }

  // CosmosAsync does not throw on HTTP errors. It resolves with { code, error, message } instead
  // (checked in spicetify-cli platform.js), so the status has to be read from the returned body.
  function lyricsErrorStatus(body) {
    return body && !body.lyrics && typeof body.code === "number" && body.code >= 400 ? body.code : 0;
  }

  function lyricsStatusError(status) {
    if (status === 404) return new LtError("No lyrics found for this track.", "NO_LYRICS", 404);
    if (status === 401 || status === 403) {
      return new LtError(
        `Could not fetch lyrics: Spotify denied access (HTTP ${status}). Make sure you are signed in.`,
        "LYRICS_AUTH",
        status
      );
    }
    if (status === 429) {
      return new LtError(
        "Could not fetch lyrics: Spotify is rate limiting requests (HTTP 429). Try again later.",
        "LYRICS_RATE_LIMIT",
        429
      );
    }
    if (status >= 500) {
      return new LtError(
        `Could not fetch lyrics: Spotify server error (HTTP ${status}). Try again later.`,
        "LYRICS_SERVER",
        status
      );
    }
    return new LtError(`Could not fetch lyrics: Spotify returned HTTP ${status}.`, "LYRICS_FETCH", status);
  }

  // Spotify's lyrics server is shared with Spotify's own lyrics view. To keep the extension's share small,
  // results (also "no lyrics") are kept for the last LYRICS_MEMO_MAX tracks, and after an HTTP 429 no
  // lyrics request is sent until the pause is over. The pause is stored, so restarting Spotify keeps it.
  const LYRICS_MEMO_MAX = 30;
  const LYRICS_BLOCK_KEY = PREFIX + "lyricsBlock";
  const LYRICS_FIRST_WAIT_MS = 2 * 60 * 1000;
  const LYRICS_MAX_WAIT_MS = 30 * 60 * 1000;
  const lyricsMemo = new Map();
  let lyricsRetryAfterMs = 0;

  function readLyricsBlock() {
    try {
      const block = JSON.parse(localStorage.getItem(LYRICS_BLOCK_KEY) || "null");
      return block && typeof block.until === "number" && typeof block.wait === "number" ? block : null;
    } catch (e) {
      return null;
    }
  }

  function writeLyricsBlock(block) {
    try {
      if (block) localStorage.setItem(LYRICS_BLOCK_KEY, JSON.stringify(block));
      else localStorage.removeItem(LYRICS_BLOCK_KEY);
    } catch (e) {}
  }

  function rememberLyrics(trackId, entry) {
    lyricsMemo.delete(trackId);
    lyricsMemo.set(trackId, entry);
    while (lyricsMemo.size > LYRICS_MEMO_MAX) lyricsMemo.delete(lyricsMemo.keys().next().value);
  }

  async function fetchLyrics(trackId) {
    const hit = lyricsMemo.get(trackId);
    if (hit) {
      rememberLyrics(trackId, hit);
      if (hit.error) throw hit.error;
      return hit.data;
    }

    const now = Date.now();
    const block = readLyricsBlock();
    if (block && block.until > now) {
      const minutes = Math.max(1, Math.ceil((block.until - now) / 60000));
      throw new LtError(
        `Spotify is rate limiting lyrics requests (HTTP 429). Lyrics requests are paused for about ${minutes} more minute(s).`,
        "LYRICS_RATE_LIMIT",
        429
      );
    }

    lyricsRetryAfterMs = 0;
    try {
      const data = await fetchLyricsOnce(trackId);
      writeLyricsBlock(null);
      rememberLyrics(trackId, { data });
      return data;
    } catch (err) {
      if (err && err.status === 429) {
        // A recent pause doubles; an old one starts again from LYRICS_FIRST_WAIT_MS.
        const recent = block && now - block.until < LYRICS_MAX_WAIT_MS;
        const wait = Math.min(LYRICS_MAX_WAIT_MS, Math.max(lyricsRetryAfterMs, recent ? block.wait * 2 : LYRICS_FIRST_WAIT_MS));
        writeLyricsBlock({ until: now + wait, wait });
      } else if (err && err.code === "NO_LYRICS") {
        rememberLyrics(trackId, { error: err });
      }
      throw err;
    }
  }

  async function fetchLyricsOnce(trackId) {
    const url = `${LYRICS_ENDPOINT}${trackId}?format=json&vocalRemoval=false&market=from_token`;
    let body;
    let directErr = null;
    try {
      body = await requestLyricsDirect(url);
    } catch (err) {
      directErr = err;
    }

    // An HTTP status from the direct request is final: CosmosAsync would send the same request again.
    // Only a statusless failure (no token, blocked fetch) falls back to CosmosAsync.
    if (directErr) {
      if (directErr.status) throw lyricsStatusError(directErr.status);
      try {
        body = await Spicetify.CosmosAsync.get(url, undefined, { "app-platform": "WebPlayer" });
      } catch (err) {
        const cosmosStatus = err && (err.status || err.code);
        if (typeof cosmosStatus === "number" && cosmosStatus >= 400) throw lyricsStatusError(cosmosStatus);
        throw new LtError("Could not fetch lyrics: " + ((err && err.message) || "unknown error"), "LYRICS_FETCH");
      }
    }

    const status = lyricsErrorStatus(body);
    if (status) throw lyricsStatusError(status);

    const lyrics = body && body.lyrics;
    const lines = lyrics && Array.isArray(lyrics.lines) ? lyrics.lines : [];
    if (lines.length === 0) throw new LtError("No lyrics found for this track.", "NO_LYRICS");

    const data = {
      lines: lines.map((line) => (line && typeof line.words === "string" ? line.words.trim() : "")),
      language: typeof lyrics.language === "string" ? lyrics.language : "",
      isRtlLanguage: !!lyrics.isRtlLanguage,
    };
    return data;
  }

  const GTX_BLOCK_KEY = PREFIX + "gtxBlock";
  const GTX_FIRST_WAIT_MS = 2 * 60 * 1000;
  const GTX_MAX_WAIT_MS = 30 * 60 * 1000;

  function gtxBlockState() {
    try {
      const s = JSON.parse(store.get(GTX_BLOCK_KEY) || "null");
      if (s && typeof s.until === "number" && typeof s.step === "number") return s;
    } catch (e) {
    }
    return { until: 0, step: 0 };
  }

  function gtxBlockFail() {
    const step = Math.min(gtxBlockState().step + 1, 10);
    const wait = Math.min(GTX_FIRST_WAIT_MS * 2 ** (step - 1), GTX_MAX_WAIT_MS);
    store.set(GTX_BLOCK_KEY, JSON.stringify({ until: Date.now() + wait, step }));
    return wait;
  }

  function gtxBlockReset() {
    if (gtxBlockState().step) store.set(GTX_BLOCK_KEY, JSON.stringify({ until: 0, step: 0 }));
  }

  const minutesLeft = (ms) => Math.max(1, Math.ceil(ms / 60000));

  async function gtxRequest(text, sl, tl) {
    const block = gtxBlockState();
    if (block.until > Date.now()) {
      throw new LtError(
        `Google is not responding right now (possibly rate limited). About ${minutesLeft(block.until - Date.now())} minute(s) until the next automatic retry.`,
        "RATE_LIMIT"
      );
    }
    try {
      const json = await gtxRequestRaw(text, sl, tl);
      gtxBlockReset();
      return json;
    } catch (err) {
      if (err.code !== "NETWORK" && err.code !== "RATE_LIMIT") throw err;
      const wait = gtxBlockFail();
      const note = err.code === "NETWORK" ? " If requests were sent too often, Google may have blocked them temporarily." : "";
      throw new LtError(`${err.message}${note} ${minutesLeft(wait)} minute(s) until the next automatic retry.`, err.code, err.status);
    }
  }

  async function gtxRequestRaw(text, sl, tl) {
    const url = `${GTX_ENDPOINT}?client=gtx&dt=t&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      let res;
      try {
        res = await fetchTimed(url, { method: "POST", body: new URLSearchParams({ q: text }) });
      } catch (err) {
        throw new LtError("Could not reach Google: " + err.message, "NETWORK");
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt < 2) {
          await sleep(1000 * (attempt + 1));
          continue;
        }
        throw new LtError(`Google is not responding right now (HTTP ${res.status}). Try again later.`, "RATE_LIMIT", res.status);
      }
      if (!res.ok) throw new LtError(`Google error (HTTP ${res.status}).`, "HTTP", res.status);
      const json = await res.json().catch(() => null);
      if (!Array.isArray(json) || !Array.isArray(json[0])) {
        throw new LtError("Google returned an unexpected response.", "BAD_RESPONSE");
      }
      return json;
    }
    throw new LtError("Could not send the request to Google.", "NETWORK");
  }

  const segmentText = (seg) => (Array.isArray(seg) && seg[0] ? String(seg[0]) : "");

  function alignGtx(lines, json) {
    const segs = json[0].filter((seg) => Array.isArray(seg));
    if (segs.length === lines.length && segs.every((seg, i) => String(seg[1] || "").trim() === lines[i])) {
      return segs.map((seg) => segmentText(seg).trim());
    }
    const parts = segs.map(segmentText).join("").split("\n").map((p) => p.trim());
    return parts.length === lines.length ? parts : null;
  }

  async function googleTranslate(texts, s) {
    const tl = toGoogleCode(s.targetLang);
    const sl = s.sourceLang && s.sourceLang !== "auto" ? toGoogleCode(s.sourceLang) : "auto";
    const lines = texts.map((t) => String(t).replace(/\s*\n\s*/g, " ").trim());
    const out = [];

    for (const batch of batchByLimits(lines, GTX_MAX_LINES, GTX_MAX_CHARS)) {
      if (out.length) await sleep(400);
      const json = await gtxRequest(batch.join("\n"), sl, tl);
      let aligned = alignGtx(batch, json);
      if (!aligned) {
        aligned = [];
        for (const line of batch) {
          const one = await gtxRequest(line, sl, tl);
          aligned.push(one[0].map(segmentText).join("").trim());
          await sleep(400);
        }
      }
      out.push(...aligned);
    }
    return out;
  }

  async function deeplTranslate(texts, s) {
    const base = (s.deeplProxy || DEFAULT_PROXY).replace(/\/+$/, "");
    const out = [];

    for (const batch of chunk(texts, BATCH_SIZE)) {
      const payload = { text: batch, target_lang: s.targetLang };
      if (s.sourceLang && s.sourceLang !== "auto") payload.source_lang = s.sourceLang;

      let res;
      try {
        res = await fetchTimed(`${base}/v2/translate`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "DeepL-Auth-Key " + s.deeplKey,
          },
          body: JSON.stringify(payload),
        });
      } catch (err) {
        throw new LtError(`Could not reach the DeepL proxy (${base}). Is the proxy running?`, "NETWORK");
      }

      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const msg = (data && (data.message || data.detail)) || `HTTP ${res.status}`;
        throw new LtError("DeepL error: " + msg, "HTTP", res.status);
      }
      const list = data && data.translations;
      if (!Array.isArray(list) || list.length !== batch.length) {
        throw new LtError("DeepL returned an unexpected response.", "BAD_RESPONSE");
      }
      list.forEach((item) => out.push(item.text || ""));
    }
    return out;
  }

  const msCode = (code) => {
    const upper = String(code).toUpperCase();
    return MS_CODE_MAP[upper] || upper.toLowerCase();
  };

  async function microsoftTranslate(texts, s) {
    const to = msCode(s.targetLang);
    const from = s.sourceLang && s.sourceLang !== "auto" ? msCode(s.sourceLang) : "";
    let url = `${MS_ENDPOINT}?api-version=3.0&to=${encodeURIComponent(to)}`;
    if (from) url += `&from=${encodeURIComponent(from)}`;
    const headers = { "Content-Type": "application/json", "Ocp-Apim-Subscription-Key": String(s.msKey || "").trim() };
    const region = String(s.msRegion || "").trim();
    if (region) headers["Ocp-Apim-Subscription-Region"] = region;

    const lines = texts.map((t) => String(t).replace(/\s*\n\s*/g, " ").trim());
    const out = [];
    for (const batch of batchByLimits(lines, MS_MAX_LINES, MS_MAX_CHARS)) {
      let res;
      try {
        res = await fetchTimed(url, { method: "POST", headers, body: JSON.stringify(batch.map((Text) => ({ Text }))) });
      } catch (err) {
        throw new LtError("Could not reach Microsoft Translator.", "NETWORK");
      }
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const msg = (data && data.error && data.error.message) || `HTTP ${res.status}`;
        throw new LtError("Microsoft error: " + msg, "HTTP", res.status);
      }
      if (!Array.isArray(data) || data.length !== batch.length) {
        throw new LtError("Microsoft returned an unexpected response.", "BAD_RESPONSE");
      }
      data.forEach((item) => {
        const first = item && item.translations && item.translations[0];
        out.push(String((first && first.text) || ""));
      });
    }
    return out;
  }

  const decodeEntities = (str) =>
    String(str)
      .replace(/&#(\d+);/g, (m, n) => (Number(n) <= 0x10ffff ? String.fromCodePoint(Number(n)) : m))
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");

  async function googleCloudTranslate(texts, s) {
    const url = `${GCLOUD_ENDPOINT}?key=${encodeURIComponent(String(s.gcKey || "").trim())}`;
    const base = { target: toGoogleCode(s.targetLang), format: "text" };
    if (s.sourceLang && s.sourceLang !== "auto") base.source = toGoogleCode(s.sourceLang);

    const lines = texts.map((t) => String(t).replace(/\s*\n\s*/g, " ").trim());
    const out = [];
    for (const batch of batchByLimits(lines, GCLOUD_MAX_LINES, GCLOUD_MAX_CHARS)) {
      let res;
      try {
        res = await fetchTimed(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(Object.assign({}, base, { q: batch })),
        });
      } catch (err) {
        throw new LtError("Could not reach Google Cloud Translation.", "NETWORK");
      }
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const msg = (data && data.error && data.error.message) || `HTTP ${res.status}`;
        throw new LtError("Google Cloud error: " + msg, "HTTP", res.status);
      }
      const list = data && data.data && data.data.translations;
      if (!Array.isArray(list) || list.length !== batch.length) {
        throw new LtError("Google Cloud returned an unexpected response.", "BAD_RESPONSE");
      }
      list.forEach((item) => out.push(decodeEntities(item.translatedText || "")));
    }
    return out;
  }

  const LLM_MODELS = ["auto", "gemini", "groq", "gptoss"];
  const llmBase = (s) => String(s.llmUrl || "").trim().replace(/\/+$/, "");

  // Sends all lines in one request to llm-proxy.mjs. The server tries its models in order and answers
  // with exactly one translation per line. Anything else counts as a failure, so translateTexts()
  // falls back to Google.
  async function llmTranslate(texts, s) {
    const base = llmBase(s);
    const lines = texts.map((t) => String(t).replace(/\s+/g, " ").trim());
    const payload = { lines, target: s.targetLang, model: LLM_MODELS.includes(s.llmModel) ? s.llmModel : "auto" };
    if (s.sourceLang && s.sourceLang !== "auto") payload.source = s.sourceLang;
    const headers = { "Content-Type": "application/json" };
    const token = String(s.llmToken || "").trim();
    if (token) headers.Authorization = "Bearer " + token;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
    let res;
    let data;
    try {
      res = await fetch(`${base}/v1/translate`, { method: "POST", headers, body: JSON.stringify(payload), signal: controller.signal });
      data = await res.json().catch(() => null);
    } catch (err) {
      const reason = err && err.name === "AbortError" ? `no answer within ${LLM_TIMEOUT_MS / 1000} s` : "server not reachable";
      throw new LtError(`Could not reach the AI server (${reason}).`, "NETWORK");
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      throw new LtError("AI server error: " + ((data && data.message) || `HTTP ${res.status}`), "HTTP", res.status);
    }
    const list = data && data.lines;
    if (!Array.isArray(list) || list.length !== lines.length || list.some((t) => typeof t !== "string" || !t.trim())) {
      throw new LtError("The AI server returned an unexpected response.", "BAD_RESPONSE");
    }
    return list.map((t) => t.trim());
  }

  // Render's free plan puts the server to sleep after 15 minutes without requests, and waking it takes
  // about a minute. A /health request on song changes keeps it awake while music plays.
  let llmWokeAt = 0;
  function wakeLlm() {
    const s = loadSettings();
    const base = llmBase(s);
    if (s.provider !== "llm" || !base || Date.now() - llmWokeAt < LLM_WAKE_MS) return;
    llmWokeAt = Date.now();
    fetch(`${base}/health`).catch(() => {});
  }

  const PROVIDER_LABELS = {
    deepl: "DeepL",
    microsoft: "Microsoft Translator",
    googleCloud: "Google Cloud Translation",
    llm: "AI translation",
  };
  const PROVIDER_KEY_FIELD = { deepl: "deeplKey", microsoft: "msKey", googleCloud: "gcKey", llm: "llmUrl" };

  function translateWith(provider, texts, s) {
    if (provider === "llm") return llmTranslate(texts, s);
    if (provider === "deepl") return deeplTranslate(texts, s);
    if (provider === "microsoft") return microsoftTranslate(texts, s);
    if (provider === "googleCloud") return googleCloudTranslate(texts, s);
    return googleTranslate(texts, s);
  }

  async function translateTexts(texts, s) {
    const provider = PROVIDER_LABELS[s.provider] ? s.provider : "google";
    if (provider === "google") {
      const items = await googleTranslate(texts, s);
      return { items, provider: "google", notice: "" };
    }
    const label = PROVIDER_LABELS[provider];
    if (!String(s[PROVIDER_KEY_FIELD[provider]] || "").trim()) {
      const items = await googleTranslate(texts, s);
      const missing = provider === "llm" ? "server address" : "key";
      return { items, provider: "google", notice: `${label} ${missing} is not set, so it was translated with Google.` };
    }
    try {
      const items = await translateWith(provider, texts, s);
      return { items, provider, notice: "" };
    } catch (err) {
      const items = await googleTranslate(texts, s);
      return { items, provider: "google", notice: `${label} is unavailable, so it was translated with Google. (${err.message})` };
    }
  }

  // Google fallback results are cached under the key of the selected provider, so the key alone does not say
  // which service produced the text. This is the service a fresh request would use right now: without a key,
  // translateTexts() goes straight to Google.
  function effectiveProvider(s) {
    const provider = PROVIDER_LABELS[s.provider] ? s.provider : "google";
    if (provider === "google") return "google";
    return String(s[PROVIDER_KEY_FIELD[provider]] || "").trim() ? provider : "google";
  }

  // When the lyrics are already in the target language there is nothing to translate.
  // Chinese is excluded: the base code "zh" does not tell Simplified from Traditional.
  function isTargetLanguage(lyricsLang, targetLang) {
    const base = (code) => String(code || "").toLowerCase().split(/[-_]/)[0];
    const from = base(lyricsLang);
    return from.length >= 2 && from === base(targetLang) && from !== "zh";
  }

  async function translateCurrentTrack(s, force) {
    const item = Spicetify.Player && Spicetify.Player.data && Spicetify.Player.data.item;
    if (!item || !item.uri) throw new LtError("No track is playing right now.", "NO_TRACK");

    const trackId = trackIdFromUri(item.uri);
    if (!trackId) throw new LtError("Translation only works for songs.", "NOT_TRACK");

    const { lines, language } = await fetchLyrics(trackId);
    const trackName = item.name || "";

    const key = cacheKey(trackId, s.provider, s.targetLang, s.sourceLang);
    const selected = PROVIDER_LABELS[s.provider] ? s.provider : "google";
    const wanted = effectiveProvider(s);
    let cacheHit = null;
    let fallbackHit = null;
    if (!force) {
      const hit = cacheRead(key, lines.length);
      if (hit) {
        cacheHit = hit;
        const cachedBy = hit.p || "";
        // The selected provider's result stays valid even when its key was removed later: replacing it
        // with the Google fallback would lose a better translation.
        if (!cachedBy || cachedBy === wanted || cachedBy === selected) {
          return { trackName, lines, translated: hit.t, provider: cachedBy, notice: "", cached: true };
        }
        // Cached by a fallback (Google, while the preferred provider was unavailable). Retry the preferred one below.
        fallbackHit = hit;
      }
    }

    if (!cacheHit && isTargetLanguage(language, s.targetLang) && !force) {
      // The notice is only shown for manual runs (loadTrack handles that), so automatic checks stay quiet.
      return {
        trackName,
        lines,
        translated: lines.map(() => ""),
        provider: "",
        notice: `The lyrics are already in ${langName(s.targetLang)}.`,
        cached: false,
      };
    }

    const indexes = [];
    lines.forEach((text, i) => {
      if (hasLetters(text)) indexes.push(i);
    });
    const texts = indexes.map((i) => lines[i]);
    const translated = lines.map(() => "");
    // Choruses repeat: translate each unique line once, then fan the result back out.
    const { uniq, back } = dedupeTexts(texts);
    const put = (items) => {
      back.forEach((u, k) => {
        translated[indexes[k]] = items[u];
      });
    };

    let provider = "";
    let notice = "";
    if (texts.length > 0 && fallbackHit && wanted !== "google") {
      try {
        put(await translateWith(wanted, uniq, s));
        provider = wanted;
      } catch (err) {
        // The preferred provider still fails: keep the saved fallback instead of calling Google again.
        return {
          trackName,
          lines,
          translated: fallbackHit.t,
          provider: fallbackHit.p,
          notice: `${PROVIDER_LABELS[wanted]} is unavailable, so the saved Google translation is shown.`,
          cached: true,
        };
      }
    } else if (texts.length > 0) {
      const result = await translateTexts(uniq, s);
      put(result.items);
      provider = result.provider;
      notice = result.notice;
    }

    cacheWrite(key, lines.length, translated, provider);
    return { trackName, lines, translated, provider, notice, cached: false };
  }

  const SKIP_TAGS = { A: 1, BUTTON: 1, H1: 1, H2: 1, H3: 1, H4: 1, NAV: 1, HEADER: 1, FOOTER: 1, SELECT: 1, OPTION: 1, INPUT: 1, TEXTAREA: 1, SCRIPT: 1, STYLE: 1 };

  function skipNode(el, bar) {
    if (bar && bar.contains(el)) return true;
    for (let a = el, d = 0; a && a.nodeType === 1 && d < 3; a = a.parentNode, d++) {
      if (SKIP_TAGS[a.tagName]) return true;
    }
    return false;
  }

  function nowPlayingBar() {
    if (barRef && barRef.isConnected) return barRef;
    barRef = document.querySelector('[data-testid="now-playing-bar"]');
    return barRef;
  }

  function lyricsRoute() {
    try {
      const loc = Spicetify.Platform.History.location;
      return !!loc && /^\/lyrics/.test(String(loc.pathname || ""));
    } catch (e) {
      return false;
    }
  }

  function findLyricsContainer() {
    const el = document.querySelector(CONTAINER_SELECTOR);
    if (el) return el;
    if (lyricsRoute()) return document.querySelector(".Root__main-view");
    return null;
  }

  // The observer only ever watches the lyrics container. No container (view closed) => no observer,
  // no scans, no lyrics requests. The playbar's constant updates never reach this code.
  function attachContainerObserver() {
    if (typeof MutationObserver === "undefined" || !containerRef) return;
    if (!containerObserver) containerObserver = new MutationObserver(onContainerMutations);
    containerObserver.disconnect();
    if (document.hidden) return;
    containerObserver.observe(containerRef, { childList: true, subtree: true, characterData: true });
  }

  function detachContainerObserver() {
    if (containerObserver) containerObserver.disconnect();
  }

  function ensureContainer(force) {
    const valid = containerRef && containerRef.isConnected;
    if (valid && !force) return containerRef;
    const found = valid ? containerRef : findLyricsContainer();
    const changed = found !== containerRef;
    containerRef = found;
    if (found) {
      attachContainerObserver();
      if (changed || force) {
        if (state.map) requestScan(true);
        scheduleScreenCheck();
      }
    } else {
      detachContainerObserver();
    }
    return found;
  }

  function onContainerMutations(mutations) {
    if (document.hidden || !state.inline) return;
    if (!state.map) {
      // Lyrics may just have rendered: re-check (throttled) whether translation can start.
      scheduleScreenCheck();
      return;
    }
    for (const m of mutations) {
      if (m.type === "characterData") pendingNodes.add(m.target);
      else for (const n of m.addedNodes) pendingNodes.add(n);
    }
    if (pendingNodes.size) requestScan(false);
  }

  // Mutations are coalesced: one scan per SCAN_BATCH_MS at most, over the changed nodes only.
  function requestScan(full) {
    if (full) {
      pendingNodes.clear();
      scanFull = true;
    }
    if (scanTimer) return;
    scanTimer = setTimeout(flushScan, SCAN_BATCH_MS);
  }

  function flushScan() {
    scanTimer = null;
    const full = scanFull;
    scanFull = false;
    if (!state.inline || !state.map || document.hidden) {
      pendingNodes.clear();
      return;
    }
    const scope = containerRef && containerRef.isConnected ? containerRef : null;
    if (full || !scope || pendingNodes.size > SCAN_NODE_BURST) {
      pendingNodes.clear();
      // Inside the lyrics container the playbar can never appear, so the bar filter is unnecessary.
      scanSubtree(scope || document.body, scope ? null : nowPlayingBar());
      return;
    }
    const nodes = Array.from(pendingNodes);
    pendingNodes.clear();
    for (const n of nodes) {
      if (!n.isConnected) continue;
      if (n.nodeType === 3) processText(n, null);
      else if (n.nodeType === 1) scanSubtree(n, null);
    }
  }

  function scheduleScreenCheck() {
    if (!state.inline || state.map || state.loading || screenCheckTimer) return;
    const wait = Math.max(0, SCREEN_CHECK_MS - (Date.now() - lastScreenCheck));
    screenCheckTimer = setTimeout(() => {
      screenCheckTimer = null;
      lastScreenCheck = Date.now();
      if (state.inline && !state.map && !state.loading && !document.hidden) loadTrack(false);
    }, wait);
  }

  // The key/word sets are built once per lyrics array (memoized per track), not on every check.
  function screenPrepFor(lines) {
    if (screenPrep && screenPrep.lines === lines) return screenPrep;
    const keys = new Set();
    const words = new Set();
    lines.forEach((line) => {
      if (!hasLetters(line)) return;
      const key = norm(line);
      keys.add(key);
      key.split(" ").forEach((w) => {
        if (w.length >= 2) words.add(w);
      });
    });
    screenPrep = { lines, keys, words };
    return screenPrep;
  }

  // True when at least one lyric line is rendered. Scoped to the lyrics container when available.
  function lyricsOnScreen(lines) {
    const prep = screenPrepFor(lines);
    if (prep.keys.size === 0) return false;
    const scope = containerRef && containerRef.isConnected ? containerRef : document.body;
    const bar = scope === document.body ? nowPlayingBar() : null;
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const raw = node.nodeValue;
      const parent = node.parentNode;
      if (!raw || raw.length > MAX_TEXT_LEN || !parent || parent.nodeType !== 1) continue;
      const key = norm(raw);
      if (key.length < 2) continue;
      if (prep.keys.has(key)) {
        if (!skipNode(parent, bar)) return true;
        continue;
      }
      if (!prep.words.has(key)) continue;
      for (let el = parent, d = 0; el && el.nodeType === 1 && d < 6; el = el.parentNode, d++) {
        const text = el.textContent || "";
        if (text.length > MAX_ANCESTOR_LEN) continue;
        if (!prep.keys.has(norm(text))) continue;
        // Same as processText(): the first matching ancestor decides, even when it is filtered out.
        if (!skipNode(el, bar)) return true;
        break;
      }
    }
    return false;
  }

  function buildMaps(lines, translated) {
    const map = new Map();
    const words = new Set();
    lines.forEach((line, i) => {
      const t = translated[i];
      if (!t || !hasLetters(line)) return;
      // A "translation" identical to the original (names, "OK", loanwords) adds nothing and would repeat the line.
      if (norm(t) === norm(line)) return;
      const key = norm(line);
      if (!map.has(key)) map.set(key, t);
      key.split(" ").forEach((w) => {
        if (w.length >= 2) words.add(w);
      });
    });
    return { map, words };
  }

  function applyTo(el, key) {
    const text = state.map.get(key);
    if (!text) return;
    if (el.getAttribute(INLINE_ATTR) !== text) el.setAttribute(INLINE_ATTR, text);
    injected.add(el);
  }

  function processText(node, bar) {
    const parent = node.parentNode;
    const raw = node.nodeValue;
    if (!parent || parent.nodeType !== 1 || !raw || raw.length > MAX_TEXT_LEN) return;
    const key = norm(raw);
    if (key.length < 2) return;
    if (state.map.has(key)) {
      if (!skipNode(parent, bar)) applyTo(parent, key);
      return;
    }
    if (!state.words.has(key)) return;
    for (let el = parent, d = 0; el && el.nodeType === 1 && d < 6; el = el.parentNode, d++) {
      const text = el.textContent || "";
      if (text.length > MAX_ANCESTOR_LEN) continue;
      const full = norm(text);
      if (state.map.has(full)) {
        if (!skipNode(el, bar)) applyTo(el, full);
        return;
      }
    }
  }

  function scanSubtree(root, bar) {
    if (root.nodeType === 3) return processText(root, bar);
    if (root.nodeType !== 1) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) processText(node, bar);
  }

  // Cleanup is O(injected elements); no document-wide attribute query is needed anymore.
  function removeInjected() {
    if (!injected.size) return;
    injected.forEach((el) => {
      if (el.isConnected) el.removeAttribute(INLINE_ATTR);
    });
    injected.clear();
  }

  function injectNow() {
    if (!state.inline || !state.map) {
      removeInjected();
      return;
    }
    const scope = containerRef && containerRef.isConnected ? containerRef : null;
    scanSubtree(scope || document.body, scope ? null : nowPlayingBar());
  }

  async function loadTrack(manual, force) {
    const item = Spicetify.Player && Spicetify.Player.data && Spicetify.Player.data.item;
    const trackId = item ? trackIdFromUri(item.uri) : null;
    if (!trackId) {
      state.trackId = null;
      state.pendingTrackId = null;
      state.pendingSince = 0;
      state.map = null;
      state.words = null;
      state.token++;
      state.loading = false;
      removeInjected();
      return;
    }
    // Wakes the AI server early: Render's free plan puts it to sleep after 15 minutes without requests.
    if (manual || state.pendingTrackId !== trackId) wakeLlm();
    if (!force && state.trackId === trackId && (state.loading || state.map)) return;
    if (!manual && state.failedTrackId === trackId && state.failedUntil > Date.now()) return;

    if (!manual && !force) {
      if (state.pendingTrackId !== trackId) {
        // First sighting of a new track: drop the previous translation at once, then let the new
        // lyrics settle before loading. Events and the heartbeat therefore share the same wait.
        clearTimeout(state.pendingTimer);
        state.pendingTimer = setTimeout(() => {
          if (state.inline && !document.hidden) loadTrack(false);
        }, SONG_CHANGE_DEBOUNCE_MS + 50);
        state.pendingTrackId = trackId;
        state.pendingSince = Date.now();
        state.map = null;
        state.words = null;
        state.token++;
        state.loading = false;
        screenPrep = null;
        normCache.clear();
        removeInjected();
      }
      if (Date.now() - state.pendingSince < SONG_CHANGE_DEBOUNCE_MS) return;
      // Lyrics view closed: nothing can be rendered, so no lyrics request is sent either.
      if (!ensureContainer(false)) return;
    }

    state.pendingTrackId = trackId;
    state.trackId = trackId;
    state.map = null;
    state.words = null;
    state.loading = true;
    const token = ++state.token;
    removeInjected();

    try {
      // Automatic checks only fetch the lyrics (no translation quota) and wait until the lines are on the page.
      // Manual runs and re-translations go straight to the translation provider.
      if (!manual) {
        const { lines } = await fetchLyrics(trackId);
        if (token !== state.token) return;
        if (!lyricsOnScreen(lines)) return;
      }
      const r = await translateCurrentTrack(loadSettings(), !!force);
      if (token !== state.token) return;
      state.failedUntil = 0;
      const maps = buildMaps(r.lines, r.translated);
      state.map = maps.map;
      state.words = maps.words;
      if (manual && r.notice) notify(r.notice);
    } catch (err) {
      if (token !== state.token) return;
      // A failed re-translation does not start the back-off, so the next automatic check can
      // bring the saved translation back from the cache.
      if (!force) {
        state.failedUntil = Date.now() + 5 * 60 * 1000;
        state.failedTrackId = trackId;
      }
      if (manual) notify(err.message || "Translation failed.", true);
    } finally {
      if (token === state.token) {
        state.loading = false;
        if (state.map) requestScan(true);
      }
    }
  }

  // One adaptive safety-net timer. Idle ticks only check element references (isConnected, track id);
  // they never walk the DOM. Real work is triggered by songchange, History, and the scoped observer.
  function heartbeatDelay() {
    if (!(containerRef && containerRef.isConnected)) return HEARTBEAT_NO_VIEW_MS;
    if (state.failedUntil > Date.now() || !state.pendingTrackId) return HEARTBEAT_IDLE_MS;
    if (state.loading || !state.map) return HEARTBEAT_ACTIVE_MS;
    return HEARTBEAT_IDLE_MS;
  }

  function scheduleHeartbeat() {
    if (heartbeatTimer || !state.inline) return;
    heartbeatTimer = setTimeout(heartbeat, document.hidden ? HEARTBEAT_HIDDEN_MS : heartbeatDelay());
  }

  function heartbeat() {
    heartbeatTimer = null;
    if (!state.inline) return;
    if (document.hidden) {
      // Hidden window: keep only a 20s no-op pulse so the extension can self-heal on wake.
      wasHidden = true;
      heartbeatTimer = setTimeout(heartbeat, HEARTBEAT_HIDDEN_MS);
      return;
    }
    const woke = wasHidden;
    wasHidden = false;
    ensureContainer(woke);
    ensurePlacementObserver();
    loadTrack(false);
    scheduleHeartbeat();
  }

  function stopHeartbeat() {
    clearTimeout(heartbeatTimer);
    heartbeatTimer = null;
  }

  function stopScan() {
    clearTimeout(scanTimer);
    scanTimer = null;
    scanFull = false;
    pendingNodes.clear();
  }

  // Route changes render asynchronously; check now and shortly after. Bounded, cheap pokes.
  function pokeSoon() {
    pokeTimers.forEach(clearTimeout);
    pokeTimers = [];
    [0, 300, 900].forEach((d) => {
      pokeTimers.push(setTimeout(() => {
        if (!state.inline || document.hidden) return;
        ensureContainer(false);
        loadTrack(false);
      }, d));
    });
  }

  function setInline(on, manual) {
    state.inline = !!on;
    const s = loadSettings();
    s.inline = state.inline;
    saveSettings(s);
    if (buttonRef) buttonRef.active = state.inline;

    if (state.inline) {
      ensureContainer(true);
      loadTrack(manual !== false);
      scheduleHeartbeat();
    } else {
      stopHeartbeat();
      stopScan();
      clearTimeout(state.pendingTimer);
      clearTimeout(screenCheckTimer);
      screenCheckTimer = null;
      detachContainerObserver();
      containerRef = null;
      state.trackId = null;
      state.pendingTrackId = null;
      state.pendingSince = 0;
      state.map = null;
      state.words = null;
      state.token++;
      state.loading = false;
      removeInjected();
    }
  }

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  };

  const link = (text, url) => {
    const a = el("a", "lt-link", text);
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    return a;
  };

  const select = (options, value) => {
    const node = el("select");
    options.forEach(([val, label]) => {
      const opt = el("option", null, label);
      opt.value = val;
      node.appendChild(opt);
    });
    node.value = value;
    return node;
  };

  const textInput = (type, value, placeholder) => {
    const node = el("input");
    node.type = type;
    node.value = value || "";
    node.placeholder = placeholder || "";
    node.spellcheck = false;
    return node;
  };

  const field = (label, control, hint) => {
    const wrap = el("label", "lt-field");
    wrap.appendChild(el("span", null, label));
    wrap.appendChild(control);
    if (hint) wrap.appendChild(hint);
    return wrap;
  };

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = el("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  function showModal({ title, body, buttons = [] }) {
    injectStyle();

    const overlay = el("div", "lt-overlay");
    const modal = el("div", "lt-modal");
    const header = el("div", "lt-header");
    const closeBtn = el("button", "lt-btn lt-ghost", "✕");
    header.append(el("h2", null, title), closeBtn);

    const content = el("div", "lt-body");
    if (body) content.appendChild(body);

    const footer = el("div", "lt-footer");
    modal.append(header, content, footer);
    overlay.appendChild(modal);

    const onKey = (e) => {
      if (e.key === "Escape") close();
    };
    function close() {
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
    }

    closeBtn.addEventListener("click", close);
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) close();
    });
    document.addEventListener("keydown", onKey, true);

    buttons.forEach((b) => {
      const btn = el("button", "lt-btn" + (b.ghost ? " lt-ghost" : ""), b.label);
      btn.addEventListener("click", () => b.onClick(close));
      footer.appendChild(btn);
    });

    document.body.appendChild(overlay);
    return { close, body: content };
  }

  function showDeeplGuide() {
    const body = el("div");
    body.appendChild(
      el(
        "p",
        "lt-note",
        "The DeepL API cannot be called directly from a browser (CORS policy), so DeepL needs a small local proxy running on your computer. If the proxy is off or no key is set, the translation is done with Google."
      )
    );

    const steps = el("ol", "lt-note");
    const addStep = (text, url) => {
      const item = el("li");
      item.append(text);
      if (url) item.append(" ", link(url, url));
      steps.appendChild(item);
    };
    addStep("Sign up for a DeepL API plan (the free plan is enough):", LINKS.deeplSignup);
    addStep("Sign in to DeepL and copy your key from the “API Keys” tab:", LINKS.deeplKeys);
    addStep("Paste the key into the “DeepL API key” field in the settings. A key ending in “:fx” is a free-plan key; the extension picks the correct server automatically.");
    addStep("Install Node.js 18 or newer (or download it from nodejs.org). Then run “node deepl-proxy.mjs” in the folder that contains deepl-proxy.mjs and keep the window open.", LINKS.nodejs);
    body.appendChild(steps);

    body.appendChild(el("div", "lt-warn", "If the proxy is not running or no DeepL key is set, the translation is done with Google automatically. Google does not need a key."));

    showModal({
      title: "How do I get a DeepL API key?",
      body,
      buttons: [
        { label: "Open DeepL", ghost: true, onClick: () => window.open(LINKS.deeplSignup, "_blank") },
        { label: "OK", onClick: (close) => close() },
      ],
    });
  }

  function maybeShowDeeplGuide() {
    const s = loadSettings();
    if (s.deeplKey || s.deeplGuideShown) return;
    saveSettings(Object.assign(s, { deeplGuideShown: true }));
    showDeeplGuide();
  }

  function openSettings() {
    const s = loadSettings();

    const providerSel = select(
      [
        ["google", "Google Translate (default, no key required)"],
        ["deepl", "DeepL (API key and local proxy required)"],
        ["microsoft", "Microsoft Translator (API key and region required)"],
        ["googleCloud", "Google Cloud Translation (API key and billing required)"],
        ["llm", "AI translation (own server: Gemini, Qwen, GPT-OSS)"],
      ],
      s.provider
    );
    providerSel.addEventListener("change", () => {
      if (providerSel.value === "deepl") maybeShowDeeplGuide();
    });

    const deeplInput = textInput("password", s.deeplKey, "DeepL API key");
    const deeplHint = el("div", "lt-note");
    const guideLink = el("a", "lt-link", "How to set up the DeepL key and proxy?");
    guideLink.addEventListener("click", (e) => {
      e.preventDefault();
      showDeeplGuide();
    });
    deeplHint.appendChild(guideLink);

    const proxyInput = textInput("text", s.deeplProxy, DEFAULT_PROXY);
    const msKeyInput = textInput("password", s.msKey, "Microsoft API key");
    const msRegionInput = textInput("text", s.msRegion, "e.g. westeurope");
    const gcKeyInput = textInput("password", s.gcKey, "Google Cloud API key");
    const llmUrlInput = textInput("text", s.llmUrl, "https://your-service.onrender.com");
    const llmTokenInput = textInput("password", s.llmToken, "Access token");
    const llmModelSel = select(
      [
        ["auto", "Auto (server order)"],
        ["gemini", "Gemini (Google)"],
        ["groq", "Qwen (Groq)"],
        ["gptoss", "GPT-OSS (Groq)"],
      ],
      s.llmModel
    );
    const targetSel = select(
      DEEPL_TARGET.map((code) => [code, langName(code)]),
      s.targetLang
    );
    const sourceSel = select(
      [["auto", "Auto-detect"]].concat(DEEPL_SOURCE.map((code) => [code, langName(code)])),
      s.sourceLang
    );

    const inlineChk = el("input");
    inlineChk.type = "checkbox";
    inlineChk.checked = !!s.inline;
    const inlineRow = el("label", "lt-row");
    inlineRow.append(inlineChk, el("span", null, "Show the translation below the lyrics"));

    const body = el("div");
    body.append(
      field("Translation provider (which service translates)", providerSel),
      field("DeepL API key", deeplInput, deeplHint),
      field("DeepL proxy address", proxyInput, el("div", "lt-note", "Start the proxy with 'node deepl-proxy.mjs'. The default address normally does not need to change.")),
      field("Microsoft API key", msKeyInput, el("div", "lt-note", "Create a Translator resource in Azure and copy its key.")),
      field("Microsoft region", msRegionInput, el("div", "lt-note", "The region of your resource (e.g. westeurope). Fill this in if Azure returns an error.")),
      field("Google Cloud API key", gcKeyInput, el("div", "lt-note", "Create a key in a project where you enabled the Cloud Translation API. The free quota is 500,000 characters per month; billing must be enabled on the project.")),
      field("AI server address", llmUrlInput, el("div", "lt-note", "Address of your llm-proxy server, e.g. https://your-service.onrender.com. Leave it empty to use Google.")),
      field("AI access token", llmTokenInput, el("div", "lt-note", "The ACCESS_TOKEN value set on the server.")),
      field("AI model", llmModelSel, el("div", "lt-note", "Auto tries the server's models in order. Saved translations stay when you change the model; use “Re-translate this song” to refresh one.")),
      field("Target language (lyrics are translated into this language)", targetSel),
      field("Source language (auto-detect is recommended)", sourceSel),
      inlineRow
    );

    showModal({
      title: "Lyrics Translate · Settings",
      body,
      buttons: [
        {
          label: "Clear cache",
          ghost: true,
          onClick: () => notify(`${cacheClear()} translation(s) removed from the cache.`),
        },
        {
          label: "Re-translate this song",
          ghost: true,
          onClick: (close) => {
            close();
            if (!state.inline) {
              notify("Turn on the translation (globe button) first.", true);
              return;
            }
            loadTrack(true, true);
          },
        },
        { label: "Cancel", ghost: true, onClick: (close) => close() },
        {
          label: "Save",
          onClick: (close) => {
            const next = Object.assign(loadSettings(), {
              provider: PROVIDER_LABELS[providerSel.value] ? providerSel.value : "google",
              deeplKey: deeplInput.value.trim(),
              msKey: msKeyInput.value.trim(),
              msRegion: msRegionInput.value.trim(),
              gcKey: gcKeyInput.value.trim(),
              llmUrl: llmUrlInput.value.trim().replace(/\/+$/, ""),
              llmToken: llmTokenInput.value.trim(),
              llmModel: llmModelSel.value,
              deeplProxy: (proxyInput.value.trim() || DEFAULT_PROXY).replace(/\/+$/, ""),
              targetLang: targetSel.value,
              sourceLang: sourceSel.value,
              inline: !!inlineChk.checked,
            });
            saveSettings(next);
            state.trackId = null;
            state.map = null;
            state.words = null;
            close();
            notify("Settings saved.");
            const keyField = PROVIDER_KEY_FIELD[next.provider];
            if (keyField && !String(next[keyField] || "").trim()) {
              const missing = next.provider === "llm" ? "server address" : "key";
              notify(`${PROVIDER_LABELS[next.provider]} ${missing} is missing; translations will be done with Google.`, true);
            }

            setInline(next.inline);
          },
        },
      ],
    });
  }

  function findLyricsButton() {
    const ours = buttonRef && buttonRef.element;
    const scope = (ours && ours.parentNode) || nowPlayingBar();
    if (!scope) return null;

    const exact = scope.querySelector('button[data-testid*="lyric" i]');
    if (exact && exact !== ours) return exact;

    const buttons = scope.querySelectorAll("button");
    for (let i = 0; i < buttons.length; i++) {
      const b = buttons[i];
      if (b === ours) continue;
      const label = `${b.getAttribute("aria-label") || ""} ${b.getAttribute("title") || ""}`.toLowerCase();
      if (/lyric|söz/.test(label)) return b;
    }
    return null;
  }

  function placeNextToLyrics() {
    if (!buttonRef || !buttonRef.element) return;
    const ours = buttonRef.element;
    // Fast path: already in the right spot -> a few property reads, no queries.
    if (ours.isConnected && micRef && micRef.isConnected && micRef.nextElementSibling === ours) return;
    const mic = findLyricsButton();
    if (!mic || !mic.parentNode) return;
    micRef = mic;
    if (mic.nextElementSibling === ours) return;
    mic.parentNode.insertBefore(ours, mic.nextSibling);
  }

  // childList-only observer on the playbar: progress/time updates (characterData, attributes) never
  // fire it. Replaces the old unconditional 2-second interval.
  function ensurePlacementObserver() {
    if (placementObserver && playbarRef && playbarRef.isConnected) return;
    const bar = nowPlayingBar();
    if (!bar) return;
    playbarRef = bar;
    if (!placementObserver && typeof MutationObserver !== "undefined") {
      placementObserver = new MutationObserver(() => {
        if (placementTimer) return;
        placementTimer = setTimeout(() => {
          placementTimer = null;
          placeNextToLyrics();
        }, PLACEMENT_DEBOUNCE_MS);
      });
    }
    if (placementObserver) {
      placementObserver.disconnect();
      placementObserver.observe(bar, { childList: true, subtree: true });
    }
    placeNextToLyrics();
  }

  // Ultra-cheap always-on safety tick for button placement only (works even when translation is off).
  function placementTick() {
    if (!document.hidden) {
      ensurePlacementObserver();
      placeNextToLyrics();
    }
    setTimeout(placementTick, PLACEMENT_SAFETY_MS);
  }

  function init() {
    const ready =
      typeof Spicetify !== "undefined" &&
      Spicetify.Player &&
      Spicetify.Playbar &&
      Spicetify.CosmosAsync &&
      Spicetify.LocalStorage &&
      Spicetify.showNotification;

    if (!ready) {
      if (++initAttempts < INIT_RETRY_LIMIT) setTimeout(init, 300);
      return;
    }
    if (buttonRef) return;

    injectStyle();
    // One-time sweep for attributes left behind by an older version (hot reload).
    document.querySelectorAll("[" + INLINE_ATTR + "]").forEach((n) => n.removeAttribute(INLINE_ATTR));
    state.inline = !!loadSettings().inline;
    buttonRef = new Spicetify.Playbar.Button(
      "Lyrics translation (left-click: on/off · right-click: settings)",
      ICON,
      () => {
        setInline(!state.inline);
        notify(state.inline ? "Translation is shown below the lyrics." : "The translation below the lyrics has been turned off.");
      },
      false,
      state.inline,
      false
    );
    buttonRef.register();
    buttonRef.element.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openSettings();
    });

    if (typeof Spicetify.Player.addEventListener === "function") {
      Spicetify.Player.addEventListener("songchange", () => {
        // loadTrack records the first sighting of the new track and applies the settle delay itself,
        // so repeated songchange events cannot reset or skip it.
        if (state.inline && !document.hidden) loadTrack(false);
      });
    }

    // Navigation events replace most of the old polling: opening/closing the lyrics page is detected
    // immediately instead of waiting for the next poll tick.
    try {
      const history = Spicetify.Platform && Spicetify.Platform.History;
      if (history && typeof history.listen === "function") {
        history.listen(() => {
          if (state.inline && !document.hidden) pokeSoon();
        });
      }
    } catch (e) {}

    // Hidden window (minimized/other virtual desktop): stop the observer and all timers.
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        detachContainerObserver();
        stopScan();
      } else {
        if (state.inline) {
          ensureContainer(true);
          loadTrack(false);
          scheduleHeartbeat();
        }
        placeNextToLyrics();
      }
    });

    setTimeout(placementTick, PLACEMENT_SAFETY_MS);
    ensurePlacementObserver();
    if (state.inline) {
      ensureContainer(true);
      loadTrack(false);
      scheduleHeartbeat();
    }
  }

  init();

  return {
    init,
    setInline,
    loadTrack,
    injectNow,
    buildMaps,
    norm,
    state,
    loadSettings,
    saveSettings,
    translateTexts,
    googleTranslate,
    deeplTranslate,
    microsoftTranslate,
    googleCloudTranslate,
    llmTranslate,
    msCode,
    decodeEntities,
    PROVIDER_LABELS,
    translateCurrentTrack,
    cacheClear,
    toGoogleCode,
    chunk,
    batchByLimits,
    alignGtx,
    trackIdFromUri,
    cacheKey,
    lyricsOnScreen,
    isTargetLanguage,
    effectiveProvider,
    dedupeTexts,
    DEEPL_SOURCE,
    DEEPL_TARGET,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = LyricsTranslate;
}
