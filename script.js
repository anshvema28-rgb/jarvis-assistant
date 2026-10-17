/* ============================================================
   script.js  -  Frontend logic
   1) Chat: send message -> POST /api/ask -> show reply
   2) Voice input: Web Speech API (SpeechRecognition)
   3) Voice output: SpeechSynthesis (text-to-speech)
   4) Memory: chat saved to localStorage, restored on reload,
      wipeable with the CLEAR CHAT button (confirmation required)
   5) Quick Commands (/time, /date, /open ..., /study ...):
      handled locally by commands.js (allowlisted sites only),
      everything else goes to the AI as before
   6) Hands-Free Voice Mode (optional, user-started only - see
      handsfree.js): LISTENING -> PROCESSING -> SPEAKING loop,
      pauses the mic while JARVIS speaks, optional "Hey JARVIS" wake word
   NOTE: no API keys ever live in this file or in localStorage.
   ============================================================ */

// ---------- Elements ----------
const chatForm   = document.getElementById("chatForm");
const userInput  = document.getElementById("userInput");
const chatLog    = document.getElementById("chatLog");
const typing     = document.getElementById("typing");
const micBtn     = document.getElementById("micBtn");
const ttsBtn     = document.getElementById("ttsBtn");
const clearBtn   = document.getElementById("clearBtn");
const handsFreeBtn = document.getElementById("handsFreeBtn");
const wakeWordChk  = document.getElementById("wakeWordChk");
const wakeWrap     = document.getElementById("wakeWrap");
const statusBar  = document.getElementById("statusBar");
const statusText = document.getElementById("statusText");
// Command Center dashboard (see dashboard.js)
const dashPanel    = document.getElementById("dashPanel");
const dashToggle   = document.getElementById("dashToggle");
const clockTime    = document.getElementById("clockTime");
const clockDate    = document.getElementById("clockDate");
const dashStatus   = document.getElementById("dashStatus");
const dashQuick    = document.getElementById("dashQuick");
const dashLauncher = document.getElementById("dashLauncher");
const dashActivity = document.getElementById("dashActivity");
const reactorEl     = document.getElementById("reactorCore");
const waveformEl    = document.getElementById("waveform");
const coreStateEl   = document.getElementById("coreState");

// ---------- State ----------
let isBusy = false;            // true while waiting for the backend
let ttsEnabled = true;         // speak replies on/off
let recognition = null;        // SpeechRecognition instance
let isListening = false;
let chatHistory = [];          // in-memory copy of saved messages
let studyMode = false;         // Class 9 Study Mode toggle (session only)
let pageHidden = document.hidden; // honesty about browser background limits
let speakToken = 0;            // guards stale utterance callbacks
let lastVoiceText = "";        // drops duplicate final transcripts
let lastVoiceAt = 0;
let recStartedAt = 0;          // when the current recognition run began
let recQuickEnds = 0;          // consecutive instant recognition deaths
let lastWakeAckAt = 0;         // bare-wake acknowledgment cooldown
let wakeWindowAt = 0;          // when a bare wake opened the command window (0 = closed)
let aiState = "ready";         // dashboard AI indicator: ready|thinking|gemini|local|error
let apiState = "standby";      // dashboard API indicator: standby|online-ai|online-local|error
let activityLog = [];          // dashboard activity: LABELS ONLY, in-memory, capped

// ---------- Hands-Free Voice Mode state machine (see handsfree.js) ----------
// Session-only: it NEVER auto-starts on load - listening must always
// be started by an explicit user click (never secretly listen).
const hf = JarvisHandsFree.createMachine();

// Maps a machine state to the CSS class used on the status bar.
const HF_STATUS_MODE = {
  listening: "listening",
  processing: "busy",
  speaking: "speaking",
  off: "off",
};

// ---------- Conversation memory (localStorage) ----------
// Only { role, text } pairs are ever stored - never keys, env vars or secrets.
const STORAGE_KEY = "jarvis_chat_history_v1";
const MAX_MESSAGES = 100;      // keep at most this many messages
const MAX_TEXT_LEN = 2000;     // truncate any single message to this many chars

const WELCOME =
  "Boot sequence complete. Hello — I am JARVIS. Ask me anything by " +
  "typing, or press the microphone and speak.";

// Validate saved data: corrupted / wrong-typed / oversized entries are dropped
function sanitizeHistory(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const clean = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      if (item.role !== "user" && item.role !== "bot") continue;
      if (typeof item.text !== "string") continue;
      const text = item.text.trim().slice(0, MAX_TEXT_LEN);
      if (!text) continue;
      clean.push({ role: item.role, text });
      if (clean.length >= MAX_MESSAGES) break;
    }
    return clean;
  } catch (_) {
    return []; // invalid JSON -> start fresh, never crash
  }
}

function loadHistory() {
  try {
    return sanitizeHistory(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch (_) {
    return []; // storage blocked (private mode etc.) -> session-only memory
  }
}

function saveHistory() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(chatHistory));
  } catch (_) {
    // storage full or blocked - conversation still works for this session
  }
}

// Rebuild the chat window from saved history
function restoreChat() {
  chatLog.innerHTML = "";
  if (chatHistory.length === 0) {
    renderMessage("bot", WELCOME);
  } else {
    for (const item of chatHistory) renderMessage(item.role, item.text);
    chatLog.scrollTop = chatLog.scrollHeight;
  }
}

// Wipe the saved conversation - only after the user confirms
function clearChat() {
  const ok = window.confirm(
    "Delete the saved conversation history?\n\nThis cannot be undone."
  );
  if (!ok) return false;

  chatHistory = [];
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (_) {
    /* storage blocked - the session copy is already cleared */
  }
  restoreChat();
  setStatus("HISTORY CLEARED");
  logActivity("Chat history cleared");
  setTimeout(() => restoreIdleStatus(), 1500);
  userInput.focus();
  return true;
}

clearBtn.addEventListener("click", clearChat);

// ============================================================
//  STATUS BAR
// ============================================================
function setStatus(text, mode = "online") {
  statusText.textContent = text;
  statusBar.classList.remove("busy", "off", "listening", "speaking");
  if (mode !== "online") statusBar.classList.add(mode);
}

// Status to fall back to when a temporary message expires:
// while Hands-Free Mode runs, its live state always wins.
function restoreIdleStatus() {
  if (hf.enabled()) {
    syncHfUi();
    return;
  }
  setStatus(studyMode ? "STUDY MODE ON" : "SYSTEM ONLINE");
}

// ============================================================
//  CHAT RENDERING
// ============================================================
function renderMessage(role, text) {
  const row = document.createElement("div");
  row.className = `msg ${role}`;

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = role === "user" ? "U" : "J";

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;

  row.append(avatar, bubble);
  chatLog.appendChild(row);
  chatLog.scrollTop = chatLog.scrollHeight;
}

// Show a message AND remember it (saved to localStorage)
function addMessage(role, text) {
  if (role !== "user" && role !== "bot") return;
  const clean = String(text).trim().slice(0, MAX_TEXT_LEN);
  if (!clean) return;

  chatHistory.push({ role, text: clean });
  if (chatHistory.length > MAX_MESSAGES) {
    chatHistory.splice(0, chatHistory.length - MAX_MESSAGES);
  }
  saveHistory();
  renderMessage(role, clean);
}

// ============================================================
//  AI BACKEND CALL
//  Frontend only talks to our own server (/api/ask).
//  The server keeps the AI API key secret and can be swapped
//  for any free-tier provider later.
// ============================================================
const MAX_API_HISTORY = 12; // recent turns sent as context (server caps it too)

// A hung /api/ask must never wedge the app: after `ms`, abort the
// fetch so the error path runs and isBusy is always released. Without
// this, one network stall silently blocked EVERY later submission
// (voice and typed) behind the isBusy guard.
function abortSignalAfter(ms) {
  if (typeof AbortController === "undefined") return undefined;
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms);
  return ctrl.signal;
}

// Wake-word decision with a safety net for a stale browser cache: if
// an older handsfree.js (pre-2.0, no resolveWakeInput) is served while
// script.js is 2.0, calling the missing method would throw inside
// onresult and recognized speech would silently never send. Fall back
// to the proven pre-2.0 rules instead of dying.
function legacyWakeDecision(text, wakeOn) {
  const cmd =
    typeof JarvisHandsFree.extractWakeCommand === "function"
      ? JarvisHandsFree.extractWakeCommand(text)
      : null;
  if (!wakeOn) return { action: "send", text: text };
  if (cmd === null) return { action: "ignore" };
  if (!cmd) return { action: "acknowledge" };
  return { action: "send", text: cmd };
}

function resolveWakeAction(text, wakeOn) {
  if (typeof JarvisHandsFree.resolveWakeInput === "function") {
    return JarvisHandsFree.resolveWakeInput(text, wakeOn);
  }
  return legacyWakeDecision(text, wakeOn);
}

