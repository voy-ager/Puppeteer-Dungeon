/**
 * audio.js — Procedural horror soundscape
 *
 * Everything here is generated live from the Web Audio API — no external
 * audio files, no CDN dependencies, no licensing concerns. Three layers:
 *
 *   1. Ambient drone  — two low oscillators (55 Hz sine root, 62 Hz triangle)
 *      through a lowpass filter into masterGain. The triangle serves as the
 *      pitch-bend target during hunts — it climbs to 90 Hz at max intensity,
 *      staying low enough to feel connected to the bed rather than a separate
 *      melody. The drone is intentionally quiet (gain 0.08–0.35) so it reads
 *      as subtext, not music.
 *
 *   2. Sparse environmental sounds — intermittent one-shots (creak, knock,
 *      scrape) scheduled randomly every 15–40 seconds. Each is built from
 *      fresh nodes per play, self-terminating via envelope decay, panned
 *      randomly for spatial variety. Silenced automatically during hunts
 *      so they don't compete with the heartbeat and stinger.
 *
 *   3. Heartbeat      — a rhythmic low thump that plays only during hunts,
 *      speeding up as the enemy closes in. Each thump is a fresh short-lived
 *      oscillator node (not a gated persistent one — see scheduleBeat() for
 *      why that distinction matters).
 *
 *   4. Hunt stinger   — a one-shot transient the instant a hunt begins:
 *      a pitch-dropping tone plus a burst of filtered noise, both fading out
 *      in under a third of a second.
 *
 * AudioContext is created lazily on the first user interaction — browsers
 * block audio construction before any click or keypress. Every exported
 * function is wrapped in try/catch so an audio failure can never break
 * gameplay. Audio is atmosphere; it must never be a dependency.
 */

// ---------------------------------------------------------------------------
// Game.audio — persistent node references and heartbeat state
// ---------------------------------------------------------------------------

Game.audio = {
  ctx: null,          // AudioContext — null until initAudio() is called
  masterGain: null,   // final output bus, fixed low volume (0.28)

  // Drone — two oscillators created once in startAmbientDrone(), live until page unload.
  // index 0: 55 Hz sine (root tone)
  // index 1: 62 Hz triangle — pitch-bend target during hunts (was index 3 in the
  //           old 4-oscillator version; reduced to 1 after removing 56.5 and 58 Hz)
  droneOscillators: [],
  droneGain:   null, // GainNode — volume target for setDroneIntensity()
  droneFilter: null, // BiquadFilterNode — cutoff also modulated by intensity

  // Heartbeat — scheduler state
  heartbeatActive: false,
  heartbeatTimeout: null,  // ID of the CURRENTLY pending setTimeout.
                           // overwritten on every reschedule so stopHeartbeat()
                           // always cancels the next-pending beat, not a stale one.
  heartbeatInterval: 1100, // ms between beats; recalculated per-beat from distance

  // Sparse ambient events — one-shot environmental sounds (creak, knock, scrape)
  ambientEventsActive: false,
  ambientEventTimeout: null, // pending setTimeout ID; overwrite-every-time pattern,
                             // same as heartbeatTimeout above

  // Reusable noise buffer — generated once at init, used by playStinger() and playFaintScrape()
  noiseBuffer: null,
};

// ---------------------------------------------------------------------------
// initAudio() — called once from main.js on the start-overlay click
// ---------------------------------------------------------------------------

/**
 * Creates the AudioContext and shared infrastructure. Safe to call on every
 * click — the guard on ctx means subsequent calls are no-ops.
 *
 * The AudioContext must be created inside a user-gesture handler (click,
 * keydown) — browsers suspend or refuse to create contexts created before
 * any interaction. The start-overlay click in main.js is the natural place
 * because it's the first deliberate action the player takes.
 */
