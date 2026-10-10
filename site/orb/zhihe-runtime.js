/**
 * Interactive runtime for the ported 智核 character.
 *
 * The Blender output is a fixed 24-second loop; this is what the realtime port
 * exists for. The API mirrors the ZhiheHandle contract the existing app already
 * drives — setState / lookAt / blink / setAudioLevel / showIcon — so the port
 * can be dropped in behind it, and the state profiles are the ones the app
 * already ships rather than new inventions.
 *
 * The rig reuses the authored geometry; optional ring deformation lives in its
 * optical material. The original Blender assets are not overwritten.
 */

import * as THREE from "three";
import { createIconLayer } from "./zhihe-icons.js";
import { createCharacterRig } from "./zhihe-rig.js";

export const ZHIHE_STATES = [
  "idle", "listening", "thinking", "processing",
  "speaking", "success", "warning", "sleep",
];

// Copied from the app's src/state/states.ts so behaviour matches what it expects.
export const STATE_PROFILES = {
  idle:       { eyeShape: "idle",      ringSpeed: 0.80, glyphSpeed: 0.80, glow: 1.00, breathing: 1.00, floating: 1.00, atmosphere: 1.00, ringPulse: 0.00 },
  listening:  { eyeShape: "listening", ringSpeed: 0.52, glyphSpeed: 0.48, glow: 1.16, breathing: 1.08, floating: 0.72, atmosphere: 1.14, ringPulse: 0.22 },
  thinking:   { eyeShape: "ring",      ringSpeed: 1.45, glyphSpeed: 2.15, glow: 1.08, breathing: 0.80, floating: 0.75, atmosphere: 1.34, ringPulse: 0.10 },
  processing: { eyeShape: "target",    ringSpeed: 3.10, glyphSpeed: 4.25, glow: 1.32, breathing: 0.66, floating: 0.55, atmosphere: 1.70, ringPulse: 0.26 },
  speaking:   { eyeShape: "wave",      ringSpeed: 1.05, glyphSpeed: 1.28, glow: 1.17, breathing: 1.25, floating: 0.90, atmosphere: 1.20, ringPulse: 0.16 },
  success:    { eyeShape: "happy",     ringSpeed: 0.72, glyphSpeed: 0.64, glow: 1.32, breathing: 1.08, floating: 1.10, atmosphere: 1.16, ringPulse: 0.28 },
  warning:    { eyeShape: "idle",      ringSpeed: -0.42, glyphSpeed: -1.35, glow: 1.42, breathing: 1.35, floating: 0.42, atmosphere: 1.30, ringPulse: 0.90 },
  sleep:      { eyeShape: "sleep",     ringSpeed: 0.08, glyphSpeed: 0.05, glow: 0.46, breathing: 0.58, floating: 0.34, atmosphere: 0.42, ringPulse: 0.00 },
};

// Eye shapes are expressed as scale multipliers on the authored ellipsoid, so the
// modelled eye stays the source of truth for size and placement.
const EYE_SHAPES = {
  idle:      { x: 1.00, y: 1.00, lift: 0.00 },
  listening: { x: 1.06, y: 1.12, lift: 0.01 },
  ring:      { x: 1.10, y: 0.86, lift: 0.00 },
  target:    { x: 0.82, y: 0.82, lift: 0.00 },
  wave:      { x: 1.04, y: 0.94, lift: 0.00 },
  happy:     { x: 1.12, y: 0.55, lift: 0.02 },
  sleep:     { x: 1.16, y: 0.16, lift: -0.01 },
};

const LOOK_RANGE_X = 0.055;   // world units the eyes travel; the sockets stay put
const LOOK_RANGE_Y = 0.035;
// Seconds on the runtime's own clock, not wall time: everything else here
// advances on dt, and a blink measured against performance.now() lasts a
// different number of frames whenever the frame rate moves.
const BLINK_TIME = 0.13;

