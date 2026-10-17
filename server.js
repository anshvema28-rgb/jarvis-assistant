/* ============================================================
   server.js  -  Backend (zero dependencies, plain Node.js)

   What it does:
    1) Serves the website files (index.html, style.css, script.js,
       commands.js)
    2) Exposes POST /api/ask  ->  returns a reply
       Body: { "message": "...", "history": [{role,text}, ...],
               "mode": "default" | "study" }   (mode is optional)
       The optional "history" gives Gemini recent context so it can
       answer follow-up questions. Client history is UNTRUSTED: it is
       validated, role-allowlisted, truncated and capped here.
       "mode" is only a NAME the client may pick from a server-side
       allowlist; the instruction text for each mode lives only here.
   3) Keeps any AI API key HERE, on the server.
      The browser can never read it.

   Two modes for /api/ask:
   - Gemini configured (GEMINI_API_KEY + GEMINI_MODEL) -> Google Gemini
   - Not configured                                    -> smart local replies
     So the app works instantly, and you can plug in free-tier
     Gemini later just by setting two environment variables.

   Run:  node server.js     then open  http://localhost:3000
   ============================================================ */

const http = require("http");
const fs = require("fs");
const path = require("path");

// ---------- Load optional .env file (no npm packages needed) ----------
try {
  const envFile = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
  for (const line of envFile.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) {
      // trim whitespace and strip optional surrounding quotes from the value
      process.env[m[1]] = m[2].trim().replace(/^["'](.*)["']$/, "$1");
    }
  }
} catch (_) {
  /* no .env file -> that's fine */
}

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || ""; // secret key - stays on this server
// gemini-flash-lite-latest always points to Google's newest flash-lite model,
// which has a working free tier (older models like gemini-2.5-flash return 404
// for new accounts, and the bigger flash models often return 503 "high demand").
const DEFAULT_GEMINI_MODEL = "gemini-flash-lite-latest";
const GEMINI_MODEL = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;

// ============================================================
//  Static file serving
// ============================================================
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";

  const filePath = path.join(__dirname, path.normalize(urlPath));
  if (!filePath.startsWith(__dirname)) {
    // block path traversal like /../../secret
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("404 - Not Found");
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

// ============================================================
//  Local reply engine (works offline, no API key needed)
// ============================================================
function localReply(message) {
  const msg = message.toLowerCase().trim();

  if (/^(hi|hello|hey|namaste|namaskar)\b/.test(msg))
    return "Hello! I am JARVIS, your assistant. How can I help you today?";

  if (msg.includes("how are you"))
    return "All systems are running perfectly. Thank you for asking!";

  if (msg.includes("your name") || msg.includes("who are you"))
    return "I am JARVIS — a basic AI voice assistant running locally on your machine.";

  if (msg.includes("time"))
    return "The current time is " + new Date().toLocaleTimeString() + ".";

  if (msg.includes("date") || msg.includes("day"))
    return "Today is " + new Date().toLocaleDateString(undefined, {
      weekday: "long", year: "numeric", month: "long", day: "numeric",
    }) + ".";

  if (msg.includes("creator") || msg.includes("who made you"))
    return "I was built by you, with HTML, CSS, JavaScript and Node.js.";

  if (msg.includes("thank"))
    return "You are welcome. Always happy to help.";

  if (msg.includes("joke"))
    return "Why do programmers prefer dark mode? Because light attracts bugs.";

  if (msg.includes("bye") || msg.includes("goodbye"))
    return "Goodbye! Powering down this conversation. Talk to you soon.";

  if (msg.includes("help") || msg.includes("what can you do"))
    return "I can chat with you by text or voice, tell the time and date, and " +
      "answer questions once you connect a free AI API in the .env file.";

  return "You said: \"" + message + "\". " +
    "I am running in offline mode — connect a free AI API in .env so I can " +
    "give smarter answers.";
}

// ============================================================
//  Conversation context sent to Gemini
//  Client-supplied history is NEVER trusted:
//  - only { role, text } is read; every other field is ignored,
//    so no client "system" instruction can ever reach the model
//  - roles outside the allowlist are dropped
//  - text is trimmed and truncated, count is capped
//  The system instruction always comes from THIS file only.
// ============================================================
const ALLOWED_ROLES = new Set(["user", "assistant"]); // explicit allowlist
const ALLOWED_MODES = new Set(["default", "study"]); // explicit allowlist
const MAX_HISTORY = 12;          // most recent messages forwarded
const MAX_HISTORY_TEXT = 2000;   // per-message cap (matches the UI cap)
const MAX_MESSAGE_LEN = 500;     // cap for the current message
const MAX_BODY = 64 * 1024;      // max /api/ask request body (bytes)

// System instructions live ONLY in this file. The client can select a
// mode by name ("default" / "study") but can never supply instruction
// text - unknown names fall back to the default instruction.
const SYSTEM_INSTRUCTIONS = Object.freeze({
  default:
    "You are JARVIS, a concise, friendly voice assistant. " +
    "Keep answers short because they are read aloud.",
  study:
    "You are JARVIS in Study Mode, a friendly tutor for a Class 9 student " +
    "(CBSE-style syllabus: Science, Maths, Social Science, English). " +
    "Explain concepts in simple language with everyday examples. " +
    "For quiz requests, ask one question at a time with options A, B, C, D " +
    "and wait for the answer before continuing. " +
    "Keep answers short enough to be read aloud.",
});

function getSystemInstruction(mode) {
  return SYSTEM_INSTRUCTIONS[ALLOWED_MODES.has(mode) ? mode : "default"];
}

// Returns a clean array of { role, text} - never throws.
function sanitizeHistory(raw) {
  if (!Array.isArray(raw)) return [];

  const clean = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    if (!ALLOWED_ROLES.has(item.role)) continue; // drops "system", "tool", ...
    if (typeof item.text !== "string") continue;
    const text = item.text.trim().slice(0, MAX_HISTORY_TEXT);
    if (!text) continue;

    // drop accidental back-to-back duplicates (double submit / retry)
    const prev = clean[clean.length - 1];
    if (prev && prev.role === item.role && prev.text === text) continue;

    clean.push({ role: item.role, text });
  }

  // Keep only the most recent turns, and make sure the conversation
  // opens with a user turn (Gemini rejects an assistant-first thread).
  const recent = clean.slice(-MAX_HISTORY);
  while (recent.length && recent[0].role !== "user") recent.shift();
  return recent;
}

// Build the Gemini "contents" array: validated history + current message.
function buildContents(history, message) {
  const contents = sanitizeHistory(history).map((m) => ({
    role: m.role,
    parts: [{ text: m.text }],
  }));

  // The client usually already appended the message being sent; avoid
  // sending it twice.
  const last = contents[contents.length - 1];
  if (!last || last.role !== "user" || last.parts[0].text !== message) {
    contents.push({ role: "user", parts: [{ text: message }] });
  }
  return contents;
}

// Belt-and-braces: never print the API key, whatever error text we got.
function redact(text) {
  const s = String(text == null ? "" : text);
  return GEMINI_API_KEY ? s.split(GEMINI_API_KEY).join("[redacted]") : s;
}

// ============================================================
//  Call Google Gemini generateContent (optional, key stays on server)
//  Uses Node's built-in fetch - no packages required.
//  The key is never logged, never returned, never sent to the browser.
// ============================================================
async function callAI(message, history, mode) {
  const contents = buildContents(history, message);
  try {
    return await geminiRequest(contents, GEMINI_MODEL, mode);
  } catch (err) {
    // If the configured model is retired (404) or overloaded (503),
    // retry once with the known-good default model.
    const retryable = /no longer available|high demand|not found|not supported/i.test(
      err.message
    );
    if (retryable && GEMINI_MODEL !== DEFAULT_GEMINI_MODEL) {
      console.log(
        "Model '" + GEMINI_MODEL + "' unavailable - retrying with " + DEFAULT_GEMINI_MODEL
      );
      return await geminiRequest(contents, DEFAULT_GEMINI_MODEL, mode);
    }
    throw err;
  }
}

async function geminiRequest(contents, model, mode) {
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(model) +
    ":generateContent";

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": GEMINI_API_KEY, // key stays in this header, server-side only
      },
      body: JSON.stringify({
        contents,
        systemInstruction: {
          parts: [{ text: getSystemInstruction(mode) }],
        },
        generationConfig: { maxOutputTokens: 300 },
      }),
      signal: AbortSignal.timeout(20000),
    });
  } catch (_) {
    // network / timeout - message only, never include the URL or key
    throw new Error("Could not reach Gemini (network or timeout)");
  }

  // Parse the JSON body once; handle invalid JSON safely
  let data = null;
  try {
    data = await res.json();
  } catch (_) {
    /* data stays null */
  }

  if (!res.ok) {
    // Google's error message is safe to surface (no key involved)
    const apiError = data && data.error && data.error.message;
    throw new Error(apiError || "Gemini request failed (HTTP " + res.status + ")");
  }

  // Extract text: candidates[0].content.parts[0].text
  const text =
    data &&
    data.candidates &&
    data.candidates[0] &&
    data.candidates[0].content &&
    data.candidates[0].content.parts &&
    data.candidates[0].content.parts
      .map((p) => (typeof p.text === "string" ? p.text : ""))
      .join("")
      .trim();

  if (!text) {
    // e.g. blocked by safety filters, or empty candidates
    const reason =
      data && data.candidates && data.candidates[0] && data.candidates[0].finishReason;
    throw new Error(
      reason ? "Gemini returned no text (finishReason: " + reason + ")" : "Gemini returned an empty response"
    );
  }

  return text;
}