function initAudio() {
  try {
    if (Game.audio.ctx) return; // already initialised

    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    Game.audio.ctx = ctx;

    // Single master output bus. Gain of 0.28 caps the total audio level —
    // the drone and heartbeat have their own gain stages that go up to ~0.95,
    // but multiplying through here keeps the soundscape from overwhelming
    // the narration subtitles or startling a player wearing headphones.
    const master = ctx.createGain();
    master.gain.value = 0.28;
    master.connect(ctx.destination);
    Game.audio.masterGain = master;

    // Pre-generate a 1-second white-noise buffer used by playStinger().
    // One second is long enough to replay as a burst; short enough to fit
    // in memory without concern. Generated once here rather than per-stinger
    // call because createBuffer + random fill has real cost.
    const sampleRate  = ctx.sampleRate;
    const noiseBuffer = ctx.createBuffer(1, sampleRate, sampleRate);
    const data        = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = Math.random() * 2 - 1; // uniform white noise, range [-1, 1]
    }
    Game.audio.noiseBuffer = noiseBuffer;

    // Warm the drone immediately — by the time the player has locked the
    // pointer and is moving, the oscillators are already running at low level.
    startAmbientDrone();

    // Start the sparse ambient event scheduler. The first event fires after a
    // random 15–40s delay, so there is no sound immediately on click.
    startAmbientEvents();

  } catch (e) {
    console.warn('[audio] initAudio failed — audio disabled for this session:', e);
  }
}

// ---------------------------------------------------------------------------
// Part 2 — Ambient drone
// ---------------------------------------------------------------------------

/**
 * startAmbientDrone — creates the two-oscillator drone chain and starts it.
 *
 * Full node graph (simplified from the previous 4-oscillator version):
 *
 *   osc[0] sine     55.0 Hz ──┐
 *   osc[1] triangle 62.0 Hz ──┴──► droneGain ──► droneFilter ──► masterGain
 *
 * Why two oscillators instead of four?
 * The previous 55/56.5/58/62 Hz cluster produced complex beating patterns, but
 * at the new quieter gain range (0.08–0.35) much of that texture was inaudible.
 * Two oscillators at 55 and 62 Hz still produce a slow 7 Hz beat that reads as
 * organic without the CPU overhead of idle oscillators contributing nothing.
 * The 62 Hz triangle is kept specifically because it is the pitch-bend target
 * during hunts — that behaviour is unchanged; only the index changed from 3 to 1.
 *
 * Why remove the dry/wet distortion split and dissonant layer?
 * Both were designed for a louder, more prominent drone. At the new quieter
 * baseline they would be inaudible at low intensity and jarring if they surfaced
 * at high intensity against an otherwise sparse soundscape. The sparse ambient
 * event system (creak/knock/scrape) provides textural variety instead, without
 * the constant CPU cost of live oscillators and a WaveShaperNode.
 */
function startAmbientDrone() {
  try {
    const a = Game.audio;
    if (!a.ctx || a.droneOscillators.length > 0) return; // guard double-init

    const ctx = a.ctx;

    // --- Drone gain ---
    // Initial value matches the quiet floor of setDroneIntensity (level=0 → 0.08).
    const droneGain = ctx.createGain();
    droneGain.gain.value = 0.08;
    a.droneGain = droneGain;

    // --- Lowpass filter ---
    // Cutoff starts at 120 Hz (level=0 in setDroneIntensity). Opens to 320 Hz
    // at full intensity so the drone's character changes with danger level.
    const droneFilter = ctx.createBiquadFilter();
    droneFilter.type            = 'lowpass';
    droneFilter.frequency.value = 120;
    droneFilter.Q.value         = 0.8;
    a.droneFilter = droneFilter;

    // Direct connection: droneFilter → masterGain (no dry/wet split).
    droneGain.connect(droneFilter);
    droneFilter.connect(a.masterGain);

    // --- Oscillators ---
    // osc[0] = 55 Hz sine (root tone, always present)
    // osc[1] = 62 Hz triangle (pitch-bend target during hunts — was index 3 in
    //          the old 4-oscillator array; now index 1 after removing 56.5 and
    //          58 Hz. All references to droneOscillators[3] updated to [1].)
    const specs = [
      { type: 'sine',     freq: 55.0 },
      { type: 'triangle', freq: 62.0 }, // index 1 — pitch-bend target during hunts
    ];
    for (const { type, freq } of specs) {
      const osc = ctx.createOscillator();
      osc.type            = type;
      osc.frequency.value = freq;
      osc.connect(droneGain);
      osc.start();
      a.droneOscillators.push(osc);
    }

  } catch (e) {
    console.warn('[audio] startAmbientDrone failed:', e);
  }
}

