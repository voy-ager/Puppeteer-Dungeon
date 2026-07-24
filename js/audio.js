/**
 * audio.js — Procedural horror soundscape
 *
 * Everything here is generated live from the Web Audio API — no external
 * audio files, no CDN dependencies, no licensing concerns. Three layers:
 *
 *   1. Ambient drone  — four slightly-detuned low oscillators through a
 *      lowpass filter, with three intensity-driven additions:
 *        a) A thin dissonant sawtooth at 220 Hz through an 800 Hz highpass,
 *           so only the harmonic edge bleeds through — a faint sharpness
 *           that scales with intensity.
 *        b) A rising pitch-bend on the 62 Hz triangle oscillator during
 *           hunts — climbs to 90 Hz at maximum intensity, still low enough
 *           to feel connected to the bed rather than a separate melody.
 *        c) A parallel dry/wet waveshaping distortion path after the main
 *           filter — the dry signal always passes clean; the wet (distorted)
 *           path fades in only above ~0.7 intensity for subtle grit at the
 *           top of the dynamic range.
 *
 *   2. Heartbeat      — a rhythmic low thump that plays only during hunts,
 *      speeding up as the enemy closes in. Each thump is a fresh short-lived
 *      oscillator node (not a gated persistent one — see scheduleBeat() for
 *      why that distinction matters).
 *
 *   3. Hunt stinger   — a one-shot transient the instant a hunt begins:
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
  ctx: null,             // AudioContext — null until initAudio() is called
  masterGain: null,      // final output bus, fixed low volume (0.28)

  // Drone — created once in startAmbientDrone(), live until page unload
  droneOscillators: [], // array of 4 OscillatorNode references (indices 0-3; [3] is the 62 Hz triangle)
  droneGain: null,      // GainNode — volume target for setDroneIntensity()
  droneFilter: null,    // BiquadFilterNode — cutoff also modulated by intensity

  // Dry/wet distortion split — parallel paths after droneFilter
  dryGain: null,        // GainNode — fixed ~1.0; the clean signal always passes
  distortion: null,     // WaveShaperNode — mild soft-clip; audibility controlled by wetGain blend
  wetGain: null,        // GainNode — 0 below intensity ~0.7, ramps to ~0.35 at intensity 1

  // Dissonant high-frequency layer — thin sawtooth edge, scales with intensity
  dissonantOsc: null,    // OscillatorNode — sawtooth at 220 Hz
  dissonantFilter: null, // BiquadFilterNode — highpass ~800 Hz; only harmonic edge passes
  dissonantGain: null,   // GainNode — scales with intensity; keeps it a texture, never a tone

  // Heartbeat — scheduler state
  heartbeatActive: false,
  heartbeatTimeout: null,   // ID of the CURRENTLY pending setTimeout.
                            // overwritten on every reschedule so stopHeartbeat()
                            // always cancels the next-pending beat, not a stale one.
  heartbeatInterval: 1100,  // ms between beats; recalculated per-beat from distance

  // Reusable noise buffer — generated once at init, used by playStinger()
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

  } catch (e) {
    console.warn('[audio] initAudio failed — audio disabled for this session:', e);
  }
}

// ---------------------------------------------------------------------------
// Part 2 — Ambient drone
// ---------------------------------------------------------------------------

/**
 * startAmbientDrone — creates the four-oscillator drone chain and starts it.
 *
 * Full node graph:
 *
 *   osc[0] sine  55.0 Hz ──┐
 *   osc[1] sine  56.5 Hz ──┤
 *   osc[2] sine  58.0 Hz ──┼──► droneGain ──► droneFilter ──► dryGain  ──────────────► masterGain
 *   osc[3] tri   62.0 Hz ──┘                              └──► distortion ──► wetGain ──► masterGain
 *
 *   dissonantOsc (saw 220 Hz) ──► dissonantFilter (highpass 800 Hz) ──► dissonantGain ──► masterGain
 *
 * Why four low oscillators?
 * Multiple oscillators spaced a few Hz apart produce slow amplitude modulation
 * (beating) at their difference frequencies. The cluster at 55/56.5/58/62 Hz
 * produces beats at 1.5, 1.5, 3, 4, 6, and 7 Hz — an irregular pattern that
 * reads as organic rather than mechanical. The triangle at 62 Hz also serves as
 * the pitch-bend target during hunts (see setDroneIntensity).
 *
 * Why the dissonant sawtooth at 220 Hz through an 800 Hz highpass?
 * The sawtooth's rich harmonic series extends well into the audible range, but
 * the highpass removes the fundamental and lower harmonics. Only the uppermost
 * partials bleed through — a thin, slightly sharp edge in the high-mid range
 * rather than a recognisable pitch. This adds tension as intensity rises without
 * introducing a melodic element that would undercut the horror atmosphere.
 *
 * Why a parallel dry/wet distortion split (not a serial insert)?
 * A WaveShaperNode in series would colour the whole signal at all times. The
 * parallel split lets the dry signal pass clean always — the waveshaper's grit
 * blends in only when wetGain rises above zero (above intensity ~0.7). This is
 * the standard "wet blend" pattern used in mixing: keep the clean transient
 * intact and only add saturation/colour on top.
 */