async function askBackend(message, mode) {
  // Recent conversation so the AI can understand follow-up questions.
  // Only { role, text } is sent, and UI role "bot" is mapped to the
  // Gemini role "assistant". System prompts are never sent from here -
  // they live only in server.js. "mode" is just a name ("study") that
  // the server allowlists; it can never carry instruction text.
  let history = chatHistory.slice();
  const last = history[history.length - 1];
  if (last && last.role === "user" && last.text === message) history.pop();

  history = history.slice(-MAX_API_HISTORY).map((m) => ({
    role: m.role === "user" ? "user" : "assistant",
    text: m.text,
  }));

  const body = { message, history };
  if (mode === "study") body.mode = "study";

  aiState = "thinking"; // dashboard AI indicator
  refreshDashboard();

  const API_URL = "https://jarvis-assistant-5sfo.onrender.com/api/ask";
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: abortSignalAfter(60000),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Server error (${res.status})`);
  }

  const data = await res.json();
  // mode is the server's own label: "ai" (Gemini) or "local" (offline)
  aiState = data.mode === "ai" ? "gemini" : "local";
  apiState = data.mode === "ai" ? "online-ai" : "online-local";
  refreshDashboard();
  return data.reply;
}

// ============================================================
//  SEND FLOW
// ============================================================
async function sendMessage(text) {
  const message = text.trim();
  if (!message) {
    // never leave the machine stuck in PROCESSING on empty input
    if (hf.enabled() && hf.state() === "processing") {
      hf.endProcessing();
      syncHfUi();
    }
    return;
  }
  if (isBusy) return; // duplicate submission guard

  // Hands-Free: interrupt a speaking turn if needed, then claim this
  // turn (refused only while PROCESSING - see handsfree.js).
  if (hf.enabled()) {
    if (hf.state() === "speaking") {
      try { window.speechSynthesis.cancel(); } catch (_) { /* ignore */ }
      hf.endSpeaking();
    }
    if (hf.beginProcessing()) pauseRecognitionForTurn(); // mic closed for this turn
    syncHfUi();
  }

  addMessage("user", message);
  userInput.value = "";

  // ---------- Quick Commands (safe, allowlisted - see commands.js) ----------
  // Terminal commands answer instantly in the chat (and by voice).
  // Only commands.js can produce a URL, and only from its HTTPS allowlist.
  const cmd = JarvisCommands.parseCommand(message, { studyMode });

  if (cmd.action === "reply") {
    if (typeof cmd.studyMode === "boolean") {
      studyMode = cmd.studyMode;
      logActivity(studyMode ? "Study Mode ON" : "Study Mode OFF");
      if (hf.enabled()) syncHfUi();
      else {
        setStatus(studyMode ? "STUDY MODE ON" : "SYSTEM ONLINE");
        if (!studyMode) setTimeout(() => restoreIdleStatus(), 1500);
      }
      refreshDashboard(); // study quick-action label
    } else if (message.charAt(0) === "/") {
      logActivity("Ran " + message.split(/\s+/)[0].slice(0, 20));
    }
    addMessage("bot", cmd.text);
    finishHandsFreeTurn(speak(cmd.text));
    userInput.focus();
    return;
  }

  if (cmd.action === "open") {
    addMessage("bot", cmd.text);
    logActivity("Opened " + siteLabelForUrl(cmd.url));
    const spoke = speak(cmd.text);
    try {
      window.open(cmd.url, "_blank", "noopener,noreferrer");
    } catch (_) {
      /* popup blocked - the chat message still tells the user what happened */
    }
    finishHandsFreeTurn(spoke);
    userInput.focus();
    return;
  }

  // action === "ai" -> normal flow (with optional Study Mode persona).
  // isBusy is set immediately before the try so NOTHING between the
  // flag and the guaranteed cleanup (finally) can throw and wedge the
  // app in a busy state (Milestone 2.2 hardening).
  isBusy = true;
  let replySpoke = false;
  try {
    typing.hidden = false;
    if (hf.enabled()) syncHfUi();
    else setStatus(studyMode ? "STUDY MODE..." : "PROCESSING...", "busy");

    const reply = await askBackend(cmd.message, cmd.mode);
    addMessage("bot", reply);
    logActivity(studyMode ? "Study question answered" : "AI question answered");
    replySpoke = speak(reply);
  } catch (error) {
    aiState = "error"; // dashboard AI indicator
    apiState = "error"; // dashboard API indicator (request failed / timed out)
    refreshDashboard();
    logActivity("AI request failed");
    addMessage("bot", "I could not reach my brain (server). " + error.message);
    if (!hf.enabled()) setStatus("CONNECTION ERROR", "off");
  } finally {
    typing.hidden = true;
    isBusy = false;
    finishHandsFreeTurn(replySpoke);
    if (!hf.enabled()) setStatus(studyMode ? "STUDY MODE ON" : "SYSTEM ONLINE");
    userInput.focus();
  }
}

// Close out a Hands-Free turn: move PROCESSING -> SPEAKING (speech
// already started inside speak()) or PROCESSING -> LISTENING (no
// speech). Listening resumes only while Hands-Free Mode is enabled.
function finishHandsFreeTurn(spoke) {
  if (!hf.enabled()) return;
  if (hf.state() !== "processing") return;
  if (spoke && hf.beginSpeaking()) syncHfUi();
  else {
    hf.endProcessing();
    syncHfUi();
  }
}

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  sendMessage(userInput.value);
});

// ============================================================
//  TEXT-TO-SPEECH  (SpeechSynthesis)
// ============================================================
function speak(text) {
  if (!ttsEnabled || !("speechSynthesis" in window)) return false;

  // New speech supersedes any old utterance's completion callback.
  const myToken = ++speakToken;
  window.speechSynthesis.cancel(); // don't overlap old replies

  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = "en-US";
  utter.rate = 1.02;
  utter.pitch = 0.9;

  // Prefer a natural-sounding English voice if one exists
  const voices = window.speechSynthesis.getVoices();
  const preferred =
    voices.find((v) => /en-US/i.test(v.lang) && /natural|neural|zira|david/i.test(v.name)) ||
    voices.find((v) => /^en/i.test(v.lang));
  if (preferred) utter.voice = preferred;

  const finish = () => {
    if (myToken !== speakToken) return; // superseded by a newer speak()
    clearTimeout(watchdog);
    // Hands-Free: SPEAKING -> LISTENING (only while still enabled)
    if (hf.enabled() && hf.state() === "speaking") {
      hf.endSpeaking();
      syncHfUi();
    }
  };
  utter.onend = finish;
  utter.onerror = finish;

  // Safety net: some browsers occasionally skip onend - never let
  // Hands-Free Mode get stuck in SPEAKING forever. Formula lives in
  // handsfree.js (speechWatchdogMs) so its bounds are unit-tested.
  const watchdog = setTimeout(finish, JarvisHandsFree.speechWatchdogMs(text));

  window.speechSynthesis.speak(utter);
  return true;
}

// Some browsers load voices asynchronously
if ("speechSynthesis" in window) {
  window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices();
}

ttsBtn.addEventListener("click", () => {
  ttsEnabled = !ttsEnabled;
  ttsBtn.classList.toggle("active", ttsEnabled);
  if (!ttsEnabled) window.speechSynthesis?.cancel();
  setStatus(ttsEnabled ? "VOICE ON" : "VOICE OFF");
  setTimeout(() => restoreIdleStatus(), 1200);
});

// ============================================================
//  SPEECH-TO-TEXT  (Web Speech API)
// ============================================================
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;

function initRecognition() {
  if (!SpeechRec) return null;

  const rec = new SpeechRec();
  rec.lang = "en-US";        // use "hi-IN" for Hindi
  rec.interimResults = true; // show words while speaking
  rec.continuous = false;    // ends after a pause; Hands-Free restarts it

  rec.onstart = () => {
    isListening = true;
    recStartedAt = Date.now();
    micBtn.classList.add("listening");
    if (hf.enabled()) syncHfUi();
    else setStatus("LISTENING...", "busy");
  };

  rec.onresult = (event) => {
    // Chrome (interimResults=true) finalizes longer utterances in
    // SEGMENTS: one event can hold [final, final, interim...]. The old
    // code only checked the LAST segment, so any trailing interim made
    // every final segment in that event silently un-submittable -
    // words appeared in the box but were never sent. Collect ALL final
    // segments; interim text is shown live but never submitted.
    const parts = JarvisHandsFree.collectTranscripts(event.results);
    userInput.value = parts.final + parts.interim;
    if (!parts.hasFinal) return; // interim only - wait for the final

    const text = parts.final.trim();
    if (!text) return;

    // Echo / late-final guard: with Hands-Free on, accept finals ONLY
    // in LISTENING. A final arriving while SPEAKING is JARVIS's own reply
    // leaking through the mic; while PROCESSING it is a duplicate.
    // (Manual one-shot mic mode: machine OFF - always accepted.)
    if (!JarvisHandsFree.shouldAcceptFinal(hf.state(), hf.enabled())) return;

    // Duplicate-final guard (both modes): identical text repeated
    // within the window is the same utterance, not a new command.
    const now = Date.now();
    if (JarvisHandsFree.isDuplicateFinal(text, lastVoiceText, lastVoiceAt, now)) return;
    lastVoiceText = text;
    lastVoiceAt = now;

    if (hf.enabled()) {
      // Command window: after a bare "JARVIS"/"Hey JARVIS" opens it, the
      // NEXT utterance is taken as the command (no wake word needed), so
      // the user can say the wake word and command as two sentences. The
      // window is consumed on use and expires on its own (wakeWindowActive).
      // Guards on typeof: a stale cached handsfree.js without these helpers
      // simply disables the window (falls back to single-breath wake+command).
      const wakeOn = hf.wakeWordEnabled();
      const winOpen =
        wakeOn &&
        typeof JarvisHandsFree.wakeWindowActive === "function" &&
        JarvisHandsFree.wakeWindowActive(wakeWindowAt, Date.now());
      if (winOpen) {
        wakeWindowAt = 0; // one command per wake window
        const win =
          typeof JarvisHandsFree.resolveWakeWindow === "function"
            ? JarvisHandsFree.resolveWakeWindow(text)
            : { action: "send", text: text };
        if (win.action === "reacknowledge") {
          acknowledgeWake(); // another bare wake word: refresh, don't send
          return;
        }
        if (!hf.beginProcessing()) return;
        pauseRecognitionForTurn();
        syncHfUi();
        sendMessage(win.text);
        return;
      }

      // Wake Word 2.0: decide ignore / acknowledge / send - the wake
      // word itself is never sent to the AI, a bare "Hey JARVIS" gets a
      // quiet acknowledgment (and opens the command window), and a
      // wake+command submits only the command through the normal
      // auto-send path below. resolveWakeAction guards against a stale
      // cached state machine (see legacyWakeDecision).
      const wake = resolveWakeAction(text, wakeOn);
      if (wake.action === "ignore") return;
      wakeWindowAt = 0; // any accepted submission ends a pending window
      if (wake.action === "acknowledge") {
        acknowledgeWake();
        return;
      }
      // Claim this turn (PROCESSING) - auto-send happens right here,
      // no SEND button involved. Refused while already busy or OFF ->
      // duplicate activation is dropped here.
      if (!hf.beginProcessing()) return;
      // Turn claimed: actively close the mic NOW so JARVIS's own reply
      // can never be recognized as a new command (shouldListen() only
      // gates restarting - this stops the session already running).
      pauseRecognitionForTurn();
      syncHfUi();
      // Pause the mic for this turn; the onend / TTS-finish handlers
      // restart recognition once the reply has been spoken.
      sendMessage(wake.text);
      return;
    }

    // Manual mic mode: same wake stripping, so "Hey JARVIS, ..." spoken
    // to the one-shot mic never forwards the wake word to the AI either.
    const manual = resolveWakeAction(text, false);
    if (manual.action === "acknowledge") {
      acknowledgeWake();
      return;
    }
    if (manual.action === "send") sendMessage(manual.text);
  };

  rec.onerror = (event) => {
    if (event.error === "aborted") return; // our own stop - not an error

    const map = {
      "not-allowed": "Microphone blocked - allow it in the browser",
      "service-not-allowed": "Speech service blocked - check microphone permission",
      "audio-capture": "No microphone found",
      "no-speech": "No speech detected",
      network: "Speech service needs internet",
    };
    const fatal =
      event.error === "not-allowed" ||
      event.error === "service-not-allowed" ||
      event.error === "audio-capture";

    if (fatal && hf.enabled()) {
      // Permission denied / no mic: Hands-Free cannot work - stop it
      // clearly instead of silently retrying.
      stopHandsFree(map[event.error] || "Voice input unavailable");
      return;
    }

    setStatus(map[event.error] || `VOICE ERROR: ${event.error}`, "off");
    if (hf.enabled()) syncHfUi(); // stay enabled; onend restarts the loop
    else setTimeout(() => restoreIdleStatus(), 2500);
  };

  rec.onend = () => {
    isListening = false;
    micBtn.classList.remove("listening");
    if (hf.enabled()) {
      // Safe recovery: a recognizer that dies instantly, over and over
      // (broken mic pipeline, network drop), must not hot-loop. After
      // several consecutive short-lived runs, PAUSE visibly instead -
      // the user explicitly restarts via STOP then START LISTENING.
      const lasted = Date.now() - recStartedAt;
      if (recStartedAt && lasted < 300) recQuickEnds++;
      else recQuickEnds = 0;
      if (recQuickEnds >= 5) {
        recQuickEnds = 0;
        hf.pause("MIC UNSTABLE - PRESS STOP THEN START LISTENING");
        syncHfUi(); // shows the PAUSED state; never silently restarts
        return;
      }
      // Restart ONLY if still enabled, not busy/speaking/paused, page
      // visible. After an explicit user stop, hf.enabled() is false
      // here, so nothing ever restarts on its own.
      setTimeout(() => {
        if (hf.enabled()) syncHfUi();
      }, 300);
    } else if (statusText.textContent === "LISTENING...") {
      setStatus(studyMode ? "STUDY MODE ON" : "SYSTEM ONLINE");
    }
  };

  return rec;
}

micBtn.addEventListener("click", () => {
  // While Hands-Free is on, the mic button acts as a second Stop control
  // so the two features can never fight over the recognizer.
  if (hf.enabled()) {
    stopHandsFree();
    return;
  }
  if (!SpeechRec) {
    setStatus("VOICE INPUT NOT SUPPORTED - USE CHROME OR EDGE", "off");
    setTimeout(() => restoreIdleStatus(), 3000);
    return;
  }
  if (!recognition) recognition = initRecognition();

  if (isListening) {
    recognition.stop();
  } else {
    logActivity("Mic activated");
    try {
      recognition.start();
    } catch (_) {
      /* already started */
    }
  }
});

// ============================================================
//  HANDS-FREE VOICE MODE  (opt-in, see handsfree.js)
//  - Never starts on its own: only the Start Listening button does
//  - Shows LISTENING / PROCESSING / SPEAKING / OFF in the status bar
//  - Mic loop pauses while JARVIS speaks and resumes only if the mode
//    is still enabled
// ============================================================

// Bare "Hey JARVIS"/"Jarvis" acknowledgment: opens the command window so
// the NEXT utterance is taken as the command, and (when voice is on)
// speaks a very short "Yes?". In wake-Word hands-free mode the ack CLAIMS
// a tiny turn (PROCESSING -> SPEAKING) so the existing echo guard
// (shouldAcceptFinal requires LISTENING) and pauseRecognitionForTurn()
// drop the ack's OWN TTS from the mic. Without this turn the "Yes?" echo
// would be captured while the window is open, consume the window as a
// phantom command, and leave the real follow-up command ignored (it would
// sit in the input box, never sent). speak()'s finish() returns the
// machine to LISTENING (wake standby) and restarts recognition, leaving
// the window open for the user's actual command.
function acknowledgeWake() {
  const now = Date.now();
  const hfWake = hf.enabled() && hf.wakeWordEnabled();
  // Open (or refresh) the command window whenever wake-Word hands-free
  // is active - even during the ack cooldown, so repeated bare wake
  // words keep the window ready instead of silently expiring it.
  if (hfWake) wakeWindowAt = now;
  if (now - lastWakeAckAt < 1200) return; // accidental repeats: one flash/ack
  lastWakeAckAt = now;
  setStatus("YES? I'M LISTENING", "listening");
  if (hfWake && hf.beginProcessing()) {
    // Claim a turn for the ack so its own TTS is echo-guarded + mic-closed.
    pauseRecognitionForTurn();
    if (hf.beginSpeaking()) {
      syncHfUi(); // shows SPEAKING while "Yes?" plays
      speak("Yes?"); // its finish() calls endSpeaking -> LISTENING + restart
    } else {
      hf.endProcessing(); // defensive: never wedge in PROCESSING
      syncHfUi();
    }
  } else {
    speak("Yes?"); // manual one-shot mode / claim refused: plain ack
  }
  setTimeout(() => {
    if (hf.enabled()) syncHfUi(); // keep the machine status in sync
    else if (statusText.textContent === "YES? I'M LISTENING") restoreIdleStatus();
  }, 1500);
}

function syncHfUi() {
  const enabled = hf.enabled();
  handsFreeBtn.textContent = enabled ? "STOP LISTENING" : "START LISTENING";
  handsFreeBtn.classList.toggle("active", enabled);
  handsFreeBtn.setAttribute("aria-pressed", enabled ? "true" : "false");

  if (enabled) {
    // A paused machine still reports state "listening" internally -
    // never show the green LISTENING pulse while the mic is actually
    // dead. PAUSED gets the "off" styling so the five visible states
    // (OFF / LISTENING / PROCESSING / SPEAKING / PAUSED) are distinct.
    const mode = hf.isPaused() ? "off" : HF_STATUS_MODE[hf.state()] || "online";
    setStatus(hf.status(), mode);
    ensureRecognitionLoop();
  }
}

function ensureRecognitionLoop() {
  if (!SpeechRec || !recognition) return;
  if (pageHidden) return;        // browser limit: no background listening
  if (!hf.shouldListen()) return; // busy, speaking, paused or off
  if (isListening) return;
  try {
    recognition.start();
  } catch (_) {
    /* already started */
  }
}

// Close the mic the moment a turn is claimed. shouldListen() only
// gates RESTARTING the recognizer; the session that delivered the
// final transcript is still running until Chrome's silence timeout,
// which let JARVIS's own TTS reply be recognized as a new command.
// stop() lets pending finals flush cleanly; onend then finds the
// machine in PROCESSING and does not restart (Milestone 2.2).
function pauseRecognitionForTurn() {
  if (!recognition) return;
  try {
    recognition.stop();
  } catch (_) {
    /* not running */
  }
}

function startHandsFree() {
  if (!SpeechRec) {
    setStatus("VOICE INPUT NOT SUPPORTED - USE CHROME OR EDGE", "off");
    setTimeout(() => restoreIdleStatus(), 3000);
    return;
  }
  if (pageHidden) {
    setStatus("TAB HIDDEN - RETURN TO THIS TAB TO START LISTENING", "off");
    return;
  }
  if (!recognition) recognition = initRecognition();
  if (!hf.start()) return;

  recQuickEnds = 0; // fresh explicit start: recovery backoff begins clean
  syncHfUi();
  logActivity("Hands-Free ON");
  addMessage(
    "bot",
    "Hands-Free Mode ON - I am listening. " +
      (hf.wakeWordEnabled()
        ? 'Say "Hey JARVIS" (or just "Jarvis"), then your question or command - ' +
          "one breath or two, both work. "
        : "Speak or type your message; I will answer by voice and listen again. ") +
      "Press STOP LISTENING (or the mic button) at any time. " +
      "This works only while this tab stays visible and unlocked."
  );
}

function stopHandsFree(errorMessage) {
  const wasEnabled = hf.enabled();
  hf.stop();
  wakeWindowAt = 0; // a stopped session never resumes into a stale window
  if (recognition) {
    try {
      recognition.abort(); // abort: no late final transcript submits a turn
    } catch (_) {
      /* not running */
    }
  }
  isListening = false;
  micBtn.classList.remove("listening");
  try {
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  } catch (_) {
    /* ignore */
  }

  syncHfUi(); // button back to START LISTENING

  if (wasEnabled) {
    if (errorMessage) {
      logActivity("Hands-Free stopped (error)");
      addMessage(
        "bot",
        errorMessage +
          " Hands-Free Mode stopped - press START LISTENING to try again."
      );
      setStatus(errorMessage, "off");
    } else {
      logActivity("Hands-Free OFF");
      addMessage(
        "bot",
        "Hands-Free Mode OFF - I stopped listening. Press START LISTENING to resume."
      );
      setStatus("HANDS-FREE OFF", "off");
      setTimeout(() => restoreIdleStatus(), 1500);
    }
  } else if (errorMessage) {
    setStatus(errorMessage, "off");
  }
}

handsFreeBtn.addEventListener("click", () => {
  if (hf.enabled()) stopHandsFree();
  else startHandsFree();
});

wakeWordChk.addEventListener("change", () => {
  hf.setWakeWord(wakeWordChk.checked);
  wakeWindowAt = 0; // turning wake-Word off must not leave a window open
  logActivity(wakeWordChk.checked ? "Wake word ON" : "Wake word OFF");
  setStatus(
    wakeWordChk.checked ? 'WAKE WORD ON - SAY "HEY JARVIS"' : "WAKE WORD OFF"
  );
  setTimeout(() => restoreIdleStatus(), 1500);
});

// Browser limitation, handled honestly: when the tab is hidden (or the
// device locks, which browsers report as hidden), we STOP the mic and
// show PAUSED - we never pretend to listen in the background.
document.addEventListener("visibilitychange", () => {
  pageHidden = document.hidden;
  if (!hf.enabled()) return;
  if (pageHidden) {
    hf.pause("TAB HIDDEN");
    if (recognition) {
      try {
        recognition.abort();
      } catch (_) {
        /* not running */
      }
    }
    isListening = false;
    micBtn.classList.remove("listening");
    syncHfUi();
  } else {
    hf.resume();
    syncHfUi(); // restarts the mic loop if it should listen
  }
});

// ============================================================
//  COMMAND CENTER DASHBOARD  (pure helpers live in dashboard.js)
//  - Clock + AI/Mic/Hands-Free indicators refresh once per second
//  - Launchers only ever open URLs that commands.js allowlists
//  - Recent activity holds short LABELS in memory only: no chat
//    text, no keys, nothing ever persisted
// ============================================================
const studyChip = dashQuick ? dashQuick.querySelector("[data-study]") : null;

// Short display label for an allowlisted URL (generic fallback).
function siteLabelForUrl(url) {
  const sites =
    typeof JarvisCommands !== "undefined" ? JarvisCommands.ALLOWED_SITES : {};
  for (const key of Object.keys(sites)) {
    if (sites[key] && sites[key].url === url) return sites[key].label || key;
  }
  return "site";
}

// Add a LABEL to the capped, in-memory activity list and re-render.
function logActivity(text) {
  if (typeof JarvisDashboard === "undefined") return;
  activityLog = JarvisDashboard.activityPush(
    activityLog,
    text,
    JarvisDashboard.ACTIVITY_CAP
  );
  renderActivity();
}

function renderActivity() {
  if (!dashActivity) return;
  dashActivity.textContent = "";
  if (!activityLog.length) {
    const li = document.createElement("li");
    li.className = "activity-empty";
    li.textContent = "No activity yet";
    dashActivity.appendChild(li);
    return;
  }
  for (const entry of activityLog) {
    const li = document.createElement("li");
    li.className = "activity-row";
    const t = document.createElement("span");
    t.className = "activity-time";
    t.textContent = entry.time;
    const x = document.createElement("span");
    x.className = "activity-text";
    x.textContent = entry.text;
    li.appendChild(t);
    li.appendChild(x);
    dashActivity.appendChild(li);
  }
}

// Refresh clock, status dots and the study quick-action label.
function refreshDashboard() {
  if (typeof JarvisDashboard === "undefined") return;

  const clock = JarvisDashboard.clockStrings(new Date());
  if (clockTime) clockTime.textContent = clock.time;
  if (clockDate) clockDate.textContent = clock.date;

  const hfState = !hf.enabled()
    ? "off"
    : hf.isPaused()
      ? "paused"
      : hf.state();
  const micState = !SpeechRec
    ? "unsupported"
    : isListening
      ? "listening"
      : "idle";

  const items = JarvisDashboard.statusItems({
    ai: aiState,
    api: apiState,
    mic: micState,
    handsFree: hfState,
  });
  if (dashStatus) {
    for (const item of items) {
      const li = dashStatus.querySelector('[data-key="' + item.key + '"]');
      if (!li) continue;
      const dot = li.querySelector(".dot");
      const val = li.querySelector(".v");
      if (val) val.textContent = item.text;
      if (dot) dot.className = "dot " + item.tone;
    }
  }

  // Reactor core + waveform follow the live voice state. In one-shot
  // mic mode (Hands-Free off) a running recognition session still
  // shows LISTENING so the visual never lies about the microphone.
  let visualState = hfState;
  if (!hf.enabled()) visualState = micState === "listening" ? "listening" : "off";
  const core = JarvisDashboard.coreVisual(visualState);
  if (reactorEl) reactorEl.setAttribute("data-state", core.state);
  if (waveformEl) waveformEl.setAttribute("data-state", core.state);
  if (coreStateEl) coreStateEl.textContent = core.caption;

  if (studyChip) {
    studyChip.textContent = studyMode ? "STUDY: ON" : "STUDY: OFF";
    studyChip.setAttribute("data-cmd", studyMode ? "/study off" : "/study on");
  }
}

// Quick actions run through the exact same parseCommand() path as
// typed input - nothing new can execute commands. Quiz/Revise first
// ask for a subject, then send the existing "/quiz <subject>" /
// "/revise <subject>" command through the same sendMessage() flow.
function promptStudySubject(kind) {
  const safeKind = kind === "quiz" ? "quiz" : "revise";
  const subject = window.prompt(
    safeKind === "quiz"
      ? "Which subject for a Class 9 quiz?"
      : "Which subject to revise?",
    "science"
  );
  if (subject == null) return;
  const clean = subject.trim().slice(0, 60);
  if (!clean) return;
  sendMessage("/" + safeKind + " " + clean);
}

if (dashQuick) {
  dashQuick.addEventListener("click", (e) => {
    const btn = e.target.closest ? e.target.closest("button") : null;
    if (!btn || !dashQuick.contains(btn)) return;
    const action = btn.getAttribute("data-action");
    if (action === "quiz" || action === "revise") {
      promptStudySubject(action);
      return;
    }
    const cmd = btn.getAttribute("data-cmd");
    if (cmd) sendMessage(cmd);
  });
}

// Launcher: every open goes through commands.js siteCommand().
// Cards missing from the allowlist are hidden and can never fire.
if (dashLauncher && typeof JarvisDashboard !== "undefined") {
  const sites =
    typeof JarvisCommands !== "undefined" ? JarvisCommands.ALLOWED_SITES : {};
  const cards = JarvisDashboard.launcherCards(sites);
  const byKey = {};
  for (const card of cards) byKey[card.key] = card;

  for (const btn of dashLauncher.querySelectorAll("[data-site]")) {
    const key = btn.getAttribute("data-site");
    const card = byKey[key];
    if (!card) {
      btn.hidden = true; // not on the allowlist: never clickable
      continue;
    }
    btn.addEventListener("click", () => {
      const result = JarvisCommands.siteCommand(key);
      if (!result || result.action !== "open") return; // double guard
      logActivity("Opened " + card.label);
      try {
        window.open(result.url, "_blank", "noopener,noreferrer");
      } catch (_) {
        /* popup blocked - chat already shows the confirmation text */
      }
    });
  }
}

// Collapse / expand the Command Center (state is not persisted).
if (dashToggle && dashPanel) {
  dashToggle.addEventListener("click", () => {
    const hidden = !dashPanel.hidden;
    dashPanel.hidden = hidden;
    dashToggle.setAttribute("aria-expanded", hidden ? "false" : "true");
  });
}

// One tick per second drives the clock and the live status dots.
refreshDashboard();
setInterval(refreshDashboard, 1000);

// ============================================================
//  START-UP
// ============================================================
// Restore saved conversation (falls back to an empty chat if the
// saved data is missing, corrupted or storage is blocked).
chatHistory = loadHistory();
restoreChat();

if (!SpeechRec) {
  micBtn.title = "Voice input not supported in this browser";
  handsFreeBtn.disabled = true;
  handsFreeBtn.title = "Hands-Free Mode needs Chrome or Edge (SpeechRecognition)";
  wakeWordChk.disabled = true;
  wakeWrap.classList.add("disabled");
  setStatus("TYPING MODE (NO MIC SUPPORT)");
}
// Note: Hands-Free Mode is intentionally NEVER started here - listening
// must always begin with an explicit user click on START LISTENING.

// Warn if the page was opened as a file instead of via the server.
// Rendered but NOT saved - this notice must never enter the history.
if (location.protocol === "file:") {
  renderMessage(
    "bot",
    "You opened this file directly. Please run the server and open " +
      "http://localhost:3000 so I can think (call my AI backend)."
  );
}

userInput.focus();