/**
 * setDroneIntensity — smoothly shift the drone's volume and filter brightness.
 *
 * @param {number} level          0–1. 0 = barely audible, 1 = full presence.
 * @param {number} rampDuration   Seconds for the transition (default 2.0).
 *
 * The rampDuration MUST match the interval at which this function is called.
 * Each call to linearRampToValueAtTime schedules a new automation curve that
 * replaces the previous one. If a new ramp begins before the old one finishes,
 * the interrupted ramp produces an audible step or click at the interruption
 * point — the exact artifact the ramp was meant to prevent. The solution is
 * simple: pass a rampDuration equal to the call interval so each ramp
 * completes naturally before the next one begins.
 *
 *   Patrol/relief calls: interval 2.0s → rampDuration default 2.0 ✓
 *   Hunt-state calls:    interval 0.4s → rampDuration 0.4 passed explicitly ✓
 */
function setDroneIntensity(level, rampDuration = 2.0) {
  try {
    const a = Game.audio;
    if (!a.ctx || !a.droneGain) return;

    const clamped = Math.max(0, Math.min(1, level));
    const now     = a.ctx.currentTime;
    const rampEnd = now + rampDuration;

    // --- Drone volume ---
    // Gain range reduced to [0.08, 0.35] — the drone is now background texture,
    // not a prominent musical element. The sparse environmental sounds provide
    // moment-to-moment variety; the drone just establishes "something is here."
    a.droneGain.gain.linearRampToValueAtTime(0.08 + clamped * 0.27, rampEnd);

    // --- Filter cutoff: 0 → 120 Hz (muffled) to 1 → 320 Hz (more present) ---
    a.droneFilter.frequency.linearRampToValueAtTime(120 + clamped * 200, rampEnd);

    // --- Pitch-bend on the 62 Hz triangle oscillator (index 1) ---
    // Index changed from 3 to 1 after reducing to a 2-oscillator array.
    // Climbs from 62 Hz (at level 0) to 90 Hz (at level 1) — a noticeable
    // rise that stays within the drone's low-frequency register so it reads
    // as growing tension rather than the start of a melody.
    if (a.droneOscillators[1]) {
      a.droneOscillators[1].frequency.linearRampToValueAtTime(62 + clamped * 28, rampEnd);
    }

  } catch (e) {
    console.warn('[audio] setDroneIntensity failed:', e);
  }
}

// ---------------------------------------------------------------------------
// Part 3 — Heartbeat
// ---------------------------------------------------------------------------

/**
 * scheduleBeat — internal, self-rescheduling function that fires each thump.
 *
 * Why create fresh nodes per beat rather than gating a persistent oscillator?
 * A persistent oscillator silenced by setting gain to 0 causes a waveform
 * discontinuity at the exact sample where the gain cuts — audible as a small
 * click. The correct fix is to ramp the gain, but that adds tail latency.
 * Creating a short-lived node and letting it decay naturally (via exponential
 * ramp to near-zero, then stop()) avoids the problem entirely and is actually
 * cheaper in aggregate because idle oscillators still consume DSP time.
 *
 * Every call to setTimeout here overwrites Game.audio.heartbeatTimeout with
 * the new ID. This is load-bearing: stopHeartbeat() calls clearTimeout on
 * that ID to cancel the NEXT pending beat. If we only stored the initial ID
 * from startHeartbeat(), clearTimeout would target a stale handle and one
 * extra beat could fire after the hunt ends.
 */