// ============================================================
//  /api/ask handler
// ============================================================
function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

async function handleAsk(req, res) {
  let raw = "";
  let rejected = false;

  // A dropped connection must never crash the server
  req.on("error", () => {});

  req.on("data", (chunk) => {
    if (rejected) return;
    raw += chunk;
    if (raw.length > MAX_BODY) {
      // oversized request - answer once, then ignore the rest of the body
      rejected = true;
      raw = "";
      sendJson(res, 413, { error: "Request too large" });
    }
  });

  req.on("end", async () => {
    if (rejected) return;

    // ---------- validate body ----------
    let body = null;
    try {
      body = JSON.parse(raw);
    } catch (_) {
      return sendJson(res, 400, { error: "Invalid JSON body" });
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return sendJson(res, 400, { error: "Invalid request body" });
    }

    const message =
      typeof body.message === "string"
        ? body.message.trim().slice(0, MAX_MESSAGE_LEN)
        : "";

    if (!message) {
      return sendJson(res, 400, { error: "Message is required" });
    }

    // history is optional; when present it must be an array.
    // sanitizeHistory() then allowlists roles and caps size/length.
    let history = [];
    if (body.history !== undefined) {
      if (!Array.isArray(body.history)) {
        return sendJson(res, 400, { error: "history must be an array" });
      }
      history = sanitizeHistory(body.history);
    }

    // mode is optional; only the allowlisted NAMES are accepted so the
    // client can pick a persona but can never inject instruction text.
    let mode = "default";
    if (body.mode !== undefined) {
      if (typeof body.mode !== "string" || !ALLOWED_MODES.has(body.mode)) {
        return sendJson(res, 400, { error: "mode must be 'default' or 'study'" });
      }
      mode = body.mode;
    }

    const send = (reply, source) => sendJson(res, 200, { reply, mode: source });

    // Gemini configured?  -> use it.  Otherwise -> local engine.
    if (GEMINI_API_KEY) {
      try {
        const reply = await callAI(message, history, mode);
        return send(reply, "ai");
      } catch (err) {
        console.error("AI call failed:", redact(err.message));
        return send(localReply(message) + "\n(offline fallback: AI unreachable)", "local");
      }
    }

    send(localReply(message), "local");
  });
}

