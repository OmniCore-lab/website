// Values are continuous artistic controls; 1 means the authored material scale.
// The UI and renderer share this schema so limits and saved settings agree.
export const APPEARANCE_GROUPS = [
  {id:'eyes', title:'眼睛與資訊圖示', note:'亮度是發光本體；光暈是外圍柔光。', controls:[
    ['eyeBrightness','眼睛亮度',0,3,1],
    ['eyeGlow','眼睛光暈',0,2,.58],
    ['eyeRadius','眼睛擴散',.25,3,1],
  ]},
  {id:'inlays', title:'金環 · 符文與光軌', note:'內、外光軌可各自調亮、變細或隱藏。', controls:[
    ['ringGlyph','符文亮度',0,4,1.8],
    ['ringInnerRail','內光軌亮度',0,4,1.8],
    ['ringOuterRail','外光軌亮度',0,4,1.8],
    ['ringInnerWidth','內光軌粗細',0,2.5,1],
    ['ringOuterWidth','外光軌粗細',0,2.5,1],
  ]},
  {id:'glass', title:'金環 · 玻璃層次', note:'保留環的形狀與折射，只調材質各層的份量。', controls:[
    ['ringBody','玻璃本體',0,2,1],
    ['ringTransmission','透光程度',0,1,1],
    ['ringScatter','內部散光',0,3,1],
    ['ringReflection','內部反射',0,1,1],
    ['ringGlow','金環光暈',0,2,.58],
    ['ringRadius','金環擴散',.25,3,1],
  ]},
  {id:'sphere', title:'球體 · 大氣邊光', note:'球體外緣的亮度與擴散獨立於眼睛和金環。', controls:[
    ['sphereFill','內部填光',0,5,1],
    ['daylight','日光填色',0,1,0],
    ['sphereRim','球體邊光',0,4,1.9],
    ['sphereGlow','球體光暈',0,2,.58],
    ['sphereRadius','球體擴散',.25,3,1],
  ]},
];
export const APPEARANCE_CONTROLS = APPEARANCE_GROUPS.flatMap(g=>g.controls);
export const DEFAULT_APPEARANCE = Object.freeze(Object.fromEntries(APPEARANCE_CONTROLS.map(([key, , , , value])=>[key,value])));
export function normalizeAppearance(patch, base=DEFAULT_APPEARANCE) {
  const result={...base};
  if (!patch || typeof patch !== 'object') return result;
  for (const [key,,min,max] of APPEARANCE_CONTROLS) {
    const value=patch[key];
    if (typeof value==='number' && Number.isFinite(value)) result[key]=Math.max(min,Math.min(max,value));
  }
  return result;
}
export function appearanceFromOptions(options={}) {
  const enabled=options.glow!==false;
  return normalizeAppearance(options.appearance, normalizeAppearance({
    eyeGlow:enabled?(options.bloom??.58):0,
    ringGlow:enabled?(options.bloom??.58):0,
    sphereGlow:enabled?(options.bloom??.58):0,
    sphereRim:enabled?(options.rimGlow??1.9):0,
    ringGlyph:enabled?(options.ringEmission??1.8):1,
    ringInnerRail:enabled?(options.ringEmission??1.8):1,
    ringOuterRail:enabled?(options.ringEmission??1.8):1,
  }));
}