// A character that only blinks when asked reads as a still image with moving
// smoke behind it. People blink every few seconds and sometimes twice; the
// interval is randomised because a metronome reads as a machine.
const BLINK_GAP = [2.4, 6.6];
const DOUBLE_BLINK_CHANCE = 0.18;
const DOUBLE_BLINK_GAP = 0.22;
// How long the eyes hold a pointer's last position before they start wandering
// on their own.
const GAZE_IDLE_AFTER = 2.5;

function damp(current, target, lambda, dt) {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}

export function createZhiheRuntime({ parts, domes, atmosphereLayers = domes, camera, videoEl, root, appearance = {eyeBrightness:1} }) {
  // Group the ring so it can spin about its own axis: the glTF hierarchy is flat
  // with baked transforms, so the pivot has to be rebuilt here.
  const rig = createCharacterRig({root,parts,atmosphere:atmosphereLayers,camera});
  // The exported ring is offset from the character origin. Rotate about its
  // authored centre so the glass and its embedded emitters stay concentric.

  // Icons live with the eyes, inside the shell, and morph between shapes rather
  // than cross-fading — see zhihe-icons.js.
  const icons = createIconLayer();
  rig.head.add(icons.mesh);

  const eyes = [parts.get("Eye_0"), parts.get("Eye_1")].filter(Boolean);
  const eyeRest = eyes.map(e => e.position.clone());
  const eyeScale = eyes.map(e => e.scale.clone());
  const eyeColours = eyes.map(e => e.material.color.clone());
  const emissiveParts = [...parts.values()].filter(m => m.material && m.material.emissiveIntensity !== undefined);
  const emissiveRest = emissiveParts.map(m => m.material.emissiveIntensity);

  const state = {
    presentation: "rest",
    name: "idle",
    profile: STATE_PROFILES.idle,
    look: { x: 0, y: 0 },
    lookTarget: { x: 0, y: 0 },
    audio: 0,
    audioSmoothed: 0,
    blinkStart: -1e9,
    nextBlink: 3.0,
    pendingBlink: -1,
    lastLookAt: -1e9,
    gazeHold: GAZE_IDLE_AFTER,
    icon: null,
    ringAngle: 0,
    glyphAngle: 0,
    clock: 0,
    // profile values are damped so a state change reads as a transition
    ringSpeed: 0.8, glyphSpeed: 0.8, glow: 1, breathing: 1, floating: 1, atmosphere: 1,
  };

  // 表演疊上去的效果（眼睛寬高倍率、亮度倍率、環額外轉的角度）。表演結束要 setFx() 歸零。
  const fx = { eyeX: 1, eyeY: 1, glow: 1, spin: 0 };
  // 預先算圖用（tools/orb-capture）：直接指定環與刻字的角度，才能做出頭尾接得起來的循環。平常是 null。
  let spinLock = null;

  function update(dt) {
    state.clock += dt;
    const p = state.profile;

    state.ringSpeed = damp(state.ringSpeed, p.ringSpeed, 3.2, dt);
    state.glyphSpeed = damp(state.glyphSpeed, p.glyphSpeed, 3.2, dt);
    state.glow = damp(state.glow, p.glow, 4.0, dt);
    state.breathing = damp(state.breathing, p.breathing, 3.0, dt);
    state.floating = damp(state.floating, p.floating, 3.0, dt);
    state.atmosphere = damp(state.atmosphere, p.atmosphere, 2.5, dt);
    state.audioSmoothed = damp(state.audioSmoothed, state.audio, 12.0, dt);
    // Left alone, the gaze wanders instead of staring. Two incommensurate
    // periods, so it never repeats the same path, and small enough that it
    // reads as attention rather than as a search.
    if (state.clock - state.lastLookAt > state.gazeHold && p.eyeShape !== "sleep") {
      const t = state.clock;
      state.lookTarget.x = Math.sin(t * 0.31) * 0.34 + Math.sin(t * 0.17 + 1.3) * 0.16;
      state.lookTarget.y = Math.sin(t * 0.23 + 2.1) * 0.20;
    }
    state.look.x = damp(state.look.x, state.lookTarget.x, 7.0, dt);
    state.look.y = damp(state.look.y, state.lookTarget.y, 7.0, dt);

    // Blinking on its own. Sleep has the lids down already, so it sits this out.
    if (p.eyeShape === "sleep") {
      state.nextBlink = state.clock + BLINK_GAP[0];
      state.pendingBlink = -1;
    } else if (state.pendingBlink > 0 && state.clock >= state.pendingBlink) {
      state.blinkStart = state.clock;
      state.pendingBlink = -1;
    } else if (state.clock >= state.nextBlink) {
      state.blinkStart = state.clock;
      state.nextBlink = state.clock + BLINK_GAP[0] + Math.random() * (BLINK_GAP[1] - BLINK_GAP[0]);
      if (Math.random() < DOUBLE_BLINK_CHANCE) {
        state.pendingBlink = state.clock + DOUBLE_BLINK_GAP;
      }
    }

    // ring and glyphs turn about the authored ring axis, at profile speeds
    const pulse = p.ringPulse * Math.sin(state.clock * 3.1) * 0.04;
    // Wrapped, not left to accumulate: the angle also places the optical inlay
    // atlas, and after a few hours of running a float32
    // radian count has lost the precision a 1024-cell table needs.
    const TAU = Math.PI * 2;
    state.ringAngle = (state.ringAngle + (state.ringSpeed * 0.25 + pulse) * dt) % TAU;
    state.glyphAngle = (state.glyphAngle + state.glyphSpeed * 0.25 * dt) % TAU;
    if (spinLock) { state.ringAngle = spinLock[0]; state.glyphAngle = spinLock[1]; }

    // breathing and floating move the whole character, as in the app
    const breathe = 1 + Math.sin(state.clock * 1.15) * 0.006 * state.breathing;
    const bob = Math.sin(state.clock * 0.78) * 0.012 * state.floating;
    rig.update(dt,{bodySpin:state.ringAngle+fx.spin,glyphSpin:state.glyphAngle+fx.spin,breathe,bob,gazeX:state.look.x,gazeY:state.look.y});

    // eyes: gaze, blink, and an audio-driven opening while speaking
    const shape = EYE_SHAPES[p.eyeShape] || EYE_SHAPES.idle;
    const since = state.clock - state.blinkStart;
    const blink = since >= 0 && since < BLINK_TIME
      ? 1 - Math.abs(since / BLINK_TIME * 2 - 1) : 0;
    const speakOpen = p.eyeShape === "wave" ? 1 + state.audioSmoothed * 0.35 : 1;
    eyes.forEach((eye, i) => {
      eye.position.x = eyeRest[i].x + state.look.x * LOOK_RANGE_X;
      eye.position.y = eyeRest[i].y + state.look.y * LOOK_RANGE_Y + shape.lift;
      eye.scale.x = eyeScale[i].x * shape.x * fx.eyeX;
      eye.scale.y = eyeScale[i].y * shape.y * speakOpen * (1 - blink * 0.94) * fx.eyeY;
      eye.scale.z = eyeScale[i].z;
    });

    // glow scales the authored emission rather than replacing it
    applyAppearance();

    // icons morph on their own clock, dimming the eyes while one is shown
    icons.update(dt, { glow: state.glow, audio: state.audioSmoothed });
    const iconVeil = 1 - icons.state.opacity * 0.72;
    eyes.forEach((eye) => { eye.scale.multiplyScalar(iconVeil); });

    // the atmosphere loop plays faster or slower with the state's activity
    if (videoEl && !videoEl.paused) {
      const rate = THREE.MathUtils.clamp(state.atmosphere, 0.25, 4);
      if (Math.abs(videoEl.playbackRate - rate) > 0.01) videoEl.playbackRate = rate;
    }
    domes.forEach(d => {
      d.material.uniforms.uEmission.value = 0.78 * (0.85 + 0.15 * state.atmosphere);
    });
  }

  function applyAppearance() {
    emissiveParts.forEach((m, i) => {
      m.material.emissiveIntensity = emissiveRest[i] * state.glow * fx.glow * (eyes.includes(m) ? appearance.eyeBrightness : 1);
    });
    eyes.forEach((eye,i)=>eye.material.color.copy(eyeColours[i]).multiplyScalar(appearance.eyeBrightness));
    icons.mesh.material.uniforms.uBrightness.value=appearance.eyeBrightness;
  }

  return {
    applyAppearance,
    rig,
    update,
    setPresentation(name) { state.presentation = name; rig.setPresentation(name); },
    setPoseGain(g) { rig.setPoseGain(g); },
    setRingTilt(t) { rig.setRingTilt(t); },
    setPose(pose, snap=false) { return rig.setPose(pose,snap); },
    setSpinLock(body, glyph) { spinLock = Number.isFinite(body) ? [body, Number.isFinite(glyph) ? glyph : body] : null; },
    /** 表演效果；不給就歸零。eye＝[寬,高] 倍率、glow＝亮度倍率、spin＝環額外轉的弧度。 */
    setFx(o) {
      const n = (v, d, lo, hi) => Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
      fx.eyeX = n(o?.eye?.[0], 1, .3, 1.6); fx.eyeY = n(o?.eye?.[1], 1, .05, 1.6);
      fx.glow = n(o?.glow, 1, .3, 2.4); fx.spin = n(o?.spin, 0, -60, 60);
    },
    get state() { return state.name; },
    /**
     * Absolute glyph and body angles. The optical shader subtracts them to
     * locate the emitters in the moving ring's own space; their speeds differ
     * in thinking and processing, and must not be applied twice.
     */
    get spin() { return state.glyphAngle; },
    get ringSpin() { return state.ringAngle*rig.bodySpinFactor; },
    get glow() { return state.glow; },
    setState(name) {
      if (!STATE_PROFILES[name]) throw new Error(`unknown state: ${name}`);
      state.name = name;
      state.profile = STATE_PROFILES[name];
    },
    /**
     * hold is how long the gaze stays put before it starts wandering again.
     * The pointer wants the short default - it is being moved constantly - and
     * a deliberate press wants longer, or it looks like the control was
     * ignored a moment after it was used.
     */
    lookAt(x, y, hold = GAZE_IDLE_AFTER) {
      state.lookTarget.x = THREE.MathUtils.clamp(x, -1, 1);
      state.lookTarget.y = THREE.MathUtils.clamp(y, -1, 1);
      state.lastLookAt = state.clock;   // being told where to look stops the wander
      state.gazeHold = hold;
    },
    blink() {
      state.blinkStart = state.clock;
      // an asked-for blink also resets the automatic one, so the two do not
      // land on top of each other
      state.nextBlink = state.clock + BLINK_GAP[0] + Math.random() * (BLINK_GAP[1] - BLINK_GAP[0]);
    },
    /** 取消正在進行的眨眼（畫面要停下來之前叫：停在眨到一半那一格，看起來就是閉著眼不張開）。 */
    openEyes() {
      state.blinkStart = -1e9;
      state.pendingBlink = -1;
      state.nextBlink = state.clock + BLINK_GAP[0];
    },
    /** 眼睛目前張開的比例（1 = 正常；眨眼、睡覺、圖示蓋住時變小）。 */
    get eyeOpen() { return eyes.length ? eyes[0].scale.y / eyeScale[0].y : 1; },
    setAudioLevel(v) { state.audio = THREE.MathUtils.clamp(v, 0, 1); },
    showIcon(icon) { state.icon = icon; icons.show(icon); },
    icons,
    debug: () => ({ ...state, profile: state.profile.eyeShape, icon: icons.icon }),
  };
}