function scheduleBeat() {
  const a = Game.audio;
  if (!a.heartbeatActive || !a.ctx) return;

  try {
    const ctx = a.ctx;
    const now = ctx.currentTime;

    // Fresh oscillator + gain for this single thump
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();

    // 60 Hz: sits in the body-resonance range — felt as a thud in the chest.
    // Low enough to blend with the drone bed without competing with it.
    osc.type            = 'sine';
    osc.frequency.value = 60;

    osc.connect(gain);
    gain.connect(a.masterGain);

    // Envelope: near-instant attack so the thump hits hard, not swells.
    // Exponential decay (not linear) because acoustic thuds die away faster
    // at first then tail out — linear decay sounds artificial by comparison.
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.7, now + 0.005);  // 5ms attack
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15); // 150ms decay

    osc.start(now);
    osc.stop(now + 0.16); // release node slightly after decay completes

    // Reschedule next beat. Store the new ID — not the previous one — so
    // stopHeartbeat() always cancels the currently-pending beat.
    a.heartbeatTimeout = setTimeout(scheduleBeat, a.heartbeatInterval);

  } catch (e) {
    console.warn('[audio] scheduleBeat failed:', e);
    // Re-arm even on error so a transient glitch doesn't silence the heartbeat
    // for the rest of the hunt. If audio is broken, the warn above makes that
    // visible without halting the scheduler loop.
    if (a.heartbeatActive) {
      a.heartbeatTimeout = setTimeout(scheduleBeat, a.heartbeatInterval);
    }
  }
}

/** Start the heartbeat. Called from startHunt() in director.js. */
function startHeartbeat() {
  try {
    const a = Game.audio;
    if (!a.ctx) return;
    a.heartbeatActive  = true;
    a.heartbeatInterval = 1100; // reset to slowest pace — distance hasn't been read yet
    scheduleBeat(); // fire the first beat immediately; it will reschedule itself
  } catch (e) {
    console.warn('[audio] startHeartbeat failed:', e);
  }
}

/**
 * Stop the heartbeat. Called from endHunt() in director.js.
 *
 * Sets heartbeatActive = false first so scheduleBeat's reschedule guard
 * triggers, then clears the pending timeout to prevent any already-queued
 * beat from firing. Order matters: flag first, then clearTimeout, so there's
 * no race window where scheduleBeat could re-arm after the clearTimeout.
 */
function stopHeartbeat() {
  try {
    const a = Game.audio;
    a.heartbeatActive = false;
    if (a.heartbeatTimeout !== null) {
      clearTimeout(a.heartbeatTimeout);
      a.heartbeatTimeout = null;
    }
  } catch (e) {
    console.warn('[audio] stopHeartbeat failed:', e);
  }
}

/**
 * updateHeartbeatTempo — recalculate the interval between beats from distance.
 * Called every frame by updateDirector() while hunting.
 *
 * The new interval takes effect on the NEXT beat reschedule — it doesn't
 * interrupt a beat already in flight, which is exactly right. Abruptly
 * rescheduling mid-beat would cause irregular gaps that sound wrong.
 *
 * Distance mapping:
 *   >= 10m (or null) → 1100ms  (slow, ominous)
 *   <= 1.5m          →  400ms  (rapid, panicked)
 *   linear between
 *
 * @param {number|null} dist  metres, or null if not yet calculated
 */
function updateHeartbeatTempo(dist) {
  try {
    const a = Game.audio;
    if (!a.heartbeatActive) return;

    const FAR_DIST = 10,  FAR_MS  = 1100;
    const NEAR_DIST = 1.5, NEAR_MS = 400;

    if (dist === null || dist >= FAR_DIST) {
      a.heartbeatInterval = FAR_MS;
      return;
    }
    if (dist <= NEAR_DIST) {
      a.heartbeatInterval = NEAR_MS;
      return;
    }

    // Linear interpolation between far and near endpoints
    const t = (dist - NEAR_DIST) / (FAR_DIST - NEAR_DIST); // 0=near, 1=far
    a.heartbeatInterval = Math.round(NEAR_MS + t * (FAR_MS - NEAR_MS));

  } catch (e) {
    console.warn('[audio] updateHeartbeatTempo failed:', e);
  }
}