// ============================================================
//  Server
// ============================================================
const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/ask") return handleAsk(req, res);
  if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res);
  res.writeHead(405);
  res.end("Method Not Allowed");
});

function start() {
  server.listen(PORT, () => {
    console.log("");
    console.log("  +------------------------------------------+");
    console.log("  |  JARVIS server is running                |");
    console.log(`  |  Open  http://localhost:${PORT}  in Chrome   |`);
    console.log("  +------------------------------------------+");
    console.log("");
    console.log(
      GEMINI_API_KEY
        ? "  AI mode: GOOGLE GEMINI (" + GEMINI_MODEL + ")"
        : "  AI mode: OFFLINE (set GEMINI_API_KEY in .env to upgrade)"
    );

    // Helpful hint if .env still uses the old variable names (values never printed)
    const legacy = ["GEMINI_API_KEY", "AI_API_KEY", "AI_API_URL", "AI_MODEL"]
      .slice(1)
      .filter((n) => n in process.env);
    if (!GEMINI_API_KEY && legacy.length) {
      console.log("");
      console.log("  NOTE: .env still uses old variable names: " + legacy.join(", "));
      console.log("  Rename  AI_API_KEY  -> GEMINI_API_KEY");
      console.log("  Rename  AI_MODEL    -> GEMINI_MODEL   (AI_API_URL is no longer used)");
      console.log("  and restart this server.");
    }

    console.log("  Press Ctrl+C to stop.");
    console.log("");
  });
  return server;
}

// Only listen when executed directly (node server.js), so tests can
// require() this file without binding a port.
if (require.main === module) start();

module.exports = {
  server,
  start,
  handleAsk,
  sanitizeHistory,
  buildContents,
  localReply,
  redact,
  getSystemInstruction,
  ALLOWED_ROLES,
  ALLOWED_MODES,
  SYSTEM_INSTRUCTIONS,
  MAX_HISTORY,
  MAX_HISTORY_TEXT,
  MAX_MESSAGE_LEN,
  MAX_BODY,
};
