/* ============================================================
   dashboard.js  -  Command Center helpers (zero deps, pure)

   Everything here is text-in / text-out and side-effect free so the
   tests can run it in Node. The browser wiring lives in script.js.

   Security / privacy rules:
   - Launcher cards NEVER build URLs from input; they only read the
     frozen HTTPS allowlist passed in from commands.js, and any
     entry that is not https:// is dropped.
   - Activity entries are short LABELS only ("Opened YouTube",
     "Ran /time"). They never contain chat message text, API keys,
     .env values or other personal data, and the list is capped.
   - No eval, no dynamic code, no network calls in this module.

   Works in two environments:
   - Browser: window.JarvisDashboard
   - Node (tests): require("./dashboard.js")
   ============================================================ */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.JarvisDashboard = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const ACTIVITY_CAP = 6;        // small panel: never more than this many rows
  const ACTIVITY_TEXT_LEN = 60;  // per-row cap

  // Launcher card order shown in the Command Center.
  const LAUNCH_ORDER = Object.freeze(["google", "youtube", "instagram", "wikipedia"]);

  // ---------- live local clock (browser time, injectable for tests) ----------
  function clockStrings(date) {
    const d = date instanceof Date ? date : new Date(date);
    let time, day;
    try {
      time = d.toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch (_) {
      time = d.toTimeString().slice(0, 8);
    }
    try {
      day = d.toLocaleDateString(undefined, {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      });
    } catch (_) {
      day = d.toDateString();
    }
    return { time: time, date: day };
  }

  // ---------- status indicator descriptors ----------
  // state = { ai, mic, handsFree, api } - each is a short symbolic name,
  // never raw error text or anything that could carry a secret.
  // "api" reports ONLY what the client actually observed from /api/ask:
  //   standby     - no request made yet (claims nothing about the key)
  //   online-ai   - last response came back with mode "ai" (Gemini answered)
  //   online-local- last response came back with mode "local" (offline engine)
  //   error       - the last request failed / timed out
  function statusItems(state) {
    state = state || {};
    const ai = state.ai || "ready";
    const mic = state.mic || "idle";
    const hfState = state.handsFree || "off";
    const api = state.api || "standby";

    const aiMap = {
      ready: { text: "READY", tone: "on" },
      thinking: { text: "THINKING", tone: "busy" },
      gemini: { text: "GEMINI ONLINE", tone: "on" },
      local: { text: "LOCAL REPLIES", tone: "busy" },
      error: { text: "ERROR", tone: "off" },
    };
    const apiMap = {
      standby: { text: "STANDBY", tone: "idle" },
      "online-ai": { text: "ONLINE \u00b7 AI", tone: "on" },
      "online-local": { text: "ONLINE \u00b7 LOCAL", tone: "busy" },
      error: { text: "ERROR", tone: "off" },
    };
    const micMap = {
      listening: { text: "LISTENING", tone: "busy" },
      idle: { text: "IDLE", tone: "idle" },
      unsupported: { text: "NOT SUPPORTED", tone: "off" },
    };
    const hfMap = {
      off: { text: "OFF", tone: "idle" },
      paused: { text: "PAUSED", tone: "idle" },
      listening: { text: "LISTENING", tone: "on" },
      processing: { text: "PROCESSING", tone: "busy" },
      speaking: { text: "SPEAKING", tone: "speak" },
    };

    const aiItem = aiMap[ai] || aiMap.ready;
    const apiItem = apiMap[api] || apiMap.standby;
    const micItem = micMap[mic] || micMap.idle;
    const hfItem = hfMap[hfState] || hfMap.off;

    return [
      { key: "ai", label: "AI", text: aiItem.text, tone: aiItem.tone },
      { key: "api", label: "API", text: apiItem.text, tone: apiItem.tone },
      { key: "mic", label: "MIC", text: micItem.text, tone: micItem.tone },
      { key: "handsfree", label: "HANDS-FREE", text: hfItem.text, tone: hfItem.tone },
    ];
  }

  // ---------- reactor core / waveform visual state ----------
  // Whitelisted mapping from a Hands-Free state to the data-state token
  // used by the CSS reactor + waveform and to its visible caption.
  // Anything unknown (including hostile strings) collapses to "off".
  const CORE_STATES = Object.freeze({
    off: "STANDBY",
    paused: "PAUSED",
    listening: "LISTENING",
    processing: "THINKING",
    speaking: "SPEAKING",
  });

  function coreVisual(hfState) {
    const key =
      typeof hfState === "string" &&
      Object.prototype.hasOwnProperty.call(CORE_STATES, hfState)
        ? hfState
        : "off";
    return { state: key, caption: CORE_STATES[key] };
  }

  // ---------- quick action buttons ----------
  // Fixed commands only - each cmd is executed later through the
  // same parseCommand() path as typed input (no new code paths).
  // quiz/revise carry their bare command; the UI asks for a subject
  // first and then sends "<cmd> <subject>" through sendMessage().
  function quickActions(studyMode) {
    return [
      { key: "time", label: "/time", cmd: "/time", title: "Show local time" },
      { key: "date", label: "/date", cmd: "/date", title: "Show today's date" },
      { key: "help", label: "/help", cmd: "/help", title: "List quick commands" },
      {
        key: "study",
        label: studyMode ? "STUDY: ON" : "STUDY: OFF",
        cmd: studyMode ? "/study off" : "/study on",
        title: "Toggle Class 9 Study Mode",
      },
      {
        key: "quiz",
        label: "/quiz",
        cmd: "/quiz",
        title: "Start a Class 9 quiz (asks for a subject)",
      },
      {
        key: "revise",
        label: "/revise",
        cmd: "/revise",
        title: "Start Class 9 revision (asks for a subject)",
      },
    ];
  }

  // ---------- launcher cards ----------
  // Only names present in the given allowlist become cards, and any
  // URL that is not fixed https:// is dropped (defense in depth).
  function launcherCards(allowedSites) {
    const sites = allowedSites || {};
    const cards = [];
    for (const key of LAUNCH_ORDER) {
      const own =
        typeof sites === "object" && sites !== null &&
        Object.prototype.hasOwnProperty.call(sites, key);
      const site = own ? sites[key] : null;
      if (!site || typeof site.url !== "string") continue;
      if (site.url.indexOf("https://") !== 0) continue;
      cards.push({
        key: key,
        label: String(site.label || key),
        url: site.url,
      });
    }
    return cards;
  }

  // ---------- recent activity ----------
  // Adds a label to the list (newest first), capped and sanitized.
  // Returns a NEW array; entries are { time, text } with nothing else,
  // so no message content or secrets can accumulate here.
  function activityPush(list, text, cap, now) {
    const capNum = typeof cap === "number" && cap > 0 ? cap : ACTIVITY_CAP;
    const base = Array.isArray(list) ? list.slice() : [];
    let label = String(text == null ? "" : text).trim();
    if (!label) return base;
    label = label.replace(/\s+/g, " ").slice(0, ACTIVITY_TEXT_LEN);
    if (!label) return base;

    const stampDate = now instanceof Date ? now : new Date(now || Date.now());
    let time;
    try {
      time = stampDate.toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      });
    } catch (_) {
      time = stampDate.toTimeString().slice(0, 5);
    }

    base.unshift({ time: time, text: label });
    if (base.length > capNum) base.length = capNum;
    return base;
  }

  return {
    ACTIVITY_CAP: ACTIVITY_CAP,
    ACTIVITY_TEXT_LEN: ACTIVITY_TEXT_LEN,
    LAUNCH_ORDER: LAUNCH_ORDER,
    CORE_STATES: CORE_STATES,
    clockStrings: clockStrings,
    statusItems: statusItems,
    coreVisual: coreVisual,
    quickActions: quickActions,
    launcherCards: launcherCards,
    activityPush: activityPush,
  };
});