// ---------------------------------------------------------------------------
// Part 4 — Hunt stinger
// ---------------------------------------------------------------------------

/**
 * playStinger — one-shot transient fired the instant a hunt begins.
 *
 * Two simultaneous branches:
 *
 *   Branch A — pitch drop:
 *     A sine oscillator sweeping 400 → 80 Hz in 250ms, with gain 0.5 → 0
 *     over 300ms. The high-to-low sweep reads as "drop" rather than "sting" —
 *     it conveys descent and loss of safety rather than a warning ping.
 *     400 Hz is high enough to cut through the drone; 80 Hz lands close
 *     enough to the drone's range that the stinger dissolves into the bed.
 *
 *   Branch B — filtered noise burst:
 *     White noise (from the pre-generated buffer) through a bandpass filter
 *     at ~200 Hz, decaying over 250ms. A pure tone alone sounds like a UI
 *     notification. The noise burst adds texture that makes the stinger feel
 *     like the room reacting — stone dust settling, air disturbed — rather
 *     than a synthetic cue.
 *
 * AudioContext clock scheduling (not setTimeout) is used for all parameter
 * ramps because sub-millisecond accuracy matters for a transient: even a
 * 10ms timing error on the pitch sweep start would be audible. setTimeout has
 * a ~4ms minimum resolution and can drift under CPU load.
 */
function playStinger() {
  try {
    const a = Game.audio;
    if (!a.ctx || !a.noiseBuffer) return;

    const ctx = a.ctx;
    const now = ctx.currentTime;

    // --- Branch A: pitch drop ---
    const oscA  = ctx.createOscillator();
    const gainA = ctx.createGain();

    oscA.type            = 'sine';
    oscA.frequency.setValueAtTime(400, now);
    oscA.frequency.exponentialRampToValueAtTime(80, now + 0.25); // sweep over 250ms

    gainA.gain.setValueAtTime(0.5, now);
    gainA.gain.linearRampToValueAtTime(0, now + 0.3); // fade over 300ms

    oscA.connect(gainA);
    gainA.connect(a.masterGain);
    oscA.start(now);
    oscA.stop(now + 0.35); // guarantee cleanup past the ramp end

    // --- Branch B: filtered noise burst ---
    const src    = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    const gainB  = ctx.createGain();

    src.buffer = a.noiseBuffer;
    src.loop   = false; // plays once — the buffer is 1s but the gain ramps to
                        // zero well before that, so the tail never becomes audible

    // Bandpass at 200 Hz centres the noise in the low-mid range — audible
    // texture without competing with the high-end of the pitch drop.
    filter.type            = 'bandpass';
    filter.frequency.value = 200;
    filter.Q.value         = 2.0; // moderate Q for a focused but not whistling band

    gainB.gain.setValueAtTime(0.3, now);
    gainB.gain.linearRampToValueAtTime(0, now + 0.25);

    src.connect(filter);
    filter.connect(gainB);
    gainB.connect(a.masterGain);
    src.start(now);
    src.stop(now + 0.35);

  } catch (e) {
    console.warn('[audio] playStinger failed:', e);
  }
}

// ---------------------------------------------------------------------------
// Part 3 — Sparse environmental one-shots
// ---------------------------------------------------------------------------

/**
 * playCreak — a short wood/stone creak: sawtooth sweep through a bandpass,
 * panned randomly for spatial variety. Duration 150–400 ms.
 *
 * Base frequency is randomised ±15% per call so repeated creaks never sound
 * identical — the same structural approach as the heartbeat's fresh-node-per-
 * beat pattern, but here the randomisation is in pitch rather than timing.
 */
