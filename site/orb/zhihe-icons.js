/**
 * Status icons, drawn as signed distance fields.
 *
 * The six shapes the app already ships are here unchanged, so the vocabulary a
 * caller can rely on has not moved. What changes is the transition: the original
 * cross-faded one icon out while the next faded in, which reads as a dissolve
 * and was the ugly part.
 *
 * A distance field can be interpolated directly — mix(d_from, d_to, t) is a real
 * shape morph, where the outgoing strokes travel to become the incoming ones
 * rather than one image ghosting through another. That is only possible because
 * the icons are maths rather than textures, and it is also why the ten added
 * here cost a few lines each and nothing anywhere else.
 *
 * Several of them also move on their own: the field is a function of time as
 * well as position, so the wifi arcs travel outward, the battery fills, the
 * spinner turns. That is free for the same reason — it is one more argument to a
 * function, not another asset.
 */

import * as THREE from "three";

export const ICON_CODES = {
  // the app's original six, in their original order
  notification: 0, success: 1, warning: 2, battery: 3, wifi: 4, audio: 5,
  // added here
  loading: 6, music: 7, mail: 8, calendar: 9, lock: 10,
  search: 11, location: 12, timer: 13, heart: 14, cloud: 15,
};
export const ICON_NAMES = Object.keys(ICON_CODES);

/** Icons that carry their own motion, for callers that want to know. */
export const ANIMATED_ICONS = ["wifi", "battery", "audio", "loading", "timer", "heart"];

const vertexShader = /* glsl */`
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

const fragmentShader = /* glsl */`
varying vec2 vUv;
uniform float uFrom;
uniform float uTo;
uniform float uMorph;     // 0 = from, 1 = to
uniform float uOpacity;
uniform float uGlow;
uniform float uBrightness;
uniform float uAudio;
uniform float uTime;
uniform vec3  uColour;

float rb(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r; }
float seg(vec2 p, vec2 a, vec2 b, float r){ vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h) - r; }
float ring(vec2 p, float rad, float w){ return abs(length(p) - rad) - w; }
float tri(vec2 p){
  p.y += 0.08; float k = 1.732;
  p.x = abs(p.x) - 0.42; p.y = p.y + 0.42 / k;
  if (p.x + k * p.y > 0.0) p = vec2(p.x - k * p.y, -k * p.x - p.y) / 2.0;
  p.x -= clamp(p.x, -0.84, 0.0);
  return -length(p) * sign(p.y);
}
vec2 rot(vec2 p, float a){ float c = cos(a), s = sin(a); return mat2(c, -s, s, c) * p; }
float smin(float a, float b, float k){ float h = clamp(0.5 + 0.5*(b-a)/k, 0.0, 1.0); return mix(b, a, h) - k*h*(1.0-h); }
float cloudBody(vec2 p, float g){
  float d = length(p - vec2(-0.20, -0.06)) - (0.20 + g);
  d = min(d, length(p - vec2(0.10, 0.06)) - (0.26 + g));
  d = min(d, length(p - vec2(0.34, -0.10)) - (0.17 + g));
  d = min(d, rb(p - vec2(0.05, -0.20), vec2(0.36, 0.09) + g, 0.09 + g));
  return d;
}