function startAmbientDrone() {
  try {
    const a = Game.audio;
    if (!a.ctx || a.droneOscillators.length > 0) return; // guard double-init

    const ctx = a.ctx;

    // --- Main drone gain + lowpass filter ---
    const droneGain = ctx.createGain();
    droneGain.gain.value = 0.4;
    a.droneGain = droneGain;

    const droneFilter = ctx.createBiquadFilter();
    droneFilter.type            = 'lowpass';
    droneFilter.frequency.value = 180;
    droneFilter.Q.value         = 0.8;
    a.droneFilter = droneFilter;

    droneGain.connect(droneFilter);

    // --- Dry/wet split after the main filter ---
    // dryGain: the clean filtered signal, always passing through at full level.
    // Kept at 1.0 and never ramped — the clean path is unconditional.
    const dryGain = ctx.createGain();
    dryGain.gain.value = 1.0;
    a.dryGain = dryGain;
    droneFilter.connect(dryGain);
    dryGain.connect(a.masterGain);

    // distortion: mild soft-clip waveshaper. The curve is a smooth cubic that
    // gently compresses peaks above ~0.5 amplitude — it adds grit and harmonic
    // content without the harsh aliasing of a hard-clip. The wetGain blend
    // (not the curve itself) controls how much distortion is audible.
    const distortion = ctx.createWaveShaper();
    distortion.curve    = makeSoftClipCurve(256);
    distortion.oversample = '2x'; // reduces aliasing artefacts from the shaper
    a.distortion = distortion;
    droneFilter.connect(distortion);

    // wetGain: starts at 0 and only ramps up when intensity exceeds ~0.7.
    // At maximum intensity it reaches ~0.35 — present but not dominant.
    const wetGain = ctx.createGain();
    wetGain.gain.value = 0;
    a.wetGain = wetGain;
    distortion.connect(wetGain);
    wetGain.connect(a.masterGain);

    // --- Dissonant high-frequency layer ---
    // Sawtooth at 220 Hz — the harmonic series extends upward in integer
    // multiples (220, 440, 660, 880 Hz…). The highpass at 800 Hz removes
    // everything below, leaving only the upper partials as a thin, airy edge.
    const dissonantOsc = ctx.createOscillator();
    dissonantOsc.type            = 'sawtooth';
    dissonantOsc.frequency.value = 220;
    a.dissonantOsc = dissonantOsc;

    const dissonantFilter = ctx.createBiquadFilter();
    dissonantFilter.type            = 'highpass';
    dissonantFilter.frequency.value = 800;
    dissonantFilter.Q.value         = 0.7;
    a.dissonantFilter = dissonantFilter;

    // dissonantGain starts at 0 — the layer is inaudible until intensity rises.
    // Maximum ceiling of 0.12 keeps it a texture rather than a competing element.
    const dissonantGain = ctx.createGain();
    dissonantGain.gain.value = 0;
    a.dissonantGain = dissonantGain;

    dissonantOsc.connect(dissonantFilter);
    dissonantFilter.connect(dissonantGain);
    dissonantGain.connect(a.masterGain);

    // --- Low oscillators ---
    // osc[3] is the 62 Hz triangle — stored last so its index is predictable
    // for the pitch-bend in setDroneIntensity (droneOscillators[3].frequency).
    const specs = [
      { type: 'sine',     freq: 55.0 },
      { type: 'sine',     freq: 56.5 },
      { type: 'sine',     freq: 58.0 },
      { type: 'triangle', freq: 62.0 }, // index 3 — pitch-bend target during hunts
    ];
    for (const { type, freq } of specs) {
      const osc = ctx.createOscillator();
      osc.type            = type;
      osc.frequency.value = freq;
      osc.connect(droneGain);
      osc.start();
      a.droneOscillators.push(osc);
    }

    dissonantOsc.start();

  } catch (e) {
    console.warn('[audio] startAmbientDrone failed:', e);
  }
}

/**
 * makeSoftClipCurve — generates a Float32Array waveshaping curve.
 *
 * Uses a cubic soft-clip formula: y = x - x³/3, which compresses peaks
 * gently (unlike hard-clip which creates harsh square-wave aliasing).
 * The result is warm saturation — more amplitude colouring than distortion.
 *
 * @param {number} samples  Number of points in the curve (256 is plenty for
 *                          a smooth shape without excess memory use).
 */
function makeSoftClipCurve(samples) {
  const curve = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / samples - 1; // normalise to [-1, 1]
    // Cubic soft-clip: gentle compression. The /1.5 rescales the output back
    // close to [-1, 1] range so the distortion doesn't clip the output.
    curve[i] = (x - (x * x * x) / 3) / 1.5;
  }
  return curve;
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

    // --- Main drone volume and filter ---
    // Gain: 0 → 0.25 (quiet floor) to 1 → 0.95 (full presence)
    a.droneGain.gain.linearRampToValueAtTime(0.25 + clamped * 0.70, rampEnd);

    // Filter cutoff: 0 → 120 Hz (muffled) to 1 → 320 Hz (present)
    a.droneFilter.frequency.linearRampToValueAtTime(120 + clamped * 200, rampEnd);

    // --- Pitch-bend on the 62 Hz triangle oscillator (index 3) ---
    // Climbs from 62 Hz (at level 0) to 90 Hz (at level 1) — a noticeable
    // rise that stays within the drone's low-frequency register so it reads
    // as growing tension rather than the start of a melody.
    if (a.droneOscillators[3]) {
      a.droneOscillators[3].frequency.linearRampToValueAtTime(62 + clamped * 28, rampEnd);
    }

    // --- Dissonant high-frequency layer ---
    // Scales linearly with intensity up to a ceiling of 0.12.
    // At 0.12 the layer is a faint textural edge — present but not dominant.
    if (a.dissonantGain) {
      a.dissonantGain.gain.linearRampToValueAtTime(clamped * 0.12, rampEnd);
    }

    // --- Wet distortion blend ---
    // Zero below intensity 0.7; linear rise from 0 to 0.35 between 0.7 and 1.0.
    // The threshold means the distortion is completely absent at calm/mid
    // intensities and only begins bleeding in as the drone reaches its peak.
    // 0.35 maximum keeps it subtle — grit heard on close listening, not an
    // effect that jumps out.
    if (a.wetGain) {
      const wetLevel = Math.max(0, (clamped - 0.7) / 0.3) * 0.35;
      a.wetGain.gain.linearRampToValueAtTime(wetLevel, rampEnd);
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
