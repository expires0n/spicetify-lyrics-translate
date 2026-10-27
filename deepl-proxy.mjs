
import http from "node:http";

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT) || 8787;
const MAX_BODY_BYTES = 1024 * 1024;
const ALLOWED = new Set(["GET /v2/languages", "POST /v2/translate"]);

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  res.setHeader("Access-Control-Max-Age", "600");
}

function sendJson(res, status, payload) {
  setCors(res);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) tooLarge = true;
      else chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) {
        const err = new Error("Request body is too large.");
        err.status = 413;
        reject(err);
      } else {
        resolve(Buffer.concat(chunks));
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    setCors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (!ALLOWED.has(`${req.method} ${url.pathname}`)) {
    req.resume();
    sendJson(res, 404, { message: "Unsupported request. Allowed: GET /v2/languages, POST /v2/translate" });
    return;
  }

  const auth = req.headers["authorization"] || "";
  if (!auth.startsWith("DeepL-Auth-Key ")) {
    req.resume();
    sendJson(res, 401, { message: "The Authorization header has no DeepL-Auth-Key." });
    return;
  }

  let body;
  try {
    body = req.method === "POST" ? await readBody(req) : undefined;
  } catch (err) {
    sendJson(res, err.status || 400, { message: err.message });
    return;
  }

  const apiKey = auth.slice("DeepL-Auth-Key ".length).trim();
  const base = apiKey.endsWith(":fx") ? "https://api-free.deepl.com" : "https://api.deepl.com";

  try {
    const upstream = await fetch(base + url.pathname + url.search, {
      method: req.method,
      headers: {
        Authorization: auth,
        "Content-Type": req.headers["content-type"] || "application/json",
      },
      body,
    });
    const text = await upstream.text();
    setCors(res);
    res.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
    });
    res.end(text);
  } catch (err) {
    sendJson(res, 502, { message: "Could not reach DeepL: " + err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`DeepL proxy is running: http://${HOST}:${PORT}  (press Ctrl+C to stop)`);
});