float iconField(vec2 p, float c){
  if (c < 0.5) {                                   // notification
    float d = abs(rb(p, vec2(0.45, 0.28), 0.16)) - 0.04;
    d = min(d, length(p - vec2(-0.22, 0.0)) - 0.045);
    d = min(d, length(p) - 0.045);
    d = min(d, length(p - vec2(0.22, 0.0)) - 0.045);
    d = min(d, seg(p, vec2(-0.26, -0.32), vec2(-0.38, -0.46), 0.04));
    return d;
  }
  if (c < 1.5)                                     // success
    return min(seg(p, vec2(-0.38, 0.0), vec2(-0.10, -0.27), 0.065),
               seg(p, vec2(-0.10, -0.27), vec2(0.42, 0.30), 0.065));
  if (c < 2.5) {                                   // warning
    float d = abs(tri(p)) - 0.045;
    d = min(d, rb(p - vec2(0.0, 0.02), vec2(0.045, 0.20), 0.04));
    d = min(d, length(p - vec2(0.0, -0.31)) - 0.055);
    return d;
  }
  if (c < 3.5) {                                   // battery, filling as it charges
    float d = abs(rb(p, vec2(0.50, 0.28), 0.10)) - 0.045;
    d = min(d, rb(p - vec2(0.53, 0.0), vec2(0.05, 0.12), 0.025));
    float charge = 0.12 + 0.26 * (0.5 + 0.5 * sin(uTime * 1.1));
    d = min(d, rb(p - vec2(-0.38 + charge, 0.0), vec2(charge, 0.18), 0.05));
    return d;
  }
  if (c < 4.5) {                                   // wifi, arcs travelling outward
    vec2 q = p - vec2(0.0, -0.40);
    // a fan, not a rainbow: the arcs only exist inside a cone above the dot
    float cone = abs(atan(q.x, max(q.y, 1e-4)));
    float d = 1.0;
    for (int i = 0; i < 3; i++) {
      float phase = fract(uTime * 0.5 + float(i) / 3.0);
      float r = 0.20 + phase * 0.52;
      float fade = 0.055 * (1.0 - abs(phase * 2.0 - 1.0) * 0.55);
      float arc = abs(length(q) - r) - fade;
      arc = max(arc, cone - 0.85);                 // roughly +-49 degrees
      d = min(d, arc);
    }
    return min(d, length(q) - 0.065);
  }
  if (c < 5.5) {                                   // audio, reacting to level
    float d = 1.0;
    for (int i = 0; i < 7; i++) {
      float x = (float(i) - 3.0) * 0.14;
      float wob = 0.06 * sin(uTime * 5.0 + float(i) * 1.7);
      float h = 0.13 + (0.30 + 0.18 * uAudio + wob) * (1.0 - abs(float(i) - 3.0) / 3.6);
      d = min(d, rb(p - vec2(x, 0.0), vec2(0.035, max(h, 0.06)), 0.03));
    }
    return d;
  }
  if (c < 6.5) {                                   // loading, a turning gap
    float a = atan(p.y, p.x) - uTime * 2.6;
    float sweep = 0.72;                            // how much of the circle is drawn
    float t = fract(a / 6.2831853 + 0.5);
    float d = ring(p, 0.36, 0.055);
    // open the gap by pushing the field out where the arc is missing
    d += smoothstep(sweep, sweep + 0.06, t) * 0.6;
    return d;
  }
  if (c < 7.5) {                                   // music
    float d = rb(p - vec2(-0.20, -0.24), vec2(0.13, 0.11), 0.10);
    d = min(d, rb(p - vec2(0.24, -0.32), vec2(0.12, 0.10), 0.09));
    d = min(d, seg(p, vec2(-0.09, -0.22), vec2(-0.09, 0.34), 0.045));
    d = min(d, seg(p, vec2(0.34, -0.30), vec2(0.34, 0.26), 0.045));
    d = min(d, seg(p, vec2(-0.09, 0.34), vec2(0.34, 0.26), 0.05));
    return d;
  }
  if (c < 8.5) {                                   // mail
    float d = abs(rb(p, vec2(0.46, 0.32), 0.09)) - 0.042;
    d = min(d, seg(p, vec2(-0.40, 0.22), vec2(0.0, -0.06), 0.042));
    d = min(d, seg(p, vec2(0.0, -0.06), vec2(0.40, 0.22), 0.042));
    return d;
  }
  if (c < 9.5) {                                   // calendar
    float d = abs(rb(p - vec2(0.0, -0.04), vec2(0.44, 0.34), 0.09)) - 0.042;
    d = min(d, seg(p, vec2(-0.44, 0.10), vec2(0.44, 0.10), 0.038));
    d = min(d, seg(p, vec2(-0.24, 0.30), vec2(-0.24, 0.44), 0.042));
    d = min(d, seg(p, vec2(0.24, 0.30), vec2(0.24, 0.44), 0.042));
    d = min(d, length(p - vec2(-0.16, -0.16)) - 0.055);
    d = min(d, length(p - vec2(0.16, -0.16)) - 0.055);
    return d;
  }
  if (c < 10.5) {                                  // lock
    float d = abs(rb(p - vec2(0.0, -0.18), vec2(0.36, 0.26), 0.10)) - 0.042;
    float shackle = abs(ring(p - vec2(0.0, 0.16), 0.22, 0.042));
    shackle = max(shackle - 0.001, -(p.y - 0.14) - 0.0);
    d = min(d, max(ring(p - vec2(0.0, 0.14), 0.22, 0.042), -p.y + 0.14));
    d = min(d, length(p - vec2(0.0, -0.18)) - 0.06);
    return d;
  }
  if (c < 11.5) {                                  // search
    float d = ring(p - vec2(-0.08, 0.10), 0.28, 0.048);
    d = min(d, seg(p, vec2(0.12, -0.10), vec2(0.36, -0.34), 0.055));
    return d;
  }
  if (c < 12.5) {                                  // location
    float d = ring(p - vec2(0.0, 0.14), 0.24, 0.045);
    d = min(d, seg(p, vec2(-0.17, 0.00), vec2(0.0, -0.42), 0.045));
    d = min(d, seg(p, vec2(0.17, 0.00), vec2(0.0, -0.42), 0.045));
    d = min(d, length(p - vec2(0.0, 0.14)) - 0.075);
    return d;
  }
  if (c < 13.5) {                                  // timer, hands sweeping
    vec2 q = p - vec2(0.0, -0.04);
    float d = ring(q, 0.34, 0.048);
    d = min(d, seg(p, vec2(-0.11, 0.38), vec2(0.11, 0.38), 0.045));
    d = min(d, seg(p, vec2(-0.05, 0.30), vec2(0.05, 0.30), 0.05));
    // two hands, so it reads as a clock rather than a struck-through circle
    d = min(d, seg(q, vec2(0.0), rot(vec2(0.0, 0.24), -uTime * 1.9), 0.040));
    d = min(d, seg(q, vec2(0.0), rot(vec2(0.0, 0.15), -uTime * 0.16), 0.046));
    d = min(d, length(q) - 0.045);
    return d;
  }
  if (c < 14.5) {                                  // heart, beating
    float beat = 1.0 + 0.055 * sin(uTime * 4.2) + 0.025 * sin(uTime * 8.4);
    // point at the bottom: the reference field puts the lobes at +y, so the
    // scale must not flip the axis on the way in
    vec2 q = (p / beat) * vec2(1.35, 1.35) + vec2(0.0, 0.45);
    q.x = abs(q.x);
    float d;
    if (q.y + q.x > 1.0) {
      d = length(q - vec2(0.25, 0.75)) - 0.353553;
    } else {
      vec2 a = q - vec2(0.0, 1.0);
      float m = 0.5 * max(q.x + q.y, 0.0);
      vec2 b = q - vec2(m, m);
      d = sqrt(min(dot(a, a), dot(b, b))) * sign(q.x - q.y);
    }
    return d * beat / 1.35;
  }
  // cloud: the silhouette first, then hollowed out, so the lobes read as one
  // outline instead of three overlapping rings
  // Filled, like the heart.  Hollowing it out needs an accurate interior field,
  // and a union of circles does not have one: abs(min(...)) draws the seams
  // where the lobes meet, and eroding each lobe separately is not the same as
  // eroding the union, so that leaves gaps between them.  min() is exact
  // outside the shape, which is all a filled silhouette ever reads.
  return cloudBody(p, 0.0);
}

