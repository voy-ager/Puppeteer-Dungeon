/**
 * narrativeUI.js — Day 14 scope
 *
 * The bridge between the Director's decisions and the Narrative Engine
 * backend (built Days 12-13). This file does exactly two things:
 *   1. Ask the backend for a line of a given beat type
 *   2. Display it as a fading on-screen subtitle
 *
 * It never decides WHEN to speak — director.js calls showNarrativeLine()
 * at the moments it decides matter (hunt starts, hunt ends, ambient
 * check-ins). Keeping that boundary means narrative logic lives in
 * exactly one place, same principle as the enemy movement boundary.
 *
 * Failure handling: if the backend is down or slow, this fails silently
 * (console warning only) — a missing subtitle should never break or
 * pause the game itself.
 */

const NARRATIVE_API_BASE = 'http://localhost:3001/api/narrative';

Game.narrativeUI = {
  element: null,
  hideTimeout: null,
  requestId: 0, // incremented per request; used to discard stale/out-of-order responses
};

function initNarrativeUI() {
  Game.narrativeUI.element = document.getElementById('narrative-subtitle');
}

/**
 * Requests one line of the given beat type from the Narrative Engine and
 * displays it once it arrives. Fire-and-forget by design — this is called
 * from inside the game loop and must never be awaited there.
 */
function showNarrativeLine(beatType) {
  const thisRequestId = ++Game.narrativeUI.requestId;

  fetch(`${NARRATIVE_API_BASE}/next?type=${beatType}`)
    .then((res) => res.json())
    .then((data) => {
      // If a newer request has been issued since this one went out, ignore
      // this response — otherwise a slow ambient line could overwrite a
      // hunt_taunt that started after it but resolved first.
      if (thisRequestId !== Game.narrativeUI.requestId) return;
      if (data && data.line) displaySubtitle(data.line);
    })
    .catch((err) => {
      // Backend not running, network hiccup, etc. — log only, never throw.
      console.warn('[Narrative] fetch failed:', err.message);
    });
}

function displaySubtitle(text) {
  const el = Game.narrativeUI.element;
  if (!el) return;

  clearTimeout(Game.narrativeUI.hideTimeout);

  el.textContent = text;
  el.classList.add('visible');

  Game.narrativeUI.hideTimeout = setTimeout(() => {
    el.classList.remove('visible');
  }, 5000);
}