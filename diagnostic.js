/* ============================================================
   diagnostic.js  -  Safe Gemini connectivity diagnostic
   
   Reports ONLY:
   - HTTP status code
   - Error category (network, invalid_key, model_not_found, quota, etc.)
   - Model name (not secret)
   
   NEVER prints:
   - API key or any part of it
   - Request URL (contains key in query string)
   - Secret headers
   
   Run:  node diagnostic.js
   ============================================================ */

const fs = require("fs");
const path = require("path");

// Load .env (same logic as server.js)
try {
  const envFile = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
  for (const line of envFile.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) {
      process.env[m[1]] = m[2].trim().replace(/^["'](.*)["']$/, "$1");
    }
  }
} catch (_) {}

const API_KEY = process.env.GEMINI_API_KEY || "";
const MODEL = process.env.GEMINI_MODEL || "gemini-flash-lite-latest";

function classifyError(status, body) {
  // Network-level errors already handled (status === null)
  if (status === null) return "network_error";
  
  // HTTP status-based classification
  if (status === 400) {
    if (body && body.error) {
      const msg = body.error.message || "";
      if (/not found|unsupported/i.test(msg)) return "model_not_found";
      if (/invalid.*request/i.test(msg)) return "invalid_request";
    }
    return "bad_request";
  }
  if (status === 401 || status === 403) return "invalid_key";
  if (status === 404) return "model_not_found";
  if (status === 429) return "quota_exceeded";
  if (status >= 500) return "server_error";
  return "http_error_" + status;
}

async function diagnostic() {
  console.log("=== Gemini API Diagnostic ===\n");
  
  // 1. Check if key is present (length only, never print value)
  if (!API_KEY) {
    console.log("❌ CRITICAL: No GEMINI_API_KEY found in .env");
    console.log("   Server will use offline mode. Add GEMINI_API_KEY to .env.\n");
    process.exit(1);
  }
  
  console.log("✓ GEMINI_API_KEY is set (length: " + API_KEY.length + " chars)");
  console.log("✓ GEMINI_MODEL: " + MODEL + "\n");
  
  // 2. Test connectivity with a minimal request
  console.log("Testing API connectivity...\n");
  
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(MODEL) +
    ":generateContent";
  
  let res;
  let body = null;
  
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": API_KEY,
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "ping" }] }],
        generationConfig: { maxOutputTokens: 10 },
      }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    // Network/DNS/timeout - don't include err.message (may contain URL)
    console.log("❌ NETWORK ERROR");
    console.log("   Category: " + classifyError(null, null));
    console.log("   Likely cause: DNS failure, firewall, or timeout");
    console.log("   Fix: Check internet connection, proxy settings, firewall\n");
    process.exit(1);
  }
  
  // 3. Parse response body (safe - no secrets in Google's error responses)
  try {
    body = await res.json();
  } catch (_) {
    // Invalid JSON - keep body as null
  }
  
  // 4. Report result
  if (res.ok) {
    console.log("✅ SUCCESS: HTTP " + res.status);
    console.log("   Model '" + MODEL + "' is valid and reachable");
    console.log("   API key is valid");
    
    // Verify we got a valid response structure
    if (body && body.candidates && body.candidates[0]) {
      const text = body.candidates[0].content?.parts?.[0]?.text || "";
      console.log("   Response preview: " + text.substring(0, 30));
    }
    console.log("\n✓ AI mode should work. Restart server if still offline.\n");
    process.exit(0);
  }
  
  // Error case - classify and report
  const errorCategory = classifyError(res.status, body);
  const errorMessage = body?.error?.message || "(no error message)";
  
  console.log("❌ API ERROR: HTTP " + res.status);
  console.log("   Category: " + errorCategory);
  console.log("   Message: " + errorMessage + "\n");
  
  // Provide actionable fixes
  switch (errorCategory) {
    case "invalid_key":
      console.log("   🔑 FIX: API key is invalid or revoked");
      console.log("   1. Go to https://aistudio.google.com/app/apikey");
      console.log("   2. Verify key is active (not expired/revoked)");
      console.log("   3. Copy new key to .env as GEMINI_API_KEY=your-key\n");
      break;
      
    case "model_not_found":
      console.log("   📦 FIX: Model '" + MODEL + "' not available");
      console.log("   Options:");
      console.log("   A) Change .env: GEMINI_MODEL=gemini-flash-lite-latest");
      console.log("   B) Or: GEMINI_MODEL=gemini-1.5-flash");
      console.log("   (gemini-2.5-flash may not be available on free tier)\n");
      break;
      
    case "quota_exceeded":
      console.log("   ⏱️ FIX: Rate limit or quota exceeded");
      console.log("   Free tier limits: 15 RPM, 1M tokens/day");
      console.log("   Wait 60 seconds, or check quota at:");
      console.log("   https://console.cloud.google.com/apis/api/generativelanguage.googleapis.com\n");
      break;
      
    case "bad_request":
    case "invalid_request":
      console.log("   ⚠️  FIX: Request format issue");
      console.log("   Model '" + MODEL + "' exists but rejected the request");
      console.log("   Try different model or check Google AI Studio docs\n");
      break;
      
    case "server_error":
      console.log("   🔧 FIX: Google server error (not your fault)");
      console.log("   Try again in a few minutes");
      console.log("   Or switch to a more stable model:");
      console.log("   GEMINI_MODEL=gemini-flash-lite-latest\n");
      break;
      
    default:
      console.log("   ❓ Unknown error - check Google AI Studio docs");
      console.log("   https://ai.google.dev/gemini-api/docs/troubleshooting\n");
  }
  
  process.exit(1);
}

diagnostic().catch((err) => {
  console.error("Diagnostic failed:", err.message);
  process.exit(1);
});