// Cubic ease with a touch of overshoot on the way in.
float easeInOut(float t){ return t < 0.5 ? 4.0*t*t*t : 1.0 - pow(-2.0*t + 2.0, 3.0)/2.0; }

void main(){
  vec2 p = (vUv - 0.5) * 2.0;

  // A small counter-rotation across the morph gives the strokes a direction to
  // travel in, so the change reads as movement rather than a substitution.
  float swing = (1.0 - abs(uMorph * 2.0 - 1.0)) * 0.16;
  float ca = cos(swing), sa = sin(swing);
  vec2 pf = mat2(ca, -sa, sa, ca) * p;
  vec2 pt = mat2(ca, sa, -sa, ca) * p;

  float df = iconField(pf / max(1.0 - swing * 0.35, 0.5), uFrom);
  float dt = iconField(pt / max(1.0 - swing * 0.35, 0.5), uTo);
  // Interpolating two unrelated fields tears halfway through - the outgoing
  // shape breaks up before the incoming one has assembled.  Eroding the blend
  // at the midpoint (a positive offset shrinks the shape) makes the strokes
  // thin down and swell back out, so the tear happens where there is almost
  // nothing left to tear.  A shallow dip in opacity covers the rest.
  float mid = 1.0 - abs(uMorph * 2.0 - 1.0);
  float d = mix(df, dt, uMorph) + 0.055 * mid;

  float core = smoothstep(0.035, -0.018, d);
  float halo = exp(-max(d, 0.0) * 9.0) * 0.22;
  vec3 colour = uColour * uBrightness * (core * 1.15 + halo * uGlow * 0.4);
  float alpha = clamp(core + halo * 0.32, 0.0, 1.0) * uOpacity * (1.0 - 0.28 * mid);
  gl_FragColor = vec4(colour, alpha);
}`;

// Cubic ease with a touch of overshoot on the way in.
function easeInOut(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function createIconLayer({ position = [0, 0.055, 0.60], size = 0.62 } = {}) {
  const material = new THREE.ShaderMaterial({
    vertexShader, fragmentShader,
    uniforms: {
      uFrom: { value: 0 }, uTo: { value: 0 }, uMorph: { value: 1 },
      uOpacity: { value: 0 }, uGlow: { value: 1 }, uAudio: { value: 0 },
      uTime: { value: 0 },
      uBrightness: { value: 1 },
      uColour: { value: new THREE.Color().setRGB(1.0, 0.87, 0.64, THREE.LinearSRGBColorSpace) },
    },
    transparent: true, depthWrite: false, depthTest: false,
    toneMapped: false, side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), material);
  mesh.position.set(...position);
  // three's transmission backdrop does not carry transparent objects, so an
  // icon drawn with the interior vanished behind the shell. It draws after the
  // shell instead; at this scale the difference in apparent depth is invisible.
  mesh.renderOrder = 40;
  mesh.visible = false;

  const state = {
    current: null, from: 0, to: 0,
    morph: 1, morphSpeed: 3.6,      // ~280ms per shape change
    opacity: 0, fade: 6.0,
    time: 0,
  };

  function show(name) {
    if (name === state.current) return;
    if (name === null) { state.current = null; return; }
    if (!(name in ICON_CODES)) throw new Error(`unknown icon: ${name}`);
    if (state.current !== null) {
      // interrupt mid-morph: start the new one from wherever the shape is now
      state.from = state.morph > 0.5 ? state.to : state.from;
      state.morph = 0;
    } else {
      state.from = ICON_CODES[name];
      state.morph = 1;
    }
    state.to = ICON_CODES[name];
    state.current = name;
  }

  function update(dt, { glow = 1, audio = 0 } = {}) {
    const targetOpacity = state.current === null ? 0 : 1;
    state.opacity += (targetOpacity - state.opacity) * (1 - Math.exp(-state.fade * dt));
    state.morph = Math.min(1, state.morph + state.morphSpeed * dt);
    state.time += dt;

    material.uniforms.uFrom.value = state.from;
    material.uniforms.uTo.value = state.to;
    material.uniforms.uMorph.value = easeInOut(state.morph);
    material.uniforms.uOpacity.value = state.opacity;
    material.uniforms.uGlow.value = glow;
    material.uniforms.uAudio.value = audio;
    material.uniforms.uTime.value = state.time;

    // a gentle settle on arrival, so it lands rather than snaps
    const settle = 0.94 + 0.06 * easeInOut(state.morph) + state.opacity * 0.04;
    mesh.scale.setScalar(settle);
    mesh.visible = state.opacity > 0.004;
  }

  return { mesh, show, update, get icon() { return state.current; }, state };
}
