# Puppeteer

*The AI director inside your game, rewriting the story while you play it.*

Built for the IBM SkillsBuild AI Builders Challenge — July 2026, "Reimagine Creative Industries with AI."

## What this is

Puppeteer is a real-time AI Director that watches how someone plays a horror
dungeon-crawl — hesitation, backtracking, health, time spent per room — and
uses that to change the game as they play it: pacing, threat placement, and
NPC dialogue all shift to match the specific player, instead of being
scripted once for everyone.

- **Problem statement:** see `docs/problem.md` (coming Week 2)
- **AI approach and architecture:** see `docs/architecture.md` (coming Week 2)
- **How IBM Bob was used:** see `docs/bob-usage.md` (coming Week 2)
- **Challenge theme:** July Challenge — Creative Industries

## Security

- No secrets exist in this repo yet — Days 2-11 are entirely client-side
  (Three.js in the browser, no API calls, nothing to leak).
- Starting Days 12-13, the Narrative Engine needs an IBM watsonx API key.
  That key will **never** be hardcoded into any `.js` file or committed —
  it goes in a local `.env` (already excluded via `.gitignore`), and
  `.env.example` documents which variables are needed without real values.
- If a watsonx API key is ever needed in the browser, it will be proxied
  through a small backend endpoint instead of being embedded in
  client-side JS — anything shipped to the browser is visible to anyone
  who opens dev tools, regardless of how it's obfuscated.
- Before every commit: skim `git status` and `git diff --staged` for
  anything that looks like a key, token, or credential before pushing.

## Project  structure 
puppeteer-dungeon/
├── index.html          # entry point — open this in a browser
├── css/
│   └── style.css       # HUD, crosshair, start overlay
├── js/
│   ├── game.js         # scene, camera, renderer, lighting, dungeon geometry
│   ├── controls.js     # pointer-lock mouse look + WASD movement + collision
│   ├── enemy.js        # patrol/hunt movement
│   ├── telemetry.js    # tracks player behavior — the Director's "senses"
│   ├── director.js     # the Director Core — decides patrol vs hunt
│   └── main.js         # ties it together, animation loop
└── .env.example         # template for future watsonx credentials (Days 12-13)

## Running it locally

No build step, no npm install — it's plain HTML/JS with Three.js loaded
from a CDN. Just open `index.html` directly in a browser, or for the most
reliable experience (pointer lock works better over http:// than file://),
serve it with any simple local server, e.g.:

python -m http.server 8000

then visit `http://localhost:8000`.

## Status

- [x] Days 1-3 — repo scaffold, first-person scene, flashlight, movement
- [x] Days 4-5 — multi-room dungeon, real wall collision, patrol enemy
- [x] Days 8-9 — telemetry collector + live debug overlay
- [x] Days 10-11 — Director Core (patrol/hunt escalation + relief cooldown)
- [ ] Days 12-13 — Narrative Engine (Granite + LangFlow)
- [ ] Day 14 — full end-to-end wiring
- [ ] Day 15 — Recap Generator
- [ ] Days 16-17 — atmospheric polish, Director on/off toggle
- [ ] Days 18-20 — demo video, submission