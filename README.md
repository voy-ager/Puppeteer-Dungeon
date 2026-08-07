# Puppeteer

*The AI director inside your game, rewriting the story while you play it.*

Built for the IBM AI Builders Challenge with IBM Bob.

---

## What this is

Puppeteer is a real-time AI Director for a horror dungeon-crawl. It doesn't generate content once and stop — it watches how a specific person plays (hesitation, backtracking, noise, proximity to danger) and continuously makes creative decisions in response: when tension should rise, when the enemy should hunt, what should be said, how the ambient soundscape should feel, and what a player's own specific playthrough meant once it's over.

The enemy is not the intelligence in this system. It's a puppet. The Director is the intelligence — everything else (the enemy's behavior, the generated narration, the reactive audio) is a hand it's pulling.

## The problem

Systems like *Left 4 Dead*'s AI Director and *Shadow of Mordor*'s Nemesis System proved over a decade ago that a live director watching the player makes games feel dramatically more alive than static, pre-scripted content. But every implementation of that idea remains locked inside a single AAA studio's proprietary engine. An indie or solo developer has no equivalent they can pick up and use — what's actually available to them is either static hand-authored content, or NPCs that chat without directing anything about pacing, threat, or story. There is a real, structural gap between "AI that generates a line of dialogue" and "AI that directs the whole experience," and almost nothing addresses it directly.

## The solution

Puppeteer is a reusable Director architecture, demonstrated inside a complete, playable horror game:

- **Telemetry** is the Director's senses — it reads room history, backtracking, idle time, noise level, and proximity to danger every frame.
- **The Director Core** is the only place decisions get made. It never touches the enemy's position or generates content directly — it only ever sets a small number of states (patrol/hunt, tension/relief) that everything else reacts to.
- **The Narrative Engine** is the Director's voice — a Node/Express backend that turns live telemetry into short, tone-consistent narration via IBM Granite on watsonx.ai, pre-generated into a pool so a live API call never blocks gameplay.
- **The Recap Generator** is the Director's memory — at the end of a session (escape or capture), it synthesizes the specific shape of that playthrough into a short, personalized closing narrative that exists only because of the choices that player made.

Every additional system — hiding spots, a throwable distraction, a probabilistic enemy that occasionally investigates a hiding spot you've used before, a skeletal Mixamo character replacing an earlier procedural rig — was built by plugging into the Director's existing decision points rather than adding parallel logic. That discipline is the actual architectural claim of this project: a small number of well-defined hooks, not a tangle of special cases.

## How this fits the challenge

| Challenge's solution area | How Puppeteer fits |
|---|---|
| **AI creative partners** | The Director is a continuous decision-maker, not a one-shot generator — it co-authors the moment-to-moment experience alongside the player |
| **Storytelling and content creation tools** | The Narrative Engine generates context-aware narrative content live, shaped by what actually happened in play |
| **Multimedia and multimodal experiences** | 3D visuals, procedurally generated reactive audio, and AI-generated text, all driven by one shared state |
| **Interactive media and storytelling experiences** | An interactive story authored live, not pre-written |
| **Personalized creative assistants** | The Recap Generator turns one specific playthrough into a personal narrative artifact no one else's session will produce |
| **Creative tools for games, virtual worlds, and immersive media** | The Director architecture is deliberately reusable — an indie developer could drop it into their own game |

**How can AI act as a creative partner rather than simply a content generator?** This is Puppeteer's central thesis: a generator produces one output per request and stops. The Director never stops — it makes ongoing creative decisions throughout the entire experience, the same way a live game master or an editor watching a rough cut makes continuous judgment calls, not a single output.

## Features

- Full multi-room 3D dungeon (Three.js/WebGL) with real wall collision, dynamic flashlight lighting, and atmospheric fog
- A skeletal, professionally animated antagonist (Mixamo FBX, four blended animation states: idle, walk, run, crawl) driven entirely by Director decisions
- Telemetry-driven escalation via two independent pathways — comfort-based (idle/backtracking) and noise-based (player-controlled via a sneak modifier)
- A real fail state: proximity capture during a hunt ends the session; outlasting the hunt's timer is how you survive
- A locked final chamber requiring a key from an NPC — the dungeon has an actual objective, not just a walk to the end
- Hiding spots offering real but imperfect safety — the enemy occasionally, probabilistically investigates a spot the player has used before
- A throwable distraction that redirects a patrolling enemy or interrupts an active hunt
- Fully procedural horror audio (Web Audio API): a continuous low ambient drone that intensifies with proximity during a hunt, a heartbeat that quickens as danger closes in, a one-shot stinger at the moment of escalation, and sparse, randomized environmental one-shots (creaks, knocks, scrapes) during calm patrol — no licensed audio assets
- Live AI-generated narration (IBM Granite via watsonx.ai) at every dramatic beat, and a personalized end-of-session recap reflecting the actual playthrough's statistics
- A live debug overlay and a Director on/off toggle (`O` key) for direct before/after comparison

## Architecture

```
Browser (Three.js client)
├── Telemetry Collector      → reads player state every frame
├── Director Core            → the only decision-maker; sets enemy/tension state
├── Enemy / NPC / Hiding /   → execute what the Director decides;
│   Distraction                never decide anything themselves
├── Procedural Audio         → reacts to Director state in real time
└── Narrative UI             → displays lines fetched from the backend

Node/Express backend (/server)
├── Interpreter    → game state → beat type
├── Prompt Builder → beat type + context → Granite prompt
├── watsonx Client → IAM token exchange + Granite text generation
├── Quality Check  → validation, retry, fallback (never blocks the game)
└── Content Pool   → pre-generated lines, refilled on a scheduler
```

The game client never calls Granite directly or waits on a live request — every narrative line is pre-generated into a pool ahead of time, which is what allows a slow, real API call to coexist with a game loop that must never stutter.

## How IBM Bob was used

Bob was the primary development tool for every system in this project beyond the initial architecture design. The workflow, consistently applied: a detailed specification (file map, exact function signatures, exact constants) was written and reviewed before implementation, Bob built the code in Plan → Code (and, for changes spanning multiple systems at once, Orchestrator) mode, and the resulting code was reviewed and tested before being trusted.

Concrete examples of real bugs Bob diagnosed and fixed from actual runtime behavior, not just written to spec:
- A missing IAM token exchange step causing every watsonx.ai call to fail with a cryptic "key not found" error
- A rate-limit collision from firing all narrative pool refills simultaneously on startup
- A race condition in the heartbeat audio system that could let one stray beat fire after a hunt ended
- A thin-wall collision tunneling bug allowing a sprinting player to pass through a locked door in a single frame
- An LLM instruction-leakage bug where Granite echoed prompt formatting rules back as narrative text
- Mixamo root-motion baked into animation clips fighting the game's own manual position control, causing a walk-cycle stutter

## Tech stack

- **Client:** Three.js (r128), vanilla JavaScript, Web Audio API — no build step, no framework
- **Backend:** Node.js, Express
- **AI:** IBM Granite (`ibm/granite-3-8b-instruct`) via watsonx.ai
- **Character animation:** Mixamo (Adobe), loaded via Three.js FBXLoader
- **Development:** IBM Bob (primary), IBM SkillsBuild

## Running it locally

Two servers, running at the same time:

```bash
# Terminal 1 — the Narrative Engine backend
cd server
npm install
npm start          # listens on :3001

# Terminal 2 — the game itself, from the project root
python -m http.server 8000
```

Open `http://localhost:8000`. The game will run without the backend, silently falling back to hardcoded narration lines — the backend is required only for live Granite-generated narrative.

### Backend environment variables

Copy `.env.example` to `.env` inside `/server` and fill in:

```
WATSONX_API_KEY=your_ibm_cloud_api_key
WATSONX_PROJECT_ID=your_watsonx_project_id
WATSONX_URL=https://us-south.ml.cloud.ibm.com   # or your region's endpoint
```

`.env` is git-ignored — never commit real credentials.

## Controls

| Key | Action |
|---|---|
| WASD | Move |
| Mouse | Look |
| Shift | Sneak (slower, quieter) |
| E | Hide (near a hiding spot) |
| Q | Throw a distraction |
| T | Toggle debug overlay |
| O | Toggle the Director on/off |
| R | Manually trigger the end-of-session recap |
| Esc | Pause |

## Security

No secrets are committed to this repository. The only credential in use (an IBM Cloud API key for watsonx.ai) lives in a local, git-ignored `.env` file. `.env.example` documents the required variable names with no real values. The client never calls watsonx.ai directly — all Granite requests are proxied through the backend, so no API key is ever exposed to the browser.

## Status

All planned systems are complete and tested: dungeon, telemetry, Director escalation (comfort- and noise-based), narrative generation, capture/escape endings, NPC key and locked door, hiding, distraction, procedural audio, and the skeletal Mixamo enemy with corrected animation.