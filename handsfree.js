/* ============================================================
   handsfree.js  -  Hands-Free Voice Mode state machine (zero deps)

   States (the four the UI must show):
     OFF         - hands-free disabled, NEVER listening
     LISTENING   - user-enabled, waiting for speech
     PROCESSING  - a submission was accepted, AI/command running
     SPEAKING    - JARVIS is speaking (mic loop must stay paused)

   Invariants (these are what the tests check):
   1. Listening happens ONLY after start() - never automatically,
      never while disabled (requirement: never secretly listen).
   2. shouldListen() is false during PROCESSING and SPEAKING, so
      the mic loop pauses while JARVIS works or speaks, and only a
      later endProcessing()/endSpeaking() can bring it back.
   3. beginProcessing() refuses while already PROCESSING, so
      duplicate final transcripts / double submits are dropped.
   4. stop() from any state returns to OFF and clears everything.

   Wake word: extractWakeCommand() returns the command text after
   "Hey JARVIS" (or a bare "Jarvis"), "" for a bare wake phrase, or
   null when the wake word is absent. resolveWakeInput() maps a final
   transcript to the safe action (ignore / acknowledge / send) so the
   wake word itself is never forwarded to the AI in either mode.
   After a bare wake phrase, resolveWakeWindow() + wakeWindowActive()
   model the short "command window" during which the NEXT utterance is
   taken as the command (so you can say "JARVIS" then "what time is it"
   as two separate sentences) before dropping back to wake standby.

   Transcripts: collectTranscripts() splits an onresult event's
   segments into final (auto-submittable) and interim (display
   only) text, and isDuplicateFinal() guards against Chrome
   re-firing the same final within a short window.
   shouldAcceptFinal() blocks JARVIS's own spoken reply from being
   read back as a new user command, and speechWatchdogMs() bounds
   TTS playback so SPEAKING can never stick forever.

   NOTE on browser limits: this module only models intent. Actual
   recognition reliability depends on the browser (Chrome/Edge):
   speech recognition stops when the tab is hidden, the page is
   inactive or the device is locked - pause()/resume() exist so the
   UI can be honest about that instead of pretending to listen.
   ============================================================ */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.JarvisHandsFree = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const STATES = Object.freeze({
    OFF: "off",
    LISTENING: "listening",
    PROCESSING: "processing",
    SPEAKING: "speaking",
  });

  const WAKE_WORD = "hey jarvis";

  // Exact status text shown in the UI for each state.
  function statusFor(state, paused, reason) {
    if (state === STATES.LISTENING) {
      return paused ? "PAUSED - " + (reason || "SPEECH SERVICE ENDED") : "LISTENING";
    }
    if (state === STATES.PROCESSING) return "PROCESSING";
    if (state === STATES.SPEAKING) return "SPEAKING";
    return "HANDS-FREE OFF";
  }

  function createMachine() {
    let state = STATES.OFF;
    let paused = false;
    let pauseReason = "";
    let wakeWord = false;

    return {
      state: () => state,
      enabled: () => state !== STATES.OFF,
      isPaused: () => paused,
      pauseReason: () => pauseReason,
      wakeWordEnabled: () => wakeWord,
      setWakeWord(on) {
        wakeWord = !!on;
      },
      status: () => statusFor(state, paused, pauseReason),

      // The ONLY way to start listening (user presses Start Listening).
      start() {
        if (state !== STATES.OFF) return false; // no double start
        state = STATES.LISTENING;
        paused = false;
        pauseReason = "";
        return true;
      },

      // Stop Listening - allowed from ANY state, always ends at OFF.
      stop() {
        if (state === STATES.OFF) return false;
        state = STATES.OFF;
        paused = false;
        pauseReason = "";
        return true;
      },

      // A submission (final voice transcript or typed message) wants
      // to run. Accepted from LISTENING or SPEAKING (speaking is
      // interrupted); refused while PROCESSING (duplicate) or OFF.
      beginProcessing() {
        if (state === STATES.OFF || state === STATES.PROCESSING) return false;
        state = STATES.PROCESSING;
        return true;
      },

      beginSpeaking() {
        if (state !== STATES.PROCESSING) return false;
        state = STATES.SPEAKING;
        return true;
      },

      // Turn finished with speech -> back to listening (if enabled).
      endSpeaking() {
        if (state !== STATES.SPEAKING) return false;
        state = STATES.LISTENING;
        return true;
      },

      // Turn finished without speech (TTS off / AI error) -> listening.
      endProcessing() {
        if (state !== STATES.PROCESSING) return false;
        state = STATES.LISTENING;
        return true;
      },

      // External pause (tab hidden, speech service ended).
      pause(reason) {
        if (state === STATES.OFF) return false;
        paused = true;
        pauseReason = String(reason == null ? "" : reason);
        return true;
      },

      resume() {
        if (state === STATES.OFF || !paused) return false;
        paused = false;
        pauseReason = "";
        return true;
      },

      // True only when the recognizer may actually run right now.
      shouldListen: () => state === STATES.LISTENING && !paused,
    };
  }

  /*
   * extractWakeCommand("Hey JARVIS, what's the time") -> "what's the time"
   * extractWakeCommand("hey jarvis")                   -> ""    (wake only)
   * extractWakeCommand("Jarvis")                       -> ""    (bare name)
   * extractWakeCommand("hello there")                  -> null  (no wake word)
   *
   * Matching rules:
   * - The prefix (hey / hi / hello / ok / okay / yo) is OPTIONAL, so a
   *   bare "Jarvis" activates too - the name alone is distinctive enough.
   * - When a prefix IS present a real separator is required after it, so
   *   concatenated "heyjarvis" can never activate.
   * - The name must be a standalone word (word boundary on both sides),
   *   so substrings inside larger words never match.
   * - Common speech-recognition spellings are accepted
   *   (jarvis / jarvus / jarviz / jervis / jarviss / garvis); capitali-
   *   zation and trailing punctuation are ignored (case-insensitive).
   * - The previous assistant name ("YUSU") is intentionally NOT matched:
   *   it is just ordinary speech now and passes through untouched.
   */
  const WAKE_RE =
    /\b(?:(?:hey|hi|hello|ok|okay|yo)[\s,!.\-]+)?(?:jarvis|jarvus|jarviz|jervis|jarviss|garvis)\b[\s,:.;!?-]*/i;

  function extractWakeCommand(transcript) {
    const s = String(transcript == null ? "" : transcript);
    const m = s.match(WAKE_RE);
    if (!m) return null;
    return s.slice(m.index + m[0].length).trim();
  }

  /*
   * Pure decision helper for a final transcript in Hands-Free mode.
   * Guarantees the wake word itself is NEVER sent to the AI (with the
   * wake option on OR off), and maps a bare wake phrase to a silent
   * acknowledgment instead of a submission.
   * Returns { action: "ignore" }
   *          | { action: "acknowledge" }          (bare wake word)
   *          | { action: "send", text: <cmd> }    (command to submit)
   */
  function resolveWakeInput(text, wakeEnabled) {
    const s = String(text == null ? "" : text).trim();
    if (!s) return { action: "ignore" };
    const cmd = extractWakeCommand(s);
    if (cmd === null) {
      // No wake phrase at all.
      //   wake ON  -> accidental speech: ignore (never activate).
      //   wake OFF -> normal message: send as-is.
      return wakeEnabled ? { action: "ignore" } : { action: "send", text: s };
    }
    if (!cmd) return { action: "acknowledge" }; // bare wake word, any mode
    return { action: "send", text: cmd };       // wake word stripped off
  }

  /*
   * Standby -> command window (the "say JARVIS, then your command" loop).
   * A bare wake phrase opens a short window (WAKE_COMMAND_WINDOW_MS)
   * during which the NEXT utterance is taken as the command itself, so
   * the user does not have to squeeze the wake word and command into a
   * single breath. Pure + testable - the UI only stores the window's
   * open timestamp and asks these helpers what to do.
   */
  const WAKE_COMMAND_WINDOW_MS = 8000;

  // Is the command window still open? openedAt is the timestamp of the
  // bare wake phrase (0 / null = never opened / already consumed).
  function wakeWindowActive(openedAt, now) {
    if (!openedAt) return false;
    return now - openedAt < WAKE_COMMAND_WINDOW_MS;
  }

  /*
   * Decision for a transcript that arrives while the command window is
   * open. Never returns "ignore" - the window exists to accept a command.
   * Returns { action: "reacknowledge" }  - another bare wake word (refresh)
   *          | { action: "send", text }  - the command to submit
   * A transcript WITH a wake phrase has it stripped; one WITHOUT is used
   * as-is (that is the whole point of the window).
   */
  function resolveWakeWindow(text) {
    const s = String(text == null ? "" : text).trim();
    if (!s) return { action: "reacknowledge" }; // silence: keep the window ready
    const stripped = extractWakeCommand(s);
    if (stripped === "") return { action: "reacknowledge" }; // bare wake again
    const cmd = stripped === null ? s : stripped; // no wake phrase -> as-is
    if (!cmd.trim()) return { action: "reacknowledge" };
    return { action: "send", text: cmd };
  }

  /*
   * Pure helper for SpeechRecognition onresult events.
   * Chrome (interimResults = true) finalizes longer utterances in
   * SEGMENTS, so one event can hold [final, final, interim...] - the
   * final text must still be collected even when the LAST segment is
   * interim, or recognized speech is silently never auto-submitted.
   * Returns { final, interim, hasFinal }.
   */
  function collectTranscripts(results) {
    let final = "";
    let interim = "";
    const list = results || [];
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      if (!r) continue;
      const slot = r[0];
      const t = slot && typeof slot.transcript === "string" ? slot.transcript : "";
      if (r.isFinal) final += t;
      else interim += t;
    }
    return { final: final, interim: interim, hasFinal: final.trim() !== "" };
  }

  // Identical final text repeated within this window is the same
  // utterance (Chrome re-fires finals), not a new command.
  const DUPLICATE_WINDOW_MS = 1500;

  function isDuplicateFinal(text, lastText, lastAt, now) {
    return text === lastText && now - lastAt < DUPLICATE_WINDOW_MS;
  }

  /*
   * Echo / late-final guard (Conversation Reliability).
   * A final transcript may only be accepted while the machine is in
   * LISTENING - the state where the mic is supposed to be open. A final
   * that arrives while PROCESSING is a duplicate, and one that arrives
   * while SPEAKING is JARVIS's OWN spoken reply leaking back through the
   * mic (recognition sessions are also actively stopped at claim time;
   * this guard is the safety net). With Hands-Free disabled (manual
   * one-shot mic) every final is accepted, exactly as before.
   */
  function shouldAcceptFinal(state, enabled) {
    if (!enabled) return true;
    return state === STATES.LISTENING;
  }

  /*
   * Watchdog timeout for TTS playback (ms): some browsers skip onend,
   * which would leave the machine stuck in SPEAKING forever. Bounds:
   * at least 1s, at most 30s, growing with reply length.
   */
  function speechWatchdogMs(text) {
    const n = String(text == null ? "" : text).length;
    return Math.min(30000, 1000 + n * 70);
  }

  return {
    STATES: STATES,
    WAKE_WORD: WAKE_WORD,
    DUPLICATE_WINDOW_MS: DUPLICATE_WINDOW_MS,
    WAKE_COMMAND_WINDOW_MS: WAKE_COMMAND_WINDOW_MS,
    createMachine: createMachine,
    extractWakeCommand: extractWakeCommand,
    resolveWakeInput: resolveWakeInput,
    wakeWindowActive: wakeWindowActive,
    resolveWakeWindow: resolveWakeWindow,
    collectTranscripts: collectTranscripts,
    isDuplicateFinal: isDuplicateFinal,
    shouldAcceptFinal: shouldAcceptFinal,
    speechWatchdogMs: speechWatchdogMs,
    statusFor: statusFor,
  };
});
