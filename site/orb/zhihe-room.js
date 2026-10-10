import {DEFAULT_APPEARANCE} from './zhihe-appearance.js';

// Native room lighting only. Do not change the authored standalone/intro look.
// Interior cloud colour and glass transmission are identical in both rooms.
export function roomAppearance(light) {
  return {...DEFAULT_APPEARANCE, daylight:0, sphereFill:1, ...(light
    ? {eyeGlow:.30,ringGlow:.22,sphereGlow:.22}
    : {eyeBrightness:.72,eyeGlow:.18,ringGlyph:1.30,ringInnerRail:1.20,
       ringOuterRail:1.20,ringGlow:.18,sphereRim:1.20,sphereGlow:.16})};
}
