// LLM translation server for the Lyrics Translate extension. No dependencies; needs Node.js 18 or newer.
//
//   Local:   node llm-proxy.mjs      -> http://127.0.0.1:8788
//   Render:  start command "node llm-proxy.mjs" (Render sets PORT, so the server listens on 0.0.0.0)
//
// Environment variables:
//   GEMINI_API_KEY   Google AI Studio key. Turns on the "gemini" and "gemma" models.
//   GROQ_API_KEY     Groq key. Turns on the "groq" and "gptoss" models.
//   ACCESS_TOKEN     Optional. When set, requests must send "Authorization: Bearer <token>".
//   MODEL_ORDER      Models to use, in the order they are tried. Default: gemini,groq,gptoss
//                    "gemma" is only used when it is listed here.
//   GEMINI_MODEL, GEMMA_MODEL, GROQ_MODEL, GPTOSS_MODEL               Model IDs.
//   GEMINI_THINKING, GEMMA_THINKING, GROQ_THINKING, GPTOSS_THINKING   Thinking level sent to the model.
//   ALLOWED_ORIGIN   CORS origin. Default: *
//   IP_MAX_REQUESTS  Requests allowed per address in 10 minutes. Default: 40
//   GROQ_MAX_TOKENS  Upper limit for the answer length of the Groq models. Default: 4096

import http from "node:http";

const env = (name, fallback) => (process.env[name] || "").trim() || fallback;
const tokenCount = (value) => (typeof value === "number" ? value : null);

const PORT = Number(process.env.PORT) || 8788;
const HOST = env("HOST", process.env.PORT ? "0.0.0.0" : "127.0.0.1");
const ACCESS_TOKEN = env("ACCESS_TOKEN", "");
const ALLOWED_ORIGIN = env("ALLOWED_ORIGIN", "*");

const MAX_BODY_BYTES = 256 * 1024;
const MAX_LINES = 400;
const MAX_LINE_CHARS = 500;
const MAX_TOTAL_CHARS = 20000;
// A request takes TOTAL_TIMEOUT_MS at most. One model gets MODEL_TIMEOUT_MS at most, and
// MODEL_RESERVE_MS stays free for every model that is still waiting for its turn, so a slow
// model cannot use up the time of the models after it.
const TOTAL_TIMEOUT_MS = 40000;
const MODEL_TIMEOUT_MS = 20000;
const MODEL_RESERVE_MS = 8000;
const MIN_TRY_MS = 3000;
const RATE_LIMIT_PAUSE_MS = 60 * 1000;
const IP_WINDOW_MS = 10 * 60 * 1000;
const IP_MAX_REQUESTS = Number(env("IP_MAX_REQUESTS", "40")) || 40;
const GROQ_MAX_TOKENS = Number(env("GROQ_MAX_TOKENS", "4096")) || 4096;
const GROQ_THINKING_TOKENS = 1024;

const GOOGLE_URL = "https://generativelanguage.googleapis.com/v1beta/models/";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

// Model IDs, thinking levels and sampling settings were checked on the providers' pages on 2026-11-13.
// They change often: set the environment variables instead of editing this file.
//   gemini   "minimal" is the model's own default and its fastest level; "low", "medium" and "high" think more.
//   gemma    "minimal" turns thinking off, "high" turns it on.
//   groq     "none" turns thinking off; "low", "medium" and "high" turn it on.
//   gptoss   "low", "medium" or "high". This model always thinks.
// No temperature is sent to Google: Gemini 3.5 Flash-Lite ignores it and later models will reject it.
const MODELS = {
  gemini: { api: "google", key: env("GEMINI_API_KEY", ""), model: env("GEMINI_MODEL", "gemini-3.5-flash-lite"), thinking: env("GEMINI_THINKING", "minimal").toLowerCase() },
  gemma: { api: "google", key: env("GEMINI_API_KEY", ""), model: env("GEMMA_MODEL", "gemma-4-31b-it"), thinking: env("GEMMA_THINKING", "minimal").toLowerCase() },
  groq: { api: "groq", key: env("GROQ_API_KEY", ""), model: env("GROQ_MODEL", "qwen/qwen3.8-27b"), thinking: env("GROQ_THINKING", "none").toLowerCase(), temperature: 0.5, topP: 0.8 },
  gptoss: { api: "groq", key: env("GROQ_API_KEY", ""), model: env("GPTOSS_MODEL", "openai/gpt-oss-120b"), thinking: env("GPTOSS_THINKING", "low").toLowerCase(), temperature: 0.5 },
};
const ORDER = env("MODEL_ORDER", "gemini,groq,gptoss")
  .split(",")
  .map((name) => name.trim().toLowerCase())
  .filter((name, i, all) => MODELS[name] && MODELS[name].key && all.indexOf(name) === i);

const LANG_CODE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;
const languageNames = new Intl.DisplayNames(["en"], { type: "language" });
const hits = new Map();

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  res.setHeader("Access-Control-Max-Age", "600");
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on("end", () => {
      if (size > MAX_BODY_BYTES) reject(httpError(413, "Request body is too large."));
      else resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

// Requests per address in a 10-minute window. Behind a reverse proxy the caller's address is
// expected in X-Forwarded-For.
function allowIp(req) {
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  if (hits.size > 5000) hits.clear();
  const entry = hits.get(ip);
  if (!entry || entry.resetAt <= now) {
    hits.set(ip, { count: 1, resetAt: now + IP_WINDOW_MS });
    return true;
  }
  entry.count += 1;
  return entry.count <= IP_MAX_REQUESTS;
}

function languageName(code) {
  if (code.toLowerCase() === "zh") return "Simplified Chinese";
  try {
    return languageNames.of(code) || code;
  } catch (err) {
    return code;
  }
}

function parseJob(raw) {
  let data;
  try {
    data = JSON.parse(raw.toString("utf8"));
  } catch (err) {
    throw httpError(400, "The request body is not valid JSON.");
  }
  const list = data && data.lines;
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_LINES) {
    throw httpError(400, `"lines" must be an array with 1 to ${MAX_LINES} items.`);
  }
  let total = 0;
  const lines = list.map((item) => {
    const line = typeof item === "string" ? item.replace(/\s+/g, " ").trim() : "";
    if (!line || line.length > MAX_LINE_CHARS) {
      throw httpError(400, `Every line must be a string with 1 to ${MAX_LINE_CHARS} characters.`);
    }
    total += line.length;
    return line;
  });
  if (total > MAX_TOTAL_CHARS) throw httpError(400, `The lyrics are longer than ${MAX_TOTAL_CHARS} characters.`);

  const target = String(data.target || "").trim();
  if (!LANG_CODE.test(target)) throw httpError(400, '"target" must be a language code such as TR or PT-BR.');
  const source = String(data.source || "").trim();
  return {
    lines,
    target,
    source: LANG_CODE.test(source) ? source : "",
    model: String(data.model || "auto").trim().toLowerCase(),
  };
}

function buildPrompt(lines, target, source) {
  const to = languageName(target);
  const from = source ? ` from ${languageName(source)}` : "";
  return [
    `Translate these song lyrics${from} into ${to}. The translation is shown under each line while the song plays.`,
    "",
    "Rules:",
    "- Read every line first. Use the whole song as context for pronouns, tense, idioms and slang.",
    `- Write natural ${to}, the way a native speaker would say it. Translate the meaning, not word for word.`,
    "- Keep the tone of the original, including slang and swear words. Do not censor or soften anything.",
    "- Each translation stays on its own line. Never merge, split, reorder or skip lines.",
    '- Keep names, brands and pure vocal sounds such as "oh", "yeah", "la la" or "skrrt" as they are.',
    "- Text in parentheses or brackets is part of the lyrics (backing vocals, echoes, asides). Translate it like any other text and keep the brackets. Leave a bracket unchanged only when it contains nothing but vocal sounds.",
    "- A line made only of a bracketed phrase still needs a full translation.",
    `- Repeat a line unchanged when it is already in ${to}.`,
    "- Never leave a translation empty. Repeat a line unchanged when it cannot be translated.",
    "- Do not add notes, explanations or quotation marks.",
    "",
    `The input has ${lines.length} lines in the form "number|text".`,
    `Answer with exactly ${lines.length} lines in the form "number|translation", numbered 1 to ${lines.length}, and nothing else.`,
    "",
    lines.map((line, i) => `${i + 1}|${line}`).join("\n"),
  ].join("\n");
}

function parseAnswer(text, count) {
  const out = new Array(count).fill(null);
  const rows = String(text).replace(/<think>[\s\S]*?<\/think>/gi, "").split(/\r?\n/);
  for (const row of rows) {
    const match = /^\s*(\d{1,4})\s*\|(.*)$/.exec(row);
    if (!match) continue;
    const i = Number(match[1]) - 1;
    if (i >= 0 && i < count && out[i] === null) out[i] = match[2].trim();
  }
  const missing = out.filter((line) => line === null).length;
  if (missing) throw new Error(`${missing} of ${count} lines are missing in the answer`);
  // An empty translation would be cached by the extension as a line without a translation, so
  // the whole answer is refused and the next model is tried.
  const empty = out.filter((line) => !line).length;
  if (empty) throw new Error(`${empty} of ${count} lines came back empty`);
  return out;
}

async function postJson(url, headers, body, timeoutMs) {
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, headers),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(err && err.name === "TimeoutError" ? `no answer within ${Math.round(timeoutMs / 1000)} s` : `request failed (${err.message})`);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = data && data.error && data.error.message;
    throw httpError(res.status, `HTTP ${res.status}` + (typeof detail === "string" ? `: ${detail.slice(0, 200)}` : ""));
  }
  return data;
}

async function askGoogle(slot, prompt, timeoutMs, plain) {
  const body = { contents: [{ parts: [{ text: prompt }] }] };
  // The REST reference lists the levels in capitals (MINIMAL, LOW, MEDIUM, HIGH).
  if (!plain) body.generationConfig = { thinkingConfig: { thinkingLevel: slot.thinking.toUpperCase() } };
  const url = `${GOOGLE_URL}${encodeURIComponent(slot.model)}:generateContent`;
  const data = await postJson(url, { "x-goog-api-key": slot.key }, body, timeoutMs);
  const candidate = data && Array.isArray(data.candidates) ? data.candidates[0] : null;
  const parts = (candidate && candidate.content && candidate.content.parts) || [];
  const text = parts.map((part) => (part && !part.thought && typeof part.text === "string" ? part.text : "")).join("");
  const reason = (candidate && candidate.finishReason) || (data && data.promptFeedback && data.promptFeedback.blockReason) || "no reason given";
  if (!text.trim()) throw new Error(`empty answer (${reason})`);
  if (reason === "MAX_TOKENS") throw new Error("the answer was cut off");
  const usage = data.usageMetadata || {};
  return {
    text,
    tokens: tokenCount(usage.totalTokenCount),
    thinkingTokens: data.usageMetadata ? tokenCount(usage.thoughtsTokenCount) || 0 : null,
  };
}

async function askGroq(slot, prompt, timeoutMs, plain, maxTokens) {
  // Thinking is paid from the same output limit, so a model that thinks gets extra room.
  const room = slot.thinking && slot.thinking !== "none" ? GROQ_THINKING_TOKENS : 0;
  const body = {
    model: slot.model,
    messages: [{ role: "user", content: prompt }],
    temperature: slot.temperature,
    max_completion_tokens: Math.min(GROQ_MAX_TOKENS, maxTokens + room),
  };
  if (slot.topP) body.top_p = slot.topP;
  if (!plain) body.reasoning_effort = slot.thinking;
  const data = await postJson(GROQ_URL, { Authorization: `Bearer ${slot.key}` }, body, timeoutMs);
  const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
  if (choice && choice.finish_reason === "length") throw new Error("the answer was cut off");
  const text = choice && choice.message && typeof choice.message.content === "string" ? choice.message.content : "";
  if (!text.trim()) throw new Error("empty answer");
  const usage = data.usage || {};
  const details = usage.completion_tokens_details || {};
  return { text, tokens: tokenCount(usage.total_tokens), thinkingTokens: tokenCount(details.reasoning_tokens) };
}

// The thinking level is optional. When a model rejects it (HTTP 400), the request is sent again
// without it, within the same time limit, and later requests to that model leave it out.
async function ask(slot, prompt, timeoutMs, maxTokens) {
  const started = Date.now();
  const send = (plain) => {
    const ms = Math.max(1000, timeoutMs - (Date.now() - started));
    return slot.api === "google" ? askGoogle(slot, prompt, ms, plain) : askGroq(slot, prompt, ms, plain, maxTokens);
  };
  const plain = slot.plain || !slot.thinking;
  try {
    return await send(plain);
  } catch (err) {
    if (plain || err.status !== 400) throw err;
    const reply = await send(true);
    slot.plain = true;
    console.log(`[llm-proxy] ${slot.model} rejected the thinking level "${slot.thinking}"; it is left out from now on.`);
    return reply;
  }
}

async function translate(job) {
  const unique = [...new Set(job.lines)];
  const prompt = buildPrompt(unique, job.target, job.source);
  const chars = unique.reduce((sum, line) => sum + line.length, 0);
  // Groq's default output limit is small, so a limit is always sent. It is kept low because the
  // output limit may count towards the tokens-per-minute quota.
  const maxTokens = Math.max(512, Math.ceil(chars * 1.5) + unique.length * 6 + 200);
  const wanted = ORDER.includes(job.model) ? [job.model, ...ORDER.filter((name) => name !== job.model)] : ORDER;
  const failed = [];
  // Models paused after a rate limit are left out first, so the time is shared among the rest.
  const order = wanted.filter((name) => {
    if (!(MODELS[name].pausedUntil > Date.now())) return true;
    failed.push(`${name}: paused after a rate limit`);
    return false;
  });
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;

  for (let i = 0; i < order.length; i++) {
    const name = order[i];
    const slot = MODELS[name];
    const waiting = order.length - i - 1;
    const timeoutMs = Math.min(MODEL_TIMEOUT_MS, deadline - Date.now() - waiting * MODEL_RESERVE_MS);
    if (timeoutMs < MIN_TRY_MS) {
      failed.push(`${name}: no time left`);
      continue;
    }
    const started = Date.now();
    try {
      const reply = await ask(slot, prompt, timeoutMs, maxTokens);
      const answer = parseAnswer(reply.text, unique.length);
      const byLine = new Map(unique.map((line, k) => [line, answer[k]]));
      return {
        lines: job.lines.map((line) => byLine.get(line)),
        model: `${name}:${slot.model}`,
        tokens: reply.tokens,
        thinkingTokens: reply.thinkingTokens,
        failed,
      };
    } catch (err) {
      if (err.status === 429) slot.pausedUntil = Date.now() + RATE_LIMIT_PAUSE_MS;
      console.log(`[llm-proxy] ${name} failed after ${Date.now() - started} ms: ${err.message}`);
      failed.push(`${name}: ${err.message}`);
    }
  }
  throw httpError(502, `No model could translate the lyrics. ${failed.join(" | ")}`);
}

const server = http.createServer(async (req, res) => {
  const path = String(req.url || "").split("?")[0];
  setCors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method === "GET" && (path === "/" || path === "/health")) {
    sendJson(res, 200, { ok: true, models: ORDER });
    return;
  }
  if (req.method !== "POST" || path !== "/v1/translate") {
    req.resume();
    sendJson(res, 404, { message: "Unsupported request. Allowed: GET /health, POST /v1/translate" });
    return;
  }

  const started = Date.now();
  try {
    if (ACCESS_TOKEN && req.headers["authorization"] !== `Bearer ${ACCESS_TOKEN}`) {
      throw httpError(401, "The access token is missing or wrong.");
    }
    if (!allowIp(req)) throw httpError(429, "Too many requests. Try again in a few minutes.");
    if (ORDER.length === 0) throw httpError(503, "No model is set up on the server.");
    const job = parseJob(await readBody(req));
    const result = await translate(job);
    const show = (n) => (n === null ? "?" : n);
    console.log(
      `[llm-proxy] ${result.model}: ${job.lines.length} lines in ${Date.now() - started} ms, ` +
        `${show(result.tokens)} tokens, ${show(result.thinkingTokens)} of them for thinking`
    );
    sendJson(res, 200, result);
  } catch (err) {
    req.resume();
    console.log(`[llm-proxy] failed after ${Date.now() - started} ms: ${err.message}`);
    sendJson(res, err.status || 500, { message: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`LLM proxy is running: http://${HOST}:${PORT}`);
  console.log(
    ORDER.length
      ? "Models, in order: " + ORDER.map((name) => `${name} (${MODELS[name].model}, thinking ${MODELS[name].thinking})`).join(", ")
      : "No model is set up. Set GEMINI_API_KEY or GROQ_API_KEY."
  );
  if (!ACCESS_TOKEN) console.log("ACCESS_TOKEN is not set: anyone who knows the address can use this server.");
});
