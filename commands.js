/* ============================================================
   commands.js  -  Safe Quick Commands for JARVIS (zero deps)

   Security rules (never broken):
   - Website commands only ever resolve to the hardcoded HTTPS
     allowlist below. No other URL is ever produced or opened.
   - No shell commands, no eval, no dynamic code, no fetch of
     user-supplied URLs - this module is pure text in / text out.
   - Time and date come from the user's own browser clock.

   Works in two environments:
   - Browser: window.JarvisCommands
   - Node (tests): require("./commands.js")
   ============================================================ */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.JarvisCommands = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // The ONLY websites that can ever be opened. Frozen so nothing
  // at runtime can add, change or remove an entry.
  const ALLOWED_SITES = Object.freeze({
    google: Object.freeze({ url: "https://www.google.com/", label: "Google" }),
    youtube: Object.freeze({ url: "https://www.youtube.com/", label: "YouTube" }),
    instagram: Object.freeze({ url: "https://www.instagram.com/", label: "Instagram" }),
    wikipedia: Object.freeze({ url: "https://www.wikipedia.org/", label: "Wikipedia" }),
  });

  const HELP_TEXT =
    "Quick Commands: " +
    "/time - local time · " +
    "/date - today's date · " +
    "/open google | youtube | instagram | wikipedia - open an allowed site · " +
    "/study on | off - toggle Class 9 Study Mode · " +
    "/explain <topic> - Class 9 explanation · " +
    "/quiz <subject> - start a quiz · " +
    "/revise <subject> - quick revision · " +
    "/help - show this list. " +
    "Anything else is answered by the AI as usual.";

  function normalize(text) {
    return String(text == null ? "" : text)
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  }

  function formatTime(date) {
    try {
      return date.toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch (_) {
      return date.toTimeString().slice(0, 8);
    }
  }

  function formatDate(date) {
    try {
      return date.toLocaleDateString(undefined, {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      });
    } catch (_) {
      return date.toDateString();
    }
  }

  // Look a name up in the allowlist. Returns an "open" result only
  // for exact matches (after normalization); anything else -> null.
  function siteCommand(name) {
    const key = normalize(name);
    const site = Object.prototype.hasOwnProperty.call(ALLOWED_SITES, key)
      ? ALLOWED_SITES[key]
      : null;
    if (!site) return null;
    return {
      action: "open",
      url: site.url,
      text: "Opening " + site.label + " (" + site.url + ") in a new tab.",
    };
  }

  function aiResult(message, studyMode) {
    return {
      action: "ai",
      message: String(message == null ? "" : message).trim(),
      mode: studyMode ? "study" : "default",
    };
  }

  /*
   * parseCommand(input, state) -> result
   *   state = { studyMode: boolean, now?: () => Date }
   *
   *   { action: "reply",  text, studyMode? }  - terminal command; show text in chat
   *   { action: "open",   url, text }         - terminal command; open allowlisted url
   *   { action: "ai",     message, mode }     - send to /api/ask ("default" | "study")
   *
   * Unknown "/something" commands return an "reply" result (never AI).
   */
  function parseCommand(input, state) {
    state = state || {};
    const now = typeof state.now === "function" ? state.now : function () { return new Date(); };
    const studyMode = !!state.studyMode;
    const raw = String(input == null ? "" : input);
    const text = normalize(raw);
    if (!text) return aiResult(raw, studyMode);

    // ---------- time ----------
    if (
      /^\/?time$/.test(text) ||
      /^\/?what(?:'s| is)? (the )?time( is it)?( now)?\??$/.test(text)
    ) {
      return { action: "reply", text: "The local time is " + formatTime(now()) + "." };
    }

    // ---------- date ----------
    if (
      /^\/?date$/.test(text) ||
      /^\/?what(?:'s| is)? (today'?s? )?(the )?date( today)?\??$/.test(text)
    ) {
      return { action: "reply", text: "Today is " + formatDate(now()) + "." };
    }

    // ---------- open website (HTTPS allowlist only) ----------
    let m = text.match(/^\/open\s+(\S+)$/);
    if (m) {
      const site = siteCommand(m[1]);
      return site || {
        action: "reply",
        text:
          "I can only open these websites: Google, YouTube, Instagram, Wikipedia. " +
          "Example: /open youtube",
      };
    }
    m = text.match(/^open (google|youtube|instagram|wikipedia)$/);
    if (m) return siteCommand(m[1]);

    // ---------- study mode toggle ----------
    if (text === "/study on" || text === "/study off") {
      const on = text === "/study on";
      return {
        action: "reply",
        studyMode: on,
        text: on
          ? "Study Mode ON - I will answer as a Class 9 tutor. " +
            "Try /explain <topic>, /quiz <subject>, /revise <subject>, " +
            "or just ask a question. Use /study off to go back to normal."
          : "Study Mode OFF - back to normal assistant mode.",
      };
    }

    // ---------- one-shot study commands ----------
    m = raw.trim().match(/^\/(explain|quiz|revise)\s+(.+)$/i);
    if (m) {
      const kind = m[1].toLowerCase();
      const topic = m[2].trim().slice(0, 200);
      if (!topic) return { action: "reply", text: "Tell me what to " + kind + ". Example: /quiz science" };
      if (kind === "explain") {
        return {
          action: "ai",
          mode: "study",
          message:
            'Explain "' + topic + '" for a Class 9 student in simple language, ' +
            "with one everyday example and a short summary at the end.",
        };
      }
      if (kind === "quiz") {
        return {
          action: "ai",
          mode: "study",
          message:
            "Ask me one Class 9 quiz question about " + topic + " with four " +
            "options labeled A, B, C, D. Wait for my answer, then tell me " +
            "whether it is correct and why. Start now with the first question.",
        };
      }
      return {
        action: "ai",
        mode: "study",
        message:
          "Give me a quick Class 9 revision of " + topic + ": exactly 5 short " +
          "bullet points I should memorize before a test.",
      };
    }

    // ---------- help / unknown commands ----------
    if (text === "/help" || text === "help commands" || text === "quick commands") {
      return { action: "reply", text: HELP_TEXT };
    }
    if (text.charAt(0) === "/") {
      return {
        action: "reply",
        text:
          'Unknown command: "' + text.split(" ")[0] + '". ' +
          "Type /help to see the list of Quick Commands.",
      };
    }

    // ---------- everything else: normal AI chat ----------
    return aiResult(raw.trim(), studyMode);
  }

  return {
    parseCommand: parseCommand,
    siteCommand: siteCommand,
    formatTime: formatTime,
    formatDate: formatDate,
    ALLOWED_SITES: ALLOWED_SITES,
    HELP_TEXT: HELP_TEXT,
  };
});