function playCreak() {
  try {
    const a = Game.audio;
    if (!a.ctx) return;
    const ctx = a.ctx;
    const now = ctx.currentTime;

    // Randomise base frequency ±15% around 300 Hz.
    const baseFreq  = 300 * (0.85 + Math.random() * 0.30); // 255–345 Hz
    const endFreq   = baseFreq * 0.5;                       // sweep down to half
    const duration  = 0.15 + Math.random() * 0.25;          // 150–400 ms

    const osc    = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const gain   = ctx.createGain();
    const panner = ctx.createStereoPanner();

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(baseFreq, now);
    osc.frequency.exponentialRampToValueAtTime(endFreq, now + duration);

    filter.type            = 'bandpass';
    filter.frequency.value = 250;
    filter.Q.value         = 3;

    // Quick attack (20ms) then slower decay — the initial transient catches
    // attention; the tail fades before it becomes annoying.
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.35, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

    // Random pan: -0.7 (left) to 0.7 (right)
    panner.pan.value = (Math.random() * 1.4) - 0.7;

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(panner);
    panner.connect(a.masterGain);

    osc.start(now);
    osc.stop(now + duration + 0.01); // small cleanup margin past decay end

  } catch (e) {
    console.warn('[audio] playCreak failed:', e);
  }
}

/**
 * playDistantKnock — a single low thump (~45 Hz), ~80 ms.
 * Same fast-attack / exponential-decay pattern as the heartbeat beat, but at a
 * lower frequency and with a random pan so it reads as something in the walls
 * rather than a body rhythm.
 */
function playDistantKnock() {
  try {
    const a = Game.audio;
    if (!a.ctx) return;
    const ctx = a.ctx;
    const now = ctx.currentTime;

    const osc    = ctx.createOscillator();
    const gain   = ctx.createGain();
    const panner = ctx.createStereoPanner();

    osc.type            = 'sine';
    osc.frequency.value = 45; // low enough to feel structural, not melodic

    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.5, now + 0.005); // 5ms attack — thud, not swell
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08); // 80ms decay

    panner.pan.value = (Math.random() * 1.4) - 0.7;

    osc.connect(gain);
    gain.connect(panner);
    panner.connect(a.masterGain);

    osc.start(now);
    osc.stop(now + 0.09);

  } catch (e) {
    console.warn('[audio] playDistantKnock failed:', e);
  }
}

/**
 * playFaintScrape — ~1000 ms of narrow-band noise through a 600–900 Hz
 * bandpass, slow attack and long decay. Reuses the existing noiseBuffer so
 * no new buffer allocation is needed.
 *
 * Why reuse noiseBuffer (white noise) rather than generating new noise?
 * The noiseBuffer was generated once in initAudio() for exactly this reason —
 * random fill + createBuffer has real cost. The bandpass filter shapes the
 * spectrum to the scrape character; the raw noise source is just an energy
 * carrier. Reusing it is cheaper and produces indistinguishable results.
 */
function playFaintScrape() {
  try {
    const a = Game.audio;
    if (!a.ctx || !a.noiseBuffer) return;
    const ctx = a.ctx;
    const now = ctx.currentTime;

    const src    = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    const gain   = ctx.createGain();
    const panner = ctx.createStereoPanner();

    src.buffer = a.noiseBuffer;
    src.loop   = false; // 1s buffer is longer than the envelope — tail is silent

    // Narrow bandpass in the 600–900 Hz range: enough to be "texture" without
    // being recognisable as white noise hiss (which reads as technical artefact).
    filter.type            = 'bandpass';
    filter.frequency.value = 750; // midpoint of 600–900 Hz
    filter.Q.value         = 3.5; // narrow enough to colour the noise distinctly

    // Slow attack (200ms) builds the scrape gradually — it should emerge from
    // the room rather than appear suddenly. Decay over 800ms lets it fade
    // naturally before the buffer runs out.
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.18, now + 0.2);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 1.0);

    panner.pan.value = (Math.random() * 1.4) - 0.7;

    src.connect(filter);
    filter.connect(gain);
    gain.connect(panner);
    panner.connect(a.masterGain);

    src.start(now);
    src.stop(now + 1.05); // slight margin past envelope end

  } catch (e) {
    console.warn('[audio] playFaintScrape failed:', e);
  }
}

// ---------------------------------------------------------------------------
// Sparse ambient event scheduler
// ---------------------------------------------------------------------------

/**
 * scheduleAmbientEvent — internal self-rescheduling function for environmental sounds.
 *
 * Same overwrite-every-time timeout pattern as scheduleBeat(): each call stores
 * its own setTimeout ID in Game.audio.ambientEventTimeout, so stopAmbientEvents()
 * always cancels the currently pending event, not a stale one.
 *
 * Why skip playback during hunts?
 * The heartbeat and stinger already provide intense audio presence during a hunt.
 * A creak or knock in that moment would compete for attention and read as a second
 * threat rather than environmental texture. Skipping playback (but not rescheduling)
 * keeps the rhythm of the scheduler intact so events resume promptly after the hunt.
 */
function scheduleAmbientEvent() {
  const a = Game.audio;
  if (!a.ambientEventsActive || !a.ctx) return;

  // Random interval: 15–40 seconds between events.
  const delayMs = 15000 + Math.random() * 25000;

  a.ambientEventTimeout = setTimeout(() => {
    // Skip playback during hunts — but always reschedule so events resume after.
    if (Game.enemy && Game.enemy.state !== 'hunt') {
      // Randomly choose one of the three environmental sounds.
      const roll = Math.random();
      if      (roll < 0.40) playCreak();
      else if (roll < 0.70) playDistantKnock();
      else                  playFaintScrape();
    }

    // Reschedule unconditionally — hunt-skip doesn't break the cycle.
    scheduleAmbientEvent();
  }, delayMs);
}

/** Starts the sparse ambient event scheduler. Called once from initAudio(). */
function startAmbientEvents() {
  const a = Game.audio;
  a.ambientEventsActive = true;
  scheduleAmbientEvent();
}

/**
 * Stops the ambient event scheduler. Not called anywhere currently — provided
 * for symmetry with startAmbientEvents() and for future use (e.g. muting all
 * non-essential audio on the caught/escaped ending screen).
 */
function stopAmbientEvents() {
  const a = Game.audio;
  a.ambientEventsActive = false;
  if (a.ambientEventTimeout !== null) {
    clearTimeout(a.ambientEventTimeout);
    a.ambientEventTimeout = null;
  }
}

// ---------------------------------------------------------------------------
// pauseAudio / resumeAudio — called by setGameState() in gamestate.js
// ---------------------------------------------------------------------------

/**
 * Suspends the AudioContext, halting all audio processing at once.
 * Using ctx.suspend() rather than zeroing individual gain nodes because it
 * atomically silences every node in the graph — including nodes added later —
 * without us having to enumerate them. The context retains its state so
 * resume() picks up exactly where it left off.
 */
function pauseAudio() {
  try {
    const a = Game.audio;
    // ctx is null until the player has clicked the start overlay at least once.
    // A pre-click pause call (e.g. window losing focus immediately) is a no-op.
    if (a.ctx && a.ctx.state === 'running') {
      a.ctx.suspend();
    }
  } catch (err) {
    console.warn('[Audio] pause failed:', err.message);
  }
}

/**
 * Resumes a suspended AudioContext. Matches the guard pattern of pauseAudio:
 * only acts when ctx exists and is actually suspended, so calling it at any
 * other time (e.g. double-resume) is safe.
 */
function resumeAudio() {
  try {
    const a = Game.audio;
    if (a.ctx && a.ctx.state === 'suspended') {
      a.ctx.resume();
    }
  } catch (err) {
    console.warn('[Audio] resume failed:', err.message);
  }
}
