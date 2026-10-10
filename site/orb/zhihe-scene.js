/**
 * The ported 智核 character as a scene any page can mount.
 *
 * Geometry comes from Blender; realtime transport also uses approximations. The
 * measurement harness in index.html and the app in app.html use the same
 * renderer at different sizes - so a change that improves one cannot silently
 * regress the other.
 */

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { RectAreaLightUniformsLib } from "three/addons/lights/RectAreaLightUniformsLib.js";
import { RGBELoader } from "three/addons/loaders/RGBELoader.js";
import { createZhiheRuntime, ZHIHE_STATES } from "./zhihe-runtime.js";
import { exteriorShellGeometry } from "./zhihe-geometry.js";
import { createRingOptics } from "./zhihe-ring.js";
import { createZhiheBloom } from "./zhihe-bloom.js";
import { createBloomMask } from "./zhihe-bloom-mask.js";
import { appearanceFromOptions, normalizeAppearance } from "./zhihe-appearance.js";
import { createPowerLoop } from './zhihe-power.js';

RectAreaLightUniformsLib.init();

export function createZhiheScene(options = {}) {
  const mobile = options.quality === 'mobile' || options.quality === 'mobile-showcase' || options.quality === 'film';
  const showcase = options.quality === 'mobile-showcase';

  // Source-scene parameters (subsequent compositing also contains fitted values):
  //   camera        Hero_Camera, ORTHO, ortho_scale 3.35, loc (0.1,-7.8,0.3)
  //   view          AgX, exposure 0.05
  //   dome          add_projection_dome(radius 0.976, 42 radial, 192 angular)
  //   crop mapping  scale (0.829346,0.861244) offset (0.085726,0.076156)
  //   radial ramp   EASE 0.472 -> 0.499
  //   luma opacity  SMOOTHERSTEP [0.035,0.72] -> [0,0.88]
  //   emission      strength 0.78, colour from the image
  //   direction     max(0,cos(yaw+t))^16 / (0.785606 + 0.222207*cos(8*yaw))
  // Blender's dome is 42 rings of 192, evenly spaced in rho. Near the rim that
  // is where the surface turns hardest, so the flat quads cut the corner and the
  // fade - which is computed from the interpolated position - steps between
  // them: thin dark seams between bright wedges, all the way round the edge.
  // The UVs are exact at every vertex either way, so more rings, bunched towards
  // the rim, costs nothing but vertices and they are shared across all 86 domes.
  const R = 0.976, RADIAL = mobile ? 64 : 120, ANGULAR = mobile ? 160 : 256;
  const CROP_SCALE = new THREE.Vector2(0.829346, 0.861244);
  const CROP_OFFSET = new THREE.Vector2(0.085726, 0.076156);
  const OPACITY_MAX = 0.88, EMISSION = 0.78;
  const ORTHO = options.orthoSize || 3.35;

  const stage = options.container;
    let width = options.size || 600;
    let height = options.size || 600;
    const api = { modelLoaded: false, lightsLoaded: 0 };
  // Declared up here, not beside the code that fills them: the animation loop
  // starts during setup and touches these on its first frame, and a const
  // declared further down is in its temporal dead zone until then.
  const shellMaterials = new Map();
  const glowMaterials = new Map();
  // Art direction from the supplied concept sheet, independent of transport.
  const appearance = appearanceFromOptions(options);
  let ringOptics = null;
  let disposed = false, powerLoop = null, hostSuspended = false, offscreen = false;
  let videoAllowed = true;
  const ownedTextures = new Set();
  const renderer = new THREE.WebGLRenderer({ antialias: !mobile, alpha: true, premultipliedAlpha: true,   /* 網站版：用瀏覽器標準的預乘 alpha（App 的 WebView 用非預乘；有些顯示卡會把非預乘當預乘合成，光暈整圈爆成紅色） */
    ...(mobile ? {powerPreference:'low-power'} : {}) });
  // WebGL2 alone does not guarantee renderable half-float HDR on old drivers.
  // Fail before allocating the scene so the host can offer its 2D fallback.
  if (!renderer.extensions.has('EXT_color_buffer_float')) {
    renderer.dispose();renderer.forceContextLoss();
    throw new Error('HDR framebuffer support unavailable; use lightweight 2D');
  }
  const floatLinear = renderer.extensions.has('OES_texture_float_linear');
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // The composite pass applies Blender's measured view transform as a LUT and
  // writes display-referred values directly, so the renderer must not tone map or
  // convert on top of it.
  renderer.toneMapping = THREE.NoToneMapping;
  stage.appendChild(renderer.domElement);

  // 33^3 lattice baked through Blender's display pipeline, tiled along x by blue.
  // Sampled raw: its entries are already display-referred.
  const lutTexture = new THREE.TextureLoader().load("./assets/view-transform-lut.png", t => { if (disposed) t.dispose(); });
  ownedTextures.add(lutTexture);
  lutTexture.colorSpace = THREE.NoColorSpace;
  lutTexture.flipY = false;
  lutTexture.minFilter = THREE.LinearFilter;
  lutTexture.magFilter = THREE.LinearFilter;
  lutTexture.wrapS = lutTexture.wrapT = THREE.ClampToEdgeWrapping;
  lutTexture.generateMipmaps = false;

  const scene = new THREE.Scene();
  // Keep the same black RGB transport, but retain coverage for native compositing.
  scene.background = null;

  // Image-based lighting, baked from this very scene so it carries the five
  // authored area lights and their bounce rather than a stock studio HDRI.
  // Without it glass and metal have nothing to reflect and read as grey film —
  // which is what no amount of hand-written fresnel could fix, because the
  // missing piece was the reflected content, not the formula.
  let equirectEnv = null, environmentTarget = null;

  /** Box-downsample an equirectangular float probe into a small DataTexture. */
  function blurEquirect(source, width, height) {
    const src = source.image;
    const data = src.data;
    const channels = data.length / (src.width * src.height);
    const out = new Float32Array(width * height * 4);
    const sx = src.width / width, sy = src.height / height;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let r = 0, g = 0, b = 0, n = 0;
        for (let j = Math.floor(y * sy); j < Math.floor((y + 1) * sy); j++) {
          for (let i = Math.floor(x * sx); i < Math.floor((x + 1) * sx); i++) {
            const o = (j * src.width + i) * channels;
            r += data[o]; g += data[o + 1]; b += data[o + 2]; n++;
          }
        }
        const o = (y * width + x) * 4;
        out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 1;
      }
    }
    // 同上：沒有 OES_texture_float_linear（Mali）就用半精度，不然取樣全黑
    const texture = floatLinear ? new THREE.DataTexture(out, width, height, THREE.RGBAFormat, THREE.FloatType)
      : new THREE.DataTexture(Uint16Array.from(out, v => THREE.DataUtils.toHalfFloat(v)), width, height, THREE.RGBAFormat, THREE.HalfFloatType);
    texture.minFilter = texture.magFilter = THREE.LinearFilter;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.colorSpace = THREE.NoColorSpace;
    texture.needsUpdate = true;
    return texture;
  }
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  // Float, not the default half float: the downsampler below reads the buffer
  // directly, and half-float bit patterns read as integers come out astronomically
  // large — the shell rendered a flat 255 everywhere.
  new RGBELoader().setDataType(THREE.FloatType).load("./assets/environment.hdr", (hdr) => {
    if (disposed) { hdr.dispose(); return; }
    hdr.mapping = THREE.EquirectangularReflectionMapping;
    // 環境光貼圖是 32 位元浮點：不支援浮點線性過濾的 GPU（Mali）改最近點取樣（後面 PMREM 會再模糊），不然整張是黑的
    hdr.minFilter = floatLinear ? THREE.LinearFilter : THREE.NearestFilter;
    hdr.magFilter = floatLinear ? THREE.LinearFilter : THREE.NearestFilter;
    hdr.generateMipmaps = false;
    // A mirror sample of the raw probe is what made the analytic shell explode:
    // its radiance reaches 22, so at grazing angles fresnel*env blows past white.
    // A rough surface integrates over a wide lobe, so the shells sample a heavily
    // box-downsampled copy instead — the cheap equivalent of a prefiltered mip,
    // and enough to turn the light rectangles back into a soft gradient.
    equirectEnv = blurEquirect(hdr, 48, 24);
    ownedTextures.add(equirectEnv);
    environmentTarget = pmrem.fromEquirectangular(hdr);
    scene.environment = environmentTarget.texture;
    ownedTextures.add(scene.environment);
    hdr.dispose();
    scene.environmentIntensity = 0.35;
    api.environmentLoaded = true;
    syncDirectLights();
  });

  // The probe was rendered from these very lights, so leaving them switched on
  // lights every surface twice: measured 122% of the reference on the ring and
  // 110% on the sphere, with both pulled toward the average of the warm key and
  // the blue rims. Image-based lighting means the image *is* the lighting.
  //
  // The environment and the light list load independently, so whichever arrives
  // second has to do this — doing it only in the HDR callback silently did
  // nothing whenever the HDR won the race.
  const GLASS_LAYER = 1;
  let useDirectLights = true;
  function syncDirectLights() {
    const on = useDirectLights || !api.environmentLoaded;
    areaLights.forEach(l => { l.visible = on; });
  }

  // Cycles tone maps the composited image, not each surface. Alpha-blending eight
  // transparent domes and tone mapping per fragment gives sum(a*AgX(E)) where
  // Blender gives AgX(sum(a*E)) — different results on a black background. So the
  // scene is composited linearly into a float target and AgX is applied once.
  // Cycles reconstructs each output pixel with a Blackman-Harris filter of width
  // 1.5px, which is what gives thin emissive geometry its soft warm bleed. A
  // render target gets no antialiasing from the renderer's `antialias` flag, so
  // without this the glyphs and rails render as hard thin lines: measured 9645
  // lit pixels against Blender's 15876. The scene is therefore supersampled and
  // resolved with the same filter rather than box-averaged.
  // Quality tiers. The reference tier reproduces Cycles' reconstruction closely
  // but renders 1800x1800 with a 49-tap resolve, which a 2018 phone cannot do.
  // The mobile tier drops the supersample and the tap count; everything that
  // carries the look — the projected artwork, the model, the view-transform LUT —
  // is unchanged, so it degrades in sharpness rather than in character.
  // budget is in FINAL samples, not output pixels, because the supersampled
  // buffer is what a frame actually costs: at 3x a 1920-wide stage asks for
  // 5760x2940, twenty-six times the 1800x1800 this port was measured at, and
  // the loop fell to about six frames a second. Trading device pixels away
  // keeps the reconstruction filter the thin glyphs and rails depend on.
  const QUALITY = {
    // For looking at the sampling, not for shipping: four times the samples per
    // pixel and a budget to match, so a defect can be told apart from an
    // artefact of how coarsely the frame is being sampled.
    ultra:  { supersample: 4, taps: 9, msaa: 8, budget: 12.0e6 },
    high:   { supersample: 3, taps: 7, msaa: 4, budget: 4.2e6 },
    medium: { supersample: 2, taps: 5, msaa: 4, budget: 3.2e6 },
    low:    { supersample: 1, taps: 3, msaa: 4, budget: 0.9e6 },
    mobile: { supersample: 1, taps: 3, msaa: 2, budget: 0.36e6 },
    'mobile-showcase': { supersample: 1, taps: 3, msaa: 2, budget: 0.64e6 },
    // Offline output; preserve phone transport, spend pixels instead of time.
    film: { supersample: 1, taps: 3, msaa: 0, budget: 2.36e6 },
  };
  // The msaa override exists for the coordinate passes: multisampling averages
  // whatever the shader wrote, which is right for colour and wrong for a
  // position written as a number.
  const quality = { ...(QUALITY[options.quality] || QUALITY.high) };
  if (options.msaa !== undefined) quality.msaa = options.msaa;
  const SUPERSAMPLE = quality.supersample;
  // Clamp before the first allocation, not only on resize: mounting at a 1920
  // stage asked for a 5760x5760 half-float MSAA target - over a gigabyte - and
  // the driver never recovered even after the target was replaced.
  [width, height] = fitToBudget(width, height);
  // Cycles' filter is 1.5px wide, but seven taps across +/-1 output pixel is a
  // much coarser discretisation than its continuous kernel, and each tap already
  // box-integrates one supersampled texel. Swept against the rails reference, the
  // error minimum sits at a nominal 2.5 (RMS 0.85% and IoU 0.948, against 2.93%
  // and 0.756 at a nominal 1.5): the nominal width is not the effective width.
  const FILTER_WIDTH = 2.5;
  const TAPS = quality.taps;   // odd, so one tap sits at the filter peak
  // Legacy Low keeps its old reflection-only sphere. Both new mobile modes
  // retain refraction: pixel budget, geometry and cadence carry the savings.
  const refractionEnabled = options.refraction !== undefined
    ? options.refraction : mobile || quality.supersample > 1;
  const refractors = [];
  let backdropTarget = null;

  let linearTarget = new THREE.WebGLRenderTarget(width * SUPERSAMPLE, height * SUPERSAMPLE, {
    type: THREE.HalfFloatType,
    colorSpace: THREE.NoColorSpace,
    depthBuffer: true,
    samples: quality.msaa,
  });
  function makeBackdrop() {
    return new THREE.WebGLRenderTarget(width * SUPERSAMPLE, height * SUPERSAMPLE, {
      type: THREE.HalfFloatType, colorSpace: THREE.NoColorSpace,
      depthBuffer: true, samples: quality.msaa,
    });
  }
  backdropTarget = makeBackdrop();

  function blackmanHarris(offsetPixels) {
    const radius = FILTER_WIDTH / 2;
    if (Math.abs(offsetPixels) > radius) return 0;
    const t = offsetPixels / FILTER_WIDTH + 0.5;
    return 0.35875
      - 0.48829 * Math.cos(2 * Math.PI * t)
      + 0.14128 * Math.cos(4 * Math.PI * t)
      - 0.01168 * Math.cos(6 * Math.PI * t);
  }
  // Taps spread across the whole filter support, in supersampled pixels. Four
  // taps at +/-0.5 and +/-1.5 were not enough: Blackman-Harris is ~0 at its edge,
  // so the outer pair carried no weight and the resolve collapsed to a half-pixel
  // box, far narrower than Cycles' 1.5px reconstruction.
  const tapSS = Array.from({ length: TAPS }, (_, i) => i - (TAPS - 1) / 2);
  let filterWidth = FILTER_WIDTH;

  function resolveWeights(width) {
    const radius = width / 2;
    const w = tapSS.map((o) => {
      const x = o / SUPERSAMPLE;
      if (Math.abs(x) > radius) return 0;
      const t = x / width + 0.5;
      return 0.35875
        - 0.48829 * Math.cos(2 * Math.PI * t)
        + 0.14128 * Math.cos(4 * Math.PI * t)
        - 0.01168 * Math.cos(6 * Math.PI * t);
    });
    const sum = w.reduce((a, b) => a + b, 0);
    return w.map(v => v / sum);
  }
  const tapWeights = resolveWeights(FILTER_WIDTH);
  const bloom = createZhiheBloom(renderer, width, height, {mobile});
  const bloomMask = createBloomMask(renderer, width, height, {mobile});

  const compositeScene = new THREE.Scene();
  const compositeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  compositeScene.add(new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.ShaderMaterial({
      defines: { TAPS: TAPS },
      uniforms: {
        uScene: { value: linearTarget.texture },
        uTexel: { value: new THREE.Vector2(1 / (600 * SUPERSAMPLE), 1 / (600 * SUPERSAMPLE)) },
        uTaps: { value: new Float32Array(tapSS) },
        uWeights: { value: new Float32Array(tapWeights) },
        uLut: { value: lutTexture },
        uRaw: { value: 0 },
        uNativeComposite: { value: options.nativeComposite ? 1 : 0 },
        uHeadScreen: { value: new THREE.Vector4(.5,.5,.25,.25) },
        uBloom0: {value: bloom.textures[0]}, uBloom1: {value: bloom.textures[1]},
        uBloom2: {value: bloom.textures[2]}, uBloom3: {value: bloom.textures[3]}, uBloom4: {value: bloom.textures[4]},
        uBloomGains: {value: new THREE.Vector3(appearance.eyeGlow,appearance.ringGlow,appearance.sphereGlow)},
        uBloomRadii: {value: new THREE.Vector3(appearance.eyeRadius,appearance.ringRadius,appearance.sphereRadius)},
      },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: `
        uniform sampler2D uScene;
        uniform sampler2D uLut;
        uniform vec2 uTexel;
        uniform float uTaps[TAPS];
        uniform float uWeights[TAPS];
        uniform float uRaw;
        uniform float uNativeComposite;
        uniform vec4 uHeadScreen;
        uniform sampler2D uBloom0,uBloom1,uBloom2,uBloom3,uBloom4;
        uniform vec3 uBloomGains,uBloomRadii;
        varying vec2 vUv;

        const float LUT_N = 33.0;
        const float LUT_W = 33.0 * 33.0;
        const float LOG_MIN = -12.0;
        const float LOG_SPAN = 18.0;

        // Blender's own view transform, measured rather than reimplemented. The
        // LUT already contains AgX, the Medium High Contrast look and the +0.05
        // exposure, and its entries are display-referred, so nothing further is
        // applied to the result.
        vec3 viewTransform(vec3 lin){
          vec3 t = clamp((log2(max(lin, vec3(exp2(LOG_MIN)))) - LOG_MIN) / LOG_SPAN, 0.0, 1.0);
          float slice = t.b * (LUT_N - 1.0);
          float s0 = floor(slice);
          float s1 = min(s0 + 1.0, LUT_N - 1.0);
          float f = slice - s0;
          float xInTile = 0.5 + t.r * (LUT_N - 1.0);
          // rows run bottom-up in the baked image, so green is addressed inverted
          float v = (LUT_N - 0.5 - t.g * (LUT_N - 1.0)) / LUT_N;
          vec3 a = texture2D(uLut, vec2((s0 * LUT_N + xInTile) / LUT_W, v)).rgb;
          vec3 b = texture2D(uLut, vec2((s1 * LUT_N + xInTile) / LUT_W, v)).rgb;
          return mix(a, b, f);
        }

        void main(){
          // Data, not a picture: one centre tap and no view transform, so debug
          // channels come back exactly as the shader wrote them. Read through
          // the normal path they went through AgX and the reconstruction filter,
          // and the ring bake was built on the result.
          if (uRaw > 0.5) {
            gl_FragColor = vec4(texture2D(uScene, vUv).rgb, 1.0);
            return;
          }
          vec3 sum = vec3(0.0);
          for (int y = 0; y < TAPS; y++) {
            for (int x = 0; x < TAPS; x++) {
              vec2 off = vec2(uTaps[x], uTaps[y]) * uTexel;
              sum += texture2D(uScene, vUv + off).rgb * (uWeights[x] * uWeights[y]);
            }
          }
          // Continuous radius: shift each category's energy towards coarser
          // pyramid levels, independently, while normalising total gain.
          vec3 k=exp((uBloomRadii-1.0)*.95);
          vec3 w0=vec3(.48),w1=.28*k,w2=.14*k*k,w3=.07*k*k*k,w4=.03*k*k*k*k;
          vec3 e=(texture2D(uBloom0,vUv).rgb*w0+texture2D(uBloom1,vUv).rgb*w1
            +texture2D(uBloom2,vUv).rgb*w2+texture2D(uBloom3,vUv).rgb*w3+texture2D(uBloom4,vUv).rgb*w4)/(w0+w1+w2+w3+w4)*uBloomGains;
          vec3 glow=e.r*vec3(1.0,.52,.16)+e.g*vec3(1.0,.72,.32)+e.b*vec3(.56,.72,1.0);
          // The halo must disappear before the movable WebView boundary, not
          // reveal a rectangular patch when the ring stands upright.
          float edge = min(min(vUv.x, 1.0-vUv.x), min(vUv.y, 1.0-vUv.y));
          glow *= smoothstep(0.0, 0.10, edge);
          vec3 outCol = viewTransform(sum+glow);
          // 宿主要把角色疊在自己的介面上，所以最後這一關要輸出 alpha。
          // 角色是黑底上的發光體，用亮度推 alpha，暗處讓底色透出來。
          float lum = max(max(outCol.r, outCol.g), outCol.b);
          float coverage = clamp(texture2D(uScene, vUv).a, 0.0, 1.0);
          float outA = max(coverage, clamp(lum, 0.0, 1.0));
          // HDR additive layers write alpha even where radiance is zero.
          // Only the real head silhouette may occlude the host room; luminous
          // atmosphere and glass outside it must not bring a black backdrop.
          if (uNativeComposite > .5) {
            float headDistance = length((vUv-uHeadScreen.xy)/uHeadScreen.zw);
            float headCoverage = 1.0-smoothstep(.985,1.008,headDistance);
            outA = max(clamp(lum,0.0,1.0),coverage*headCoverage);
          }
          // 網站版：輸出預乘過的顏色（顏色不超過 alpha），不再除以 alpha
          gl_FragColor = vec4(min(clamp(outCol, 0.0, 1.0), vec3(outA)), outA);
        }`,
      toneMapped: false,
      transparent: false,
      depthTest: false,
      depthWrite: false,
    })
  ));

  // Orthographic, exactly as Blender. A narrow-FOV perspective camera was used
  // while the shell relied on three's transmission, which is only correct for a
  // perspective view — but even at 4.8 degrees it displaced the ring by a few
  // pixels, and on geometry that thin a small shift collapses overlap: the glyphs
  // scored an IoU of 0.10 against the reference while their brightness matched.
  // The shell no longer uses transmission, so the projection can be exact again.
  const half = ORTHO / 2;
  const camera = new THREE.OrthographicCamera(-half, half, half, -half, 0.1, 100);
  const CAMERA_REST = new THREE.Vector3(0.1, 0.3, 7.8);
  const CAMERA_TARGET = new THREE.Vector3(0, -0.02, 0);
  camera.position.copy(CAMERA_REST);
  camera.lookAt(CAMERA_TARGET);

  // Blender's frame is square, and the character fills it. Whichever way the
  // stage is the narrower one has to keep the 3.35 extent, or the ring - which is
  // wider than the sphere - runs off the edge: on a phone in portrait it was
  // clipped on both sides.
  function applyProjection() {
    const aspect = width / height;
    const w = half * Math.max(aspect, 1);
    const h = half * Math.max(1 / aspect, 1);
    camera.left = -w; camera.right = w;
    camera.top = h; camera.bottom = -h;
    camera.updateProjectionMatrix();
  }
  applyProjection();

  // Turning the model and turning the camera are the same picture, except that
  // the eight artwork domes are weighted by which way the camera faces - so the
  // orbit angle has to reach the dome weighting as well, or the atmosphere would
  // stay pinned to the front while everything else moved.
  let orbitYaw = 0, orbitPitch = 0;
  function setOrbit(y, p = orbitPitch) {
    orbitYaw = y;
    orbitPitch = THREE.MathUtils.clamp(p, -0.55, 0.55);
    const flat = Math.hypot(CAMERA_REST.x, CAMERA_REST.z);
    const lift = CAMERA_REST.y;
    // Positive pitch lowers the camera, which is the sense render_view.py uses
    // in Blender. It had been the other way round here, so every tilt render
    // was being compared against the opposite view: the port's +30 was Cycles'
    // -30, and the frames disagreed by 54% of a level.
    const cp = Math.cos(orbitPitch), sp = -Math.sin(orbitPitch);
    const base = Math.atan2(CAMERA_REST.x, CAMERA_REST.z) + orbitYaw;
    camera.position.set(Math.sin(base) * flat * cp,
                        lift * cp + flat * sp,
                        Math.cos(base) * flat * cp);
    camera.lookAt(CAMERA_TARGET);
    yaw = orbitYaw;
  }

  // Blender builds the dome by orthographic projection: the UV of a vertex is
  // simply its position on the projection plane remapped to 0..1, which is why
  // the artwork lands exactly as authored under an orthographic camera.
  function projectionDome(radius) {
    const positions = [0, 0, radius];
    const uvs = [0.5, 0.5];
    const indices = [];
    for (let ri = 1; ri <= RADIAL; ri++) {
      // bunched towards the rim, where the curvature is
      const rho = 0.995 * Math.sin(0.5 * Math.PI * ri / RADIAL);
      const depth = radius * Math.sqrt(Math.max(0, 1 - rho * rho));
      for (let ai = 0; ai < ANGULAR; ai++) {
        const a = 2 * Math.PI * ai / ANGULAR;
        const h = rho * Math.cos(a), v = rho * Math.sin(a);
        positions.push(radius * h, radius * v, depth);
        uvs.push(0.5 + 0.5 * h, 0.5 + 0.5 * v);
      }
    }
    for (let ai = 0; ai < ANGULAR; ai++) {
      indices.push(0, 1 + ai, 1 + (ai + 1) % ANGULAR);
    }
    for (let ri = 1; ri < RADIAL; ri++) {
      const inner = 1 + (ri - 1) * ANGULAR, outer = 1 + ri * ANGULAR;
      for (let ai = 0; ai < ANGULAR; ai++) {
        const n = (ai + 1) % ANGULAR;
        indices.push(inner + ai, outer + ai, outer + n);
        indices.push(inner + ai, outer + n, inner + n);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(indices);
    return g;
  }

  const vertexShader = /* glsl */`
  varying vec2 vUv;
  varying vec3 vDomeWorld;
  uniform mat4 uWorldToHead;
  void main(){
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vDomeWorld = (uWorldToHead * world).xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }`;

  const fragmentShader = /* glsl */`
  uniform sampler2D uMap;
  uniform sampler2D uAlpha;
  uniform vec2 uCropScale;
  uniform vec2 uCropOffset;
  uniform float uOpacityMax;
  uniform float uEmission;
  uniform float uDirWeight;
  uniform vec2 uRadial;
  uniform vec3 uViewDir;
  uniform float uLoopGain;
  uniform sampler2D uLoopResidualMap;
  uniform float uLoopPhase;
  uniform float uLoopGainAmount;
  varying vec2 vUv;
  varying vec3 vDomeWorld;

  float smootherstep(float e0, float e1, float x){
    float t = clamp((x - e0) / (e1 - e0), 0.0, 1.0);
    return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
  }

  // three decodes sRGB through the texture's internal format, which a VideoTexture
  // does not get, and a raw ShaderMaterial gets no decode injected either. Sampling
  // both sources raw and converting here keeps the still and video paths identical;
  // otherwise the video renders 2.24x too bright because its encoded values are
  // used as if they were linear.
  vec3 srgbToLinear(vec3 c){
    return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
  }

  void main(){
    vec2 cuv = vUv * uCropScale + uCropOffset;
    // Applied here, before the opacity curve, not to the result after it. The
  // curve is a steep smootherstep, so a frame that is slightly dimmer overall
  // falls down it and loses far more opacity than its dimming alone - which is
  // why Blender's own 288 frames vary by 1.15x while the port varied by 1.52x
  // from the same source. Normalising what feeds the curve holds every frame at
  // the same operating point.
  // Sampled straight. The speckled ring along the limb is not a sampling
  // problem - four times the samples moved it from 10.50 to 10.39 - not the
  // matte, whose hard disc edge sits outside what the crop reaches, and not
  // texture filtering either: hardware anisotropy at 16x changed it by nothing.
  // Averaging radially at grazing in the shader made it worse, 15.2, because
  // the taps walk across the fade. What is left of it is small - the angular
  // high-frequency energy round the silhouette now runs 101% to 116% of
  // Cycles' across the outer fifth of the disc, against the 150% it was.
  // One scalar per frame cannot hold the loop steady, because the bands do not
  // pulse together: over the loop the core swings 2.01x, the mid 1.35x and the
  // limb only 1.17x, and they peak at different times. A scalar fitted on the
  // whole frame dragged the limb - the part the eye reads as the atmosphere -
  // from 1.17x out to 1.56x, worse than doing nothing, and a table on texture
  // radius corrects the texture rather than the screen. What the eye reads is a
  // screen radius, and every fragment on screen is fed by whichever domes face
  // that way, so the correction is indexed by how the fragment faces the
  // camera: the same space the swing was measured in, and right at any orbit.
  //
  // The target is not a flat loop. Cycles' own 288 frames swing too - 1.50x at
  // the boundary, 1.25x at the limb - and the port's raw loop already tracks
  // them at a correlation of 0.988. Flattening it outright improved every
  // summary statistic and was a step away from the render. What is corrected is
  // the difference from Cycles, band by band.
  float lgFacing = clamp(dot(normalize(vDomeWorld), uViewDir), 0.0, 1.0);
  float lgRes = texture2D(uLoopResidualMap, vec2(lgFacing, uLoopPhase)).r * 1.6 + 0.4;
  float lg = mix(1.0, lgRes, uLoopGainAmount) * uLoopGain;
  vec3 rgb = srgbToLinear(texture2D(uMap, cuv).rgb) * lg;
    float texAlpha = texture2D(uAlpha, cuv).r;

    // Blender's ColorRamp is driven by the uncropped UV distance from centre.
    // Blender fades the artwork on the dome's own UV radius, which coincides
    // with the sphere's limb only while the camera sits on that dome's axis.
    // Off-axis the fade circle tilts away from the silhouette and leaves a dark
    // crescent down one side, very visible as soon as the view is dragged.
    // Measured from how the surface faces the camera it lands on the limb from
    // every angle, and at the hero view the two agree: the ramp's 0.482 and
    // 0.5015 in UV are a facing of 0.266 and 0.
    float radial = smoothstep(0.0, uRadial.x, dot(normalize(vDomeWorld), uViewDir));
    float luma = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
    float lumaOpacity = uOpacityMax * smootherstep(0.035, 0.72, luma);

    float a = texAlpha * radial * lumaOpacity * uDirWeight;
    // Mix(Transparent, Emission, a) is ordinary alpha blending with the
    // emission radiance as the source colour, so no premultiply here.
    gl_FragColor = vec4(rgb * uEmission, a);
  }`;

  const loader = new THREE.TextureLoader();
  function tex(url, srgb, mips) {
    const t = loader.load(url, loaded => { if (disposed) loaded.dispose(); });
    ownedTextures.add(t);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = !!mips;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  }

  const stillMap = tex("./assets/flow-frame001.png", false, true);  // decoded in the shader
  const alphaMap = tex("./assets/atmosphere-alpha-512.png", false, true);
  // 32 facing bins across 288 loop frames, gain stored as (g - 0.4) / 1.6 so 8
  // bits cover 0.4..2.0 at 0.6% a step - below anything the eye reads as a
  // flicker. flipY is on by default, and this is data, not a picture: left as
  // it comes the loop phase reads backwards down the image and the correction
  // lands on the wrong frames, which turned a 1.65x swing into 1.90x.
  const loopResidualMap = tex("./assets/loop-residual.png", false);
  loopResidualMap.wrapT = THREE.RepeatWrapping;
  loopResidualMap.flipY = false;
  function ringBakeTex(url) {
    const t = tex(url, false);
    t.flipY = false;
    return t;
  }
  const fillProfileMap = tex("./assets/fill-profile.png", false);
  fillProfileMap.flipY = false;

  // The loop lives with the scene rather than in the page, so every host gets
    // the same motion without having to remember the markup.
    const videoEl = document.createElement("video");
    videoEl.loop = videoEl.muted = videoEl.playsInline = true;
    videoEl.preload = "auto";
    videoEl.style.display = "none";
    // Re-encoded at constant quality. The first loop was VP9 at about 156 kbps
    // and the codec spent it on the keyframes: sampling the video's own frames
    // showed their sharpness swinging 1.73x between them, which is exactly the
    // atmosphere thinning out and coming back while the animation runs. The
    // 1024px source frames vary by 1.13x, so all of that was the encode.
    const videoSources = [["./assets/atmosphere-flow-512-hq.webm", "video/webm"],
                          ["./assets/atmosphere-flow-512-hq.mp4", "video/mp4"]];
    // Prefer H.264 on mobile; retain the HQ source to avoid codec pulsing in
    // the atmosphere. Companion mode stops decoding when it settles to idle.
    if (mobile) videoSources.reverse();
    for (const [src, type] of videoSources) {
      const s = document.createElement("source"); s.src = src; s.type = type;
      videoEl.appendChild(s);
    }
    document.body.appendChild(videoEl);
  const videoMap = new THREE.VideoTexture(videoEl);
  ownedTextures.add(videoMap);
  videoMap.colorSpace = THREE.NoColorSpace;   // decoded in the shader
  videoMap.minFilter = THREE.LinearMipmapLinearFilter;
  videoMap.magFilter = THREE.LinearFilter;
  videoMap.generateMipmaps = true;
  // 影片貼圖要等「真的有一格送進來」才能用。只看「設定成用影片」的話，影片還沒解出第一格（剛載入、
  // 被省電策略先暫停、裝置解不了）時球面是空的——使用者 2026-10-05 回報「貼圖有時候不見」就是這個。
  // 沒有畫面之前一律用靜態那張。
  let videoHasFrame = false;
  const sawVideoFrame = () => { videoHasFrame = true; };
  if (typeof videoEl.requestVideoFrameCallback === "function") videoEl.requestVideoFrameCallback(sawVideoFrame);
  else videoEl.addEventListener("timeupdate", sawVideoFrame, { once: true });
  const videoLive = () => useVideo.checked && videoHasFrame && videoEl.readyState >= 2 && !videoEl.error;
  // The right filter for a surface seen at grazing, where the UV is compressed
  // along one axis and not the other. It is not what the speckled ring round
  // the limb is, though: at 16x the angular high-frequency energy round the
  // silhouette came back identical to three decimals. Kept because it is
  // correct and costs nothing, not because it fixed anything.
  const maxAniso = Math.min(renderer.capabilities.getMaxAnisotropy(), mobile ? 2 : Infinity);
  videoMap.anisotropy = maxAniso;
  stillMap.anisotropy = maxAniso;
  alphaMap.anisotropy = maxAniso;

  // Blender ships eight strata, all round the equator, and its crossfade is a
  // cos^16 lobe with a hand-fitted normaliser that only holds for that ring.
  // Eight at 45 degrees apart is coarse - the lobe is nearly closed by 22
  // degrees off-axis - and there is nothing at all above or below, so tilting
  // the view ran off the set. The directions are a parameter here instead, and
  // the weights normalise themselves over whatever set is given, which is what
  // lets the ring be denser and lets it carry rings above and below it.
  function directionSet(rings) {
    const out = [];
    for (const [count, elevationDeg, phase] of rings) {
      const elevation = elevationDeg * Math.PI / 180;
      for (let i = 0; i < count; i++) {
        const yaw = (i + (phase || 0)) * 2 * Math.PI / count;
        out.push(new THREE.Vector3(
          Math.sin(yaw) * Math.cos(elevation),
          Math.sin(elevation),
          Math.cos(yaw) * Math.cos(elevation)));
      }
    }
    return out;
  }
  // Every dome carries the same artwork, so two of them at half weight are two
  // copies of it rotated apart: the union covers more and the peaks stop
  // coinciding, which is why the atmosphere flattened into haze mid-turn. With
  // Blender's eight, sweeping one crossfade moved the mean by 10.3 and dropped
  // the peak by 27. Closing the spacing is what fixes it - neighbours differ by
  // less, so there is less to smear - and at 15 degrees apart the same sweep
  // moves the mean by 0.5 and the peak by 3. The cost is nothing: only three to
  // six of these are ever above the weight cull.
  const DOME_RINGS = options.domeRings || [
    [24, 0, 0],
    [18, 30, 0.5], [18, -30, 0.5],   // offset so they do not stack on the equator
    [12, 58, 0], [12, -58, 0],
    [1, 90, 0], [1, -90, 0],
  ];
  const DOME_DIRECTIONS = directionSet(DOME_RINGS);
  // How quickly one stratum hands over to the next. Every dome carries the same
  // artwork, so two of them at half weight are two copies of it rotated apart:
  // the union covers more and the peaks stop coinciding, which is why the
  // atmosphere turns to flat haze mid-turn. A sharper lobe keeps one dome
  // dominant across most of its sector and shortens that smear.
  // Sharp enough that one stratum really does dominate. Every dome carries the
  // same artwork, so whatever weight the others hold is a second copy of it
  // rotated apart - a ghost. At 64 the leading dome held only 0.817 and the
  // remaining 18% smeared the wisps into haze; at 110 it holds 0.955 and the
  // interior goes from 6.85 to 8.57 of local contrast. The dip that a sharp
  // lobe used to cause is gone anyway, because at 15 degrees apart the two
  // copies being crossfaded are nearly the same picture.
  const DOME_LOBE = options.domeLobe || 110;

  const geometry = projectionDome(R);
  const domes = [];
  for (let i = 0; i < DOME_DIRECTIONS.length; i++) {
    const material = new THREE.ShaderMaterial({
      vertexShader, fragmentShader,
      uniforms: {
        uMap: { value: stillMap },
        uAlpha: { value: alphaMap },
        uCropScale: { value: CROP_SCALE },
        uCropOffset: { value: CROP_OFFSET },
        uOpacityMax: { value: OPACITY_MAX },
        uEmission: { value: EMISSION },
        uDirWeight: { value: 0 },
        // Blender's ColorRamp is 0.472 -> 0.499, and at those values the port
        // fell to 70% of the reference over the last eight pixels inside the
        // glass while sitting at 112% just inside that. The difference is
        // refraction: a real glass ball compresses its whole interior into that
        // band, and it is the brightest part of Cycles' sphere. The analytic
        // shell cannot refract, and three's screen-space transmission is no
        // help - it is wrong under an orthographic camera. Adding a grazing
        // term to the shell instead only spilled light past the silhouette
        // (18.7 where the reference is 11.8), so the artwork's own fade is
        // moved outward by the width of that band: 97% of the reference there,
        // and the whole frame from 6.35% error to 6.24%.
        uRadial: { value: new THREE.Vector2(0.266, 0.0) },
        uLoopGain: { value: 1 },
        uLoopResidualMap: { value: loopResidualMap },
        uLoopPhase: { value: 0 },
        uLoopGainAmount: { value: 0 },
        uViewDir: { value: new THREE.Vector3(0, 0, 1) },
        uWorldToHead: { value: new THREE.Matrix4() },
      },
      transparent: true,
      depthWrite: false,
      // Depth testing was off so the domes would always show while the rest of the
      // scene was being built. Left on, it paints them over everything — including
      // the ring's near arc, which should occlude them where it crosses in front.
      depthTest: true,
      side: THREE.DoubleSide,
      toneMapped: false,   // linear radiance into the float target; AgX comes later
    });
    const mesh = new THREE.Mesh(geometry, material);
    orientDome(mesh, DOME_DIRECTIONS[i]);
    mesh.renderOrder = 10 + i * 0.01;
    scene.add(mesh);
    domes.push(mesh);
  }

  // Blender's LiftedArtwork_OpenVDB - the artwork lifted into a VDB - fills the
  // sphere with a soft blue light, and it was never ported: glTF drops VOLUME
  // objects, and only the eight artwork domes were reproduced by hand. Hiding it
  // in Blender and re-rendering measured what it is worth inside the sphere:
  // +13.33 luminance, split (4.42, 14.10, 32.06) across the channels, against a
  // port that was short by (7.35, 12.59, 28.02). It is the whole of the interior
  // gap - the darkness, the missing blue, and the warm flecks of the artwork
  // showing through unveiled - and not the multi-bounce transport it looked like.
  //
  // It resists modelling. It is not radially symmetric (17-49% angular spread at
  // every radius), and no emissive-absorbing radial medium fits its profile: the
  // best fit left an RMS of 0.13 against a peak of 0.61. What it is, is static
  // and smooth, so its own linear radiance is baked and replayed on the same
  // projection domes the artwork already uses - which is what carries it
  // correctly when the model turns.
  const FILL_SCALE = 0.25;                    // the bake's encoding range
  const FILL_GAIN = 1.0;
  const fillMap = tex("./assets/volume-fill-512.png", false);
  const veilMap = tex("./assets/volume-veil-512.png", false);
  const fillGeometry = projectionDome(1.0);   // the VDB's own bounds are +-1.005
  const fillDomes = [];
  const veilDomes = [];

  // The volume both glows and blocks. Added alone it overshot the frame by
  // +28.76 where Blender gains +13.33, because its emission is largely cancelled
  // by its absorption of everything behind it. Its solo render is not the term to
  // add either: by itself it is brighter in blue (0.376) than the whole scene
  // containing it (0.213), since the shell, the core and the backdrop attenuate
  // its light on the way out. What is baked is its net effect where it sits,
  // W = E + T*B against the linear frames rendered with and without it - two
  // unknowns from one equation, separable only because E and T are smooth while B
  // carries the artwork's structure, so a local regression of W on B splits them.
  // Reconstruction lands on (0.2452, 0.1924, 0.2125) against a truth of
  // (0.2452, 0.1924, 0.2127). T comes out coloured - (0.93, 0.86, 0.72) - so it
  // cannot ride on a scalar alpha and takes its own multiply pass first.
  for (let i = 0; i < DOME_DIRECTIONS.length; i++) {
    const veil = new THREE.Mesh(fillGeometry, new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader: /* glsl */`
        uniform sampler2D uMap; uniform float uDirWeight;
        uniform vec3 uViewDir;
        uniform float uEdgeAmp; uniform vec2 uEdgeAt; uniform float uEdgeWidth;
        varying vec2 vUv;
        varying vec3 vDomeWorld;
        void main(){
          // every dome carries one map, so each applies its share of the veil
          vec3 t = mix(vec3(1.0), texture2D(uMap, vUv).rgb, uDirWeight);

          // The boundary. Cycles has a distinct edge partway out - its profile
          // peaks at 110 around r=146 and falls to 83 by r=156, a step of 27 -
          // and the port only reaches 19 of that on its own. Expressed in how
          // the surface faces the camera rather than in screen radius, so it
          // stays put when the model turns. It rides here because the veil
          // multiplies, and a multiply can lift one side and drop the other;
          // an additive layer could only ever brighten.
          float facing = dot(normalize(vDomeWorld), uViewDir);
          // The dip carries more of it than the peak, because Cycles gets its
          // step by dropping to 83 rather than by climbing past 110.
          float up = exp(-pow((facing - uEdgeAt.x) / uEdgeWidth, 2.0));
          float dn = exp(-pow((facing - uEdgeAt.y) / uEdgeWidth, 2.0));
          t *= 1.0 + uEdgeAmp * (0.55 * up - 1.0 * dn) * uDirWeight;
          gl_FragColor = vec4(t, 1.0);
        }`,
      uniforms: {
        uMap: { value: veilMap }, uDirWeight: { value: 0 },
        uViewDir: { value: new THREE.Vector3(0, 0, 1) },
        uWorldToHead: { value: new THREE.Matrix4() },
        // r=146 and r=156 of a 176px ball, as facing values
        uEdgeAt: { value: new THREE.Vector2(0.558, 0.463) },
        uEdgeWidth: { value: 0.045 },
        // 0.30 lands on peak 114 / dip 85.6 / step 28.3 against Cycles' 110.4 /
        // 83.2 / 27.3. ?edge=<n> overrides it.
        // The former bright/dark radial correction introduced a second contour.
        // Keep it available for diagnostics, but do not paint rings on the shell.
        uEdgeAmp: { value: options.edgeAmp !== undefined ? options.edgeAmp : 0.0 },
      },
      blending: THREE.CustomBlending,
      blendSrc: THREE.ZeroFactor, blendDst: THREE.SrcColorFactor,
      transparent: true, depthWrite: false, depthTest: true,
      side: THREE.DoubleSide, toneMapped: false,
    }));
    orientDome(veil, DOME_DIRECTIONS[i]);
    veil.renderOrder = 18 + i * 0.01;
    veil.userData.index = i;
    scene.add(veil);
    veilDomes.push(veil);

    const glow = new THREE.Mesh(fillGeometry, new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader: /* glsl */`
        uniform sampler2D uMap; uniform sampler2D uProfile;
        uniform float uScale; uniform float uDirWeight; uniform float uGain; uniform float uDaylight;
        uniform vec3 uViewDir; uniform float uViewElev;
        varying vec2 vUv;
        varying vec3 vDomeWorld;
        void main(){
          // gamma 2.0 in the bake, so the dim inner field keeps its precision
          vec3 e = texture2D(uMap, vUv).rgb;
          // The bake got the volume's total right and its shape wrong. Split
          // out of the frame it delivers 40-58% of Cycles' light through the
          // middle of the disc, about 85% across the outer half, and roughly
          // the right amount only in the band between - the regression that
          // separated emission from transmission had least to work with where
          // the artwork behind it is flattest, which is the centre. The shape
          // is corrected here rather than in the bake so it stays a measured
          // curve against Cycles instead of a hand-drawn one, and it is indexed
          // by how the surface faces the camera so it holds at any orbit.
          // Indexed by sin, not by the facing itself: sin is what screen
          // radius is proportional to, so the bins are even across the disc.
          // On facing they would all pile up at the limb, and the middle of
          // the ball - where the correction is largest - would fall inside a
          // single bin.
          float facing = clamp(dot(normalize(vDomeWorld), uViewDir), 0.0, 1.0);
          float sinT = sqrt(max(0.0, 1.0 - facing * facing));
          // Three rows, fitted at a camera pitch of -30, 0 and +30. One row was
          // a hero-angle fit: from below the interior came back 29% darker than
          // Cycles, and nothing about a correction on radius alone could know
          // which way the camera was looking.
          float k = texture2D(uProfile, vec2(sinT, (0.5 + uViewElev * 2.0) / 3.0)).r * 4.0;
          vec3 fill = e * e * (uScale * uDirWeight * uGain * k);
          fill += vec3(.035,.075,.12) * uDaylight * uDirWeight * smoothstep(0.0,.45,facing);
          gl_FragColor = vec4(fill, 1.0);
        }`,
      uniforms: {
        uMap: { value: fillMap }, uScale: { value: FILL_SCALE },
        uGain: { value: appearance.sphereFill }, uDaylight: { value: appearance.daylight }, uDirWeight: { value: 0 },
        uProfile: { value: fillProfileMap },
        uViewElev: { value: 0.5 },
        uViewDir: { value: new THREE.Vector3(0, 0, 1) },
        uWorldToHead: { value: new THREE.Matrix4() },
      },
      blending: THREE.AdditiveBlending,
      transparent: true, depthWrite: false, depthTest: true,
      side: THREE.DoubleSide, toneMapped: false,
    }));
    orientDome(glow, DOME_DIRECTIONS[i]);
    glow.renderOrder = 19 + i * 0.01;
    glow.userData.index = i;
    scene.add(glow);
    fillDomes.push(glow);
  }

  // The dome's cap points down +Z in its own space; turn it to face its
  // direction. A dome straight up has no unique roll, so the pole cases are
  // given one explicitly rather than left to a degenerate cross product.
  function orientDome(mesh, direction) {
    const up = Math.abs(direction.y) > 0.999 ? new THREE.Vector3(0, 0, 1)
                                             : new THREE.Vector3(0, 1, 0);
    mesh.quaternion.setFromRotationMatrix(
      new THREE.Matrix4().lookAt(direction, new THREE.Vector3(), up));
    mesh.userData.direction = direction.clone();
  }

  // A normalised power lobe over whatever directions exist. Blender's fixed
  // denominator was fitted for eight-on-a-ring and cannot describe a set with
  // rings above and below; dividing by the sum is exact for any arrangement,
  // and at the hero angle it lands within a thousandth of Blender's weight.
  const viewDirection = new THREE.Vector3();
  const domeWeights = new Float64Array(DOME_DIRECTIONS.length);
  // Blender drives the crossfade from the character's yaw alone - one ring of
  // eight domes, no elevation term - so tilting the camera there does not
  // reselect the projection, it just looks at the same one obliquely. The port
  // grew rings at +/-30 and +/-58 as well, and at a pitch of 30 the view lands
  // between two of them and blends 59/41, which looked like it had to be
  // ghosting the artwork against itself. Measured it is not: at a pitch of 30
  // the gradient energy inside the disc is 95.9% of Cycles' with the elevation
  // rings and 94.9% without, and matching Blender's yaw-only rule made the
  // frame slightly worse, not better. Kept switchable because the reasoning
  // recurs, and left off.
  let domeWeightYawOnly = false;
  const flatView = new THREE.Vector3();
  const localViewDirection = new THREE.Vector3();
  const worldToHead = new THREE.Matrix4();
  function computeWeights() {
    viewDirection.subVectors(camera.position, CAMERA_TARGET).normalize();
    if(runtime?.rig){runtime.rig.head.updateWorldMatrix(true,false);worldToHead.copy(runtime.rig.head.matrixWorld).invert();}
    localViewDirection.copy(viewDirection).transformDirection(worldToHead);
    const dir = domeWeightYawOnly
      ? flatView.set(localViewDirection.x, 0, localViewDirection.z).normalize()
      : localViewDirection;
    let total = 0;
    for (let i = 0; i < DOME_DIRECTIONS.length; i++) {
      const w = Math.pow(Math.max(0, DOME_DIRECTIONS[i].dot(dir)), DOME_LOBE);
      domeWeights[i] = w;
      total += w;
    }
    const scale = total > 1e-9 ? 1 / total : 0;
    for (let i = 0; i < domeWeights.length; i++) domeWeights[i] *= scale;
    return domeWeights;
  }

  // Plain flags rather than DOM nodes: the measurement harness binds real
    // checkboxes to them, the app never shows them.
    const useVideo = { checked: options.video !== false };
    const onlyFront = { checked: false };
    const stat = { textContent: "" };

  // Held at 1.0 now, and kept for the phase it carries. One scalar a frame was
  // the first attempt at levelling the loop, and it was the wrong shape: the
  // bands do not pulse together, so a gain fitted on the whole frame dragged the
  // limb - the part read as the atmosphere - from a 1.17x swing out to 1.56x.
  // What replaced it is two tables, one on texture radius and one on how the
  // fragment faces the camera, both fitted against Cycles' own 288 frames
  // rather than against the texture. The seconds and the frame count here are
  // what tells the shader where in the loop it is.
  let loopGain = null;
  fetch("./assets/loop-gain.json").then(r => r.json()).then((d) => { loopGain = d; })
    .catch(() => { loopGain = null; });

  function currentLoopGain() {
    if (!loopGain || !videoLive()) return 1;
    const n = loopGain.gain.length;
    const t = (videoEl.currentTime % loopGain.seconds) / loopGain.seconds;
    const x = t * n;
    const i = Math.floor(x) % n;
    return loopGain.gain[i] + (loopGain.gain[(i + 1) % n] - loopGain.gain[i]) * (x - Math.floor(x));
  }

  // 1 = the radial correction alone, 0 = the old global scalar alone. Exposed so
  // the harness can sweep it against Blender's own limb swing rather than
  // guessing; measured, the loop wants all of it.
  let loopGainAmount = 1;
  let loopScalarOverride = null;
  function currentLoopPhase() {
    if (!loopGain || !videoLive()) return 0;
    return (videoEl.currentTime % loopGain.seconds) / loopGain.seconds;
  }

  let ringTransmitMesh = null;

  // declared here rather than beside the rest of the runtime wiring:
  // applyWeights reads it every frame, and a let below its first call is a
  // temporal dead zone that throws on the frame the scene mounts
  let runtime = null;

  function applyWeights() {
    if (disposed) return;
    camera.updateMatrixWorld();
    const nativeHead = runtime?.rig?.head;
    if (nativeHead) {
      const center = nativeHead.getWorldPosition(new THREE.Vector3()).project(camera);
      const radius = nativeHead.getWorldScale(new THREE.Vector3()).x * 1.01;
      compositeScene.children[0].material.uniforms.uHeadScreen.value.set(center.x*.5+.5,center.y*.5+.5,radius/(camera.right-camera.left),radius/(camera.top-camera.bottom));
    }
    if (ringOptics) ringOptics.update({camera, root: runtime?.rig?.head || modelRoot, runtime,
      lights: areaLights, width: width * SUPERSAMPLE,
      height: height * SUPERSAMPLE, backdrop: backdropTarget.texture, appearance});
    const w = computeWeights();
    const amount = videoLive() ? loopGainAmount : 0;
    const phase = currentLoopPhase();
    // The scalar is no longer an alternative to the radial map, it is the
    // residual left over after it: the map holds every radius steady in the
    // texture, but what reaches the screen limb is a mix of radii from several
    // domes at once, and that mix still breathes. Fitted on the rendered limb
    // rather than on the texture, so it corrects what is actually visible.
    const lg = loopScalarOverride !== null ? loopScalarOverride : currentLoopGain();
    // 0 at a pitch of -30, 1 at +30, held at the ends beyond that
    const camElev = Math.asin(THREE.MathUtils.clamp(viewDirection.y, -1, 1));
    const elevSlot = THREE.MathUtils.clamp(0.5 - camElev / (Math.PI / 3), 0, 1);
    if (ringTransmitMesh) {
      const tu = ringTransmitMesh.material.uniforms;
      tu.uViewElev.value = elevSlot;
      if (runtime) tu.uRingSpin.value = runtime.spin;
    }
    shellMaterials.forEach((m) => {
      if (m.uniforms.uAura) m.uniforms.uAura.value = appearance.sphereRim * (runtime ? Math.sqrt(runtime.glow) : 1);
      if (m.uniforms.uEnv) m.uniforms.uEnv.value = equirectEnv;
      if (m.uniforms.uViewElev) m.uniforms.uViewElev.value = elevSlot;
      if (m.uniforms.uRingSpin && runtime) m.uniforms.uRingSpin.value = runtime.spin;
      // the shells need the screen axes and the buffer size to place their
      // refracted sample, and both follow the camera
      if (!m.uniforms.uRefract || m.uniforms.uRefract.value <= 0) return;
      m.uniforms.uScreenRight.value.setFromMatrixColumn(camera.matrixWorld, 0);
      m.uniforms.uScreenUp.value.setFromMatrixColumn(camera.matrixWorld, 1);
      m.uniforms.uResolution.value.set(width * SUPERSAMPLE, height * SUPERSAMPLE);
      m.uniforms.uOrthoSize.value.set(camera.right - camera.left, camera.top - camera.bottom);
    });
    domes.forEach((mesh, i) => {
      mesh.material.uniforms.uViewDir.value.copy(localViewDirection);
      mesh.material.uniforms.uWorldToHead.value.copy(worldToHead);
      mesh.material.uniforms.uLoopGain.value = lg;
      mesh.material.uniforms.uLoopPhase.value = phase;
      mesh.material.uniforms.uLoopGainAmount.value = amount;
      mesh.material.uniforms.uDirWeight.value = onlyFront.checked ? (i === 0 ? w[i] : 0) : w[i];
      mesh.material.uniforms.uMap.value = videoLive() ? videoMap : stillMap;
      // the lobe is cos^16, so all but three or four are worth less than a
      // thousandth of a display level at any view; drawing them is pure cost
      mesh.visible = mesh.material.uniforms.uDirWeight.value > 0.002;
    });
    const layers = fillDomes.concat(veilDomes);
    layers.forEach((mesh) => {
      const weight = w[mesh.userData.index];
      mesh.material.uniforms.uDirWeight.value = weight;
      if (mesh.material.uniforms.uViewDir) {
        mesh.material.uniforms.uViewDir.value.copy(localViewDirection);
        mesh.material.uniforms.uWorldToHead.value.copy(worldToHead);
      }
      if (mesh.material.uniforms.uViewElev) {
        // 0 at a pitch of -30, 1 at +30, held at the ends beyond that
        const elev = Math.asin(THREE.MathUtils.clamp(localViewDirection.y, -1, 1));
        mesh.material.uniforms.uViewElev.value =
          THREE.MathUtils.clamp(0.5 - elev / (Math.PI / 3), 0, 1);
      }
      mesh.visible = weight > 0.002;
    });
  }

  // The loop is the animation: the smoke only moves while the video is
  // decoding, and it was left paused because the port was being compared
  // against a single Blender frame. Muted and playsinline, so autoplay is
  // allowed; a browser that still refuses starts it on the first gesture.
  const resumeVideo = () => { if (!disposed && useVideo.checked && videoAllowed) videoEl.play().catch(() => {}); };
  function setUseVideo(on) {
    if (disposed) return;
    window.removeEventListener("pointerdown", resumeVideo);
    useVideo.checked = on;
    if (!on || !videoAllowed) { videoEl.pause(); return; }
    videoEl.play().catch(() => {
      if (!disposed && useVideo.checked && videoAllowed) window.addEventListener("pointerdown", resumeVideo, { once: true });
    });
  }
  setUseVideo(useVideo.checked);

  /** Largest canvas whose supersampled buffer stays inside the tier's budget. */
  function fitToBudget(w, h) {
    const samples = Math.max(1, w * h * SUPERSAMPLE * SUPERSAMPLE);
    const k = Math.min(1, Math.sqrt(quality.budget / samples));
    return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
  }

  function resize(w, h) {
    const fitted = fitToBudget(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
    if (fitted[0] === width && fitted[1] === height) return;
    [width, height] = fitted;
    renderer.setSize(width, height, false);
    linearTarget.dispose();
    linearTarget = new THREE.WebGLRenderTarget(width * SUPERSAMPLE, height * SUPERSAMPLE, {
      type: THREE.HalfFloatType, colorSpace: THREE.NoColorSpace,
      samples: quality.msaa, depthBuffer: true,
    });
    if (backdropTarget) {
      backdropTarget.dispose();
      backdropTarget = makeBackdrop();
      shellMaterials.forEach((m) => {
        if (m.uniforms.uBackdrop) m.uniforms.uBackdrop.value = backdropTarget.texture;
      });
    }
    const mat = compositeScene.children[0].material;
    bloom.resize(width,height);
    bloomMask.resize(width,height);
    bloom.textures.forEach((texture,i)=>{mat.uniforms[`uBloom${i}`].value=texture;});
    mat.uniforms.uScene.value = linearTarget.texture;
    mat.uniforms.uTexel.value.set(1 / (width * SUPERSAMPLE), 1 / (height * SUPERSAMPLE));
    applyProjection();
  }

  let yaw = 0;
  // What the sphere is missing is refraction. Cycles' shell is transmission
  // 0.985 and bends everything behind it; the analytic shell only ever added a
  // reflection on top, which is why the ball reads as artwork painted on a
  // surface rather than as something you are looking through. three's own
  // screen-space transmission cannot supply it - it reconstructs the view ray
  // as normalize(worldPosition - cameraPosition), which is simply wrong under an
  // orthographic camera - so the pass is done here, where the view direction is
  // the constant it actually is.
  //
  // The scene is drawn once without the glass, and the shell samples that with
  // a screen offset from its own refracted direction. Only the *difference*
  // between the straight and the bent sample is added, so the existing
  // compositing is untouched and an offset of zero reproduces the old frame
  // exactly.
  function drawBackdrop() {
    if (!backdropTarget || refractors.length === 0) return;
    // the pass is the whole scene again - about double the frame - so it is
    // skipped outright when nothing is actually bending anything
    if (!refractors.some(m => m.material.uniforms.uRefract.value > 0)) return;
    refractors.forEach(m => { m.userData.wasVisible = m.visible; m.visible = false; });
    renderer.setRenderTarget(backdropTarget);
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, true, false);
    renderer.render(scene, camera);
    refractors.forEach(m => { m.visible = m.userData.wasVisible; });
  }

  function draw() {
    if (disposed) return;
    drawBackdrop();
    renderer.setRenderTarget(linearTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, false);
    renderer.render(scene, camera);
    if (Math.max(appearance.eyeGlow,appearance.ringGlow,appearance.sphereGlow)>0 && compositeScene.children[0].material.uniforms.uRaw.value < .5) {
      bloomMask.render(camera);
      bloom.render(linearTarget.texture,bloomMask.texture);
    }
    renderer.setRenderTarget(null);
    renderer.setClearColor(0x000000, 0);
    renderer.render(compositeScene, compositeCamera);
  }

  function frame(dt) {
    // The power loop rearms in finally; a reporting error cannot kill it.
    if (disposed) return;
    if (runtime) runtime.update(dt);
    applyWeights();
    draw();
    if (api.onStat) {
      try {
        const lead = domeWeights.reduce((a, b) => Math.max(a, b), 0);
        api.onStat(`lead=${lead.toFixed(3)}  domes=${domes.filter(m => m.visible).length}  ` +
          `${useVideo.checked ? `t=${videoEl.currentTime.toFixed(2)}s` : "still frame 001"}`);
      } catch (err) {
        api.onStat = null;
      }
    }
  }

  // The Blender model supplies every solid: the tapered ring cross-section, the
  // two inset rails and the forty-seven glyph solids are exactly the parts that
  // were unworkable to author by hand in the earlier realtime attempts. Nothing
  // here is remodelled; only materials are substituted, since Cycles shading has
  // no realtime equivalent and is handled separately.
  const modelRoot = new THREE.Group();
  scene.add(modelRoot);
  const modelParts = new Map();

  // Emission is view independent, so Blender's emissive materials transfer exactly:
  // radiance = colour * strength, written linearly and tone mapped once with
  // everything else. Only the three transmissive materials need approximating.
  // Base colour / metalness / roughness / emission read from the Blender
  // Principled nodes. These solids are emissive AND lit: rendering emission alone
  // produced 18% fewer lit pixels than the reference, because in Cycles the area
  // lights still fall on them.
  const SOLIDS = [
    ["Glyph_",     [1.00, 0.82, 0.45], 0.12, 0.16, [1.00, 0.82, 0.45], 4.00],
    ["RingEdge_",  [1.00, 0.66, 0.22], 0.12, 0.20, [1.00, 0.66, 0.22], 3.00],
    ["Eye_0",      [1.00, 0.52, 0.16], 0.12, 0.16, [1.00, 0.52, 0.16], 6.50],
    ["Eye_1",      [1.00, 0.52, 0.16], 0.12, 0.16, [1.00, 0.52, 0.16], 6.50],
    // Rendered alone in Blender the sockets average 0.41 — they are all but
    // invisible. As a lit material they came back as two large glossy ellipsoids,
    // and because they are wider and taller than the eyes they sit behind, that
    // showed as a hard maroon outline around each eye. Killing the diffuse was
    // not enough: a dielectric still answers the lights with specular. They are
    // unlit, carrying only their emission.
    ["EyeSocket_", [0.09, 0.022, 0.004], 0, 0.34, [0.09, 0.022, 0.004], 0.08, true],
  ];

  // Blender's Volume Absorption with colour C and density D attenuates as
  // exp(-D * (1 - C) * distance). three expresses the same thing as the colour
  // light becomes after travelling attenuationDistance, so taking that distance
  // as 1/D gives attenuationColour = exp(-(1 - C)).
  function attenuationFrom(colour, density) {
    return {
      colour: colour.map(c => Math.exp(-(1 - c))),
      distance: 1 / density,
    };
  }

  // three builds ONE screen-space backdrop for transmission and excludes every
  // material with transmission > 0 from it. Nested transmissive shells therefore
  // cannot see each other: with the outer shell, the inner core and the eyes
  // behind it all transmissive, the outer shell refracted a backdrop that
  // contained none of them, and the sphere interior went dark while the eyes
  // disappeared entirely.
  //
  // So only the outer shell transmits. The inner core keeps its Blender look as a
  // plain transparent surface — its transmission weight becomes opacity — which
  // also puts it, and the eyes behind it, into the backdrop the shell samples.
  // Both transmissive bodies use the analytic shell instead of three's
  // screen-space transmission, which is wrong under an orthographic camera.
  // Back to real transmissive materials, with Blender's own values. The analytic
  // shells were a workaround for having no environment; with IBL in place the
  // physical material has something to reflect and refract, and it keeps the
  // camera, the lighting and the materials all free to change at runtime.
  // Rendered alone in Blender this shell is almost nothing: it peaks at 32/255
  // and averages 12.66 in its brightest zone. Sampling the raw HDR for its
  // reflection made the rim peak at 221 and average 91.44 there — 7x over — and
  // that blown-out band is what smothered the artwork and killed the glass.
  //
  // Known open issue, measured but not solved: rendered on its own this shell
  // peaks at ~220 where Cycles' peaks at 32, and its brightest ring averages 91
  // against 12.66. Neither specularIntensity, roughness, envMapIntensity nor
  // opacity brings that grazing band down, so the cause is not a parameter here.
  // Rebuilding it as an analytic or additive layer only traded the refraction
  // away and made the artwork worse, so it stays physical until the real cause is
  // found.
  const SHELLS = {
    __unused_Outer_Physical_Glass: {
      base: [0.62, 0.70, 0.86], roughness: 0.085, ior: 1.16, transmission: 0.985,
      thickness: 0.35, clearcoat: 0.025,
      absorb: [[0.035, 0.12, 0.32], 0.012], order: 30,
      // Calibration, not a Blender value: at full strength the specular lobe
      // reads warmer than Cycles', because one screen-space refraction cannot
      // spread the cold rim lights through the body the way multi-bounce
      // transport does.
      specularIntensity: 0.35,
    },
  };

  // The ring's warmth comes from a Volume Scatter inside the gold body, which a
  // surface material cannot express: with MeshPhysicalMaterial its blue ratio sat
  // at 0.98 against the reference's 0.78, and gold attenuation only moved it to
  // 0.98. The analytic shell models that in-scatter directly and measured 8.24%
  // against 12.27% without it, so the ring keeps that path while the outer glass
  // uses a physical material for genuine refraction of the interior.
  // three's RectAreaLight specular runs through a separate LTC path that
  // specularIntensity does not scale. With base colour, transmission, specular and
  // clearcoat all zeroed and the environment removed, the shell still drew the
  // five light rectangles at a peak of 209 against Blender's 32 — no material
  // setting reaches them, so the shell cannot be a lit material at all.
  const SCATTER_SHELLS = {
    Outer_Physical_Glass: {
      tint: [0.62, 0.70, 0.86], roughness: 0.085, ior: 1.16,
      // At the limb Cycles' shell turns reflective, which both suppresses the
      // artwork behind it and replaces it with light that does not animate.
      // Capping the fresnel at 0.02 removed that: the artwork showed through at
      // full strength right to the edge, so the atmosphere - which is that band -
      // pulsed 1.40x across the loop where Blender's moves 1.07x. Letting the
      // fresnel rise brings it to 1.15, and the reflection is turned down to
      // keep the band's level on Blender's 101.6 rather than adding light.
      // Source lights have specular_factor=0 and visible_glossy=false.
      // The probe includes those lights, so it must not illuminate the glass.
      transmission: 0.985, reflect: 0.35, env: 0.0, specular: 0.0, order: 30,
      fresnelMax: 0.6,
      fresnelLit: 0.02,
      // How far the bent ray lands from the straight one, in screen widths.
      // Fitted against Cycles rather than derived: one screen-space sample
      // cannot follow a ray through two interfaces, so the number stands in for
      // the whole path.
      // Left low on purpose. Cycles' own shell is almost invisible - rendered
      // alone it peaks at 32 - and its artwork sits inside the sphere, so a
      // strong displacement is not something the reference actually shows. This
      // is the amount that reads as glass without inventing a lens edge; it is
      // a dial, not a fit, so ?refract=<n> overrides it live.
      refract: 0.06,
    },
    Ring_GlassBody: {
      tint: [0.88, 0.72, 0.34], roughness: 0.15, ior: 1.24,
      // Fitted against Cycles' own render of this body alone, which is a dark
      // copper lens - mean (87.9, 48.9, 36.3), peak 123 - and not the pale cream
      // strip a stronger in-scatter made of it: at reflect 0.55 and scatter 0.18
      // it came out (142.1, 121.4, 80.7) and peaked at 192, 2.2x too bright with
      // its saturation gone, so the inlaid glyphs had nothing to stand out from
      // and the band stopped reading as glass. These land on (85.0, 51.4, 35.4)
      // and peak 128.
      transmission: 0.94, reflect: 0.25, emissive: [[0.18, 0.045, 0.006], 0.08],
      scatter: [[1.0, 0.40, 0.28], 0.03],
      inlay: {
        // The ring's tilt lives in its node transform, not in its vertices: in
        // the mesh's own space the axis is exactly +Y and the rails sit at
        // 1.314 and 1.486, which is what the objects are named after. Feeding
        // the tilted world axis into an object-space position put every radius
        // in the wrong place - the rails landed at u=0.60 and 0.74 instead of
        // 0.14 and 0.86 - so nothing fitted here ever went where it was aimed.
        axis: [0, 1, 0],
        rails: [1.314, 1.486], span: [1.28, 1.52], h: -0.061,
        // Solved, not guessed: the ratio of Cycles' band to the port's, binned
        // by that radius. It dips to 0.86 through the channel between the rails
        // and rises to 1.18 over the outer one - the dark middle and bright
        // margins that make the band read as a plate rather than a slab.
        bandCurve: [1.255, 1.189, 1.049, 1.030, 1.059, 0.938, 0.735, 0.562,
                    0.580, 0.671, 1.834, 2.030, 1.460, 1.099, 1.099, 1.099],
        colour: [1.0, 0.72, 0.32], rail: 0.10, field: 0.20, falloff: 0.038,
      },
      bodyOpacity: 0.92,
      occludes: true,
      // the ring's axis in world space - Ring_Tilt_Controller, 18/-14/-9
      // degrees - which the spin does not change
      worldAxis: [-0.27559, 0.922806, 0.26922],
      // What the band adds, and separately what it lets through. Baked as one
      // table of final radiance it was a picture of the ring over black, and
      // pasting that at 92% opacity is why the gold read as a sticker: Cycles'
      // band transmits 0.80 / 0.66 / 0.33 of whatever is behind it, so the ball
      // is meant to show through it, warm-tinted. Two renders over two known
      // backgrounds separate the two - W = E + T*B - and the band is drawn the
      // way glass composites: a multiply pass, then an add.
      ringBake: ["./assets/ring-emit.png", 3.2, 1.0],
      ringTransmit: "./assets/ring-transmit.png",
      additive: true,
      // The table still comes back a little softer than Cycles drew it, because
      // a cell is a ring of surface rather than a point. A mild curve closes
      // what is left; fitted across all three tilts at once rather than at the
      // hero angle, where a curve tuned on one view was 26% too bright looked
      // at from above.
      // No curve any more. It existed to fake a range the old opaque paste
      // could not produce; once the band composites as glass the range comes
      // out of the composite itself, and the best fit across all three tilts is
      // the table straight, at three quarters strength.
      ringBakeContrast: 1.00,
      ringBakeMid: 1.00,
      // Its highlights are real: one perpendicular cut through Cycles' band
      // runs 67, 146, 217, 196, 81 - two narrow spikes with dark either side.
      // They are specular on the bevel, not a function of radius, which is why
      // no radial model reproduced them.
      spreadSpecular: false, specular: 0.02,
      // No refraction on the band. It is only a few pixels across, so a
      // screen-space offset reads straight off it: at 0.02 the glyphs came back
      // ringed in black gashes with red and cyan fringes, where the bent sample
      // landed on the gaps between them. The detail it bought (19.3 to 22.1)
      // is not worth that, and the technique does not fit geometry this thin.
      gain: 0.75,
      // After the atmosphere, not before it. The band is glass: what is behind
      // it has to be in the frame already so the multiply pass can attenuate
      // it. Drawn first, as it used to be, the domes simply painted over it.
      order: 21,
    },
  };

  function physicalShell(spec) {
    const material = new THREE.MeshPhysicalMaterial({
      metalness: 0, roughness: spec.roughness, ior: spec.ior,
      transmission: spec.transmission, thickness: spec.thickness,
      clearcoat: spec.clearcoat, clearcoatRoughness: 0.2,
      specularIntensity: spec.specularIntensity !== undefined ? spec.specularIntensity : 1.0,
      envMapIntensity: spec.envIntensity !== undefined ? spec.envIntensity : 1.0,
      transparent: true, depthWrite: false, toneMapped: false, side: THREE.FrontSide,
      blending: spec.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    material.color.setRGB(...spec.base, THREE.LinearSRGBColorSpace);
    if (spec.absorb) {
      const { colour, distance } = attenuationFrom(...spec.absorb);
      material.attenuationColor.setRGB(...colour, THREE.LinearSRGBColorSpace);
      material.attenuationDistance = distance;
    }
    if (spec.emissive) {
      material.emissive.setRGB(...spec.emissive[0], THREE.LinearSRGBColorSpace);
      material.emissiveIntensity = spec.emissive[1];
    }
    if (spec.sheen) {
      material.sheen = spec.sheen[1];
      material.sheenColor.setRGB(...spec.sheen[0], THREE.LinearSRGBColorSpace);
      material.sheenRoughness = 0.4;
    }
    return material;
  }

  // Rendered on its own in Blender the inner core is all but invisible: mean 1.10
  // over 3488 lit pixels, against 44175 pixels at mean 16.4 when it was treated as
  // a lit diffuse body. Its Principled base colour is linked rather than constant,
  // so guessing one invented a surface that does not exist. What it actually does
  // is attenuate: Volume Absorption (0.01, 0.06, 0.22) at density 0.02 over a
  // 1.32 path leaves transmittance (0.974, 0.976, 0.980), a faint cool tint.
  const CORE_TRANSMITTANCE = [0.01, 0.06, 0.22].map(c => Math.exp(-0.02 * (1 - c) * 1.32));

  function translucentMaterial(name) {
    if (name !== "Inner_Core_Sphere") return null;
    const loss = 1 - Math.min(...CORE_TRANSMITTANCE);
    const material = new THREE.MeshBasicMaterial({
      transparent: true, premultipliedAlpha: true, depthWrite: false,
      toneMapped: false, side: THREE.FrontSide, opacity: 1,
    });
    material.color.setRGB(0, 0, 0, THREE.LinearSRGBColorSpace);
    material.opacity = loss;
    return material;
  }

  // "One-way rear": in Blender this is Mix(Transparent, near-black diffuse), dark
  // from behind and invisible from the front, so it darkens what is behind the
  // core without covering it. Rendered as an ordinary opaque sphere it became a
  // black ball in front of the eyes — measured eye brightness fell from 123 to 46.
  // "One-way rear occlusion": alone it renders literally nothing — zero lit pixels
  // at mean 0.08 — but it is not decorative. It hides what lies behind the core,
  // which is what keeps the ring's far arc from showing through the sphere.
  // Giving it a surface invented one that does not exist (lit: 96365 pixels at
  // mean 16.4; unlit near-black: 96574 at 3.33), and dropping it entirely let the
  // far arc read straight through. It is a depth-only occluder: no colour, depth
  // written at the core's near surface, drawn before anything it should hide.
  //
  // The eyes sit at radius 0.695, just outside the 0.66 core, so they are in front
  // of this and survive.
  // Painted rather than depth-only, this near-black shell showed as a hard dark
  // crescent down the limb as soon as the view tilted: the artwork's radial fade
  // runs out a few pixels inside the silhouette, and with nothing left to cover
  // it the black came through. Cycles never shows that because its volume fills
  // the same gap. What the object is actually for is occlusion, so it writes
  // depth and no colour.
  const DEPTH_ONLY = new Set(["OuterSphere_OneWayRearBackdrop"]);

  function depthOnlyMaterial() {
    return new THREE.MeshBasicMaterial({
      colorWrite: false, depthWrite: true, depthTest: true,
      side: THREE.BackSide, toneMapped: false,
    });
  }

  // Its Mix Shader is driven by Geometry.Backfacing: front faces are fully
  // transparent, back faces are a near-black Principled surface. So it is an
  // unlit, near-black, depth-writing back face — which is why it renders as
  // nothing on its own yet still stops the ring's far arc showing through the
  // sphere. Lighting it turned it into a grey shell over 96365 pixels; removing
  // it let the far arc read straight through.
  const OPAQUE = {
    OuterSphere_OneWayRearBackdrop: {
      base: [0.0025, 0.007, 0.026], side: THREE.BackSide, unlit: true,
    },
  };

  function glassMaterial(name) {
    const spec = null;   // superseded by SHELLS
    if (!spec) return null;
    const material = new THREE.MeshPhysicalMaterial({
      metalness: 0, roughness: spec.roughness, ior: spec.ior,
      transmission: spec.transmission, thickness: spec.thickness,
      clearcoat: spec.clearcoat, clearcoatRoughness: 0.2,
      transparent: true, toneMapped: false, side: THREE.DoubleSide,
    });
    material.color.setRGB(...spec.base, THREE.LinearSRGBColorSpace);
    if (spec.absorb) {
      const { colour, distance } = attenuationFrom(...spec.absorb);
      material.attenuationColor.setRGB(...colour, THREE.LinearSRGBColorSpace);
      material.attenuationDistance = distance;
    }
    if (spec.emissive) {
      material.emissive.setRGB(...spec.emissive[0], THREE.LinearSRGBColorSpace);
      material.emissiveIntensity = spec.emissive[1];
    }
    return material;
  }

  function opaqueMaterial(name) {
    const spec = OPAQUE[name];
    if (!spec) return null;
    const side = spec.side !== undefined ? spec.side : THREE.FrontSide;
    const material = spec.unlit
      ? new THREE.MeshBasicMaterial({ toneMapped: false, side })
      : new THREE.MeshStandardMaterial({
          metalness: 0, roughness: spec.roughness, toneMapped: false, side,
        });
    material.color.setRGB(...spec.base, THREE.LinearSRGBColorSpace);
    return material;
  }

  // Mix(Transparent, Emission(0.52,0.64,0.92) * 0.25) with
  // factor = ((1 - facing) ^ 1.85) * 0.23 — a plain fresnel rim, so it ports exactly.
  function rimMaterial() {
    return new THREE.ShaderMaterial({
      uniforms: { uColour: { value: new THREE.Color().setRGB(0.52, 0.64, 0.92, THREE.LinearSRGBColorSpace) } },
      vertexShader: `
        varying vec3 vN; varying vec3 vV;
        void main(){
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vN = normalize(normalMatrix * normal);
          vV = -mv.xyz;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform vec3 uColour;
        varying vec3 vN; varying vec3 vV;
        void main(){
          // Blender's Layer Weight "Facing" is already an edge term: 0 head-on,
          // 1 at the silhouette. The graph then takes (1 - Facing)^1.85, which is
          // brightest head-on — a broad face glow, not a rim. Reading Facing as
          // n-dot-v inverted it and lit only the silhouette: 53541 lit pixels
          // against the reference's 94920.
          float ndv = abs(dot(normalize(vN), normalize(vV)));
          float f = pow(ndv, 1.85) * 0.23;
          gl_FragColor = vec4(uColour * 0.25, f);
        }`,
      transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
    });
  }

  // Principled Volume with a radial density ramp: density = 0.05 (or 0.045) eased
  // to zero between 0.12 and 0.5 of the generated-space radius. Rather than march
  // the volume, the chord through the ellipsoid is evaluated analytically; these
  // are dim background glows and the integral is smooth.
  function groundGlowMaterial(colour, strength, peakDensity, halfThickness) {
    return new THREE.ShaderMaterial({
      uniforms: {
        uColour: { value: new THREE.Color().setRGB(...colour, THREE.LinearSRGBColorSpace) },
        uStrength: { value: strength },
        uDensity: { value: peakDensity },
        uHalfThickness: { value: halfThickness },
        // Fitted against Cycles' own glow pass: at (0.12, 0.5) the pool stopped
        // at x[96-532] where the reference reaches x[45-597], an IoU of 0.566.
        // Widening the ramp alone - the emission is unchanged - takes it to 0.915.
        uFalloff: { value: new THREE.Vector2(0.28, 0.95) },
      },
      vertexShader: `
        varying vec3 vLocal;
        void main(){
          vLocal = position;                    // unit sphere before object scale
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 uColour; uniform float uStrength; uniform float uDensity;
        uniform float uHalfThickness; uniform vec2 uFalloff;
        varying vec3 vLocal;
        void main(){
          // The chord has to be measured across the body, from the impact
          // parameter perpendicular to the view — not from the 3D radius, which
          // is 1 everywhere on the surface being shaded and made every chord zero.
          float rp = length(vLocal.xy);
          // Blender's Principled Volume emission is a coefficient per unit length;
          // it is NOT scaled by density. Scaling by it, and taking the half
          // thickness from Blender's Z rather than the axis that maps to three's
          // view direction, together made this ~100x too dim — it rendered zero
          // lit pixels against the reference's 12360.
          float falloff = 1.0 - smoothstep(uFalloff.x, uFalloff.y, rp * 0.5);
          float chord = 2.0 * uHalfThickness * sqrt(max(0.0, 1.0 - rp * rp));
          gl_FragColor = vec4(uColour * uStrength * falloff * chord, 1.0);
        }`,
      transparent: true, depthWrite: false, depthTest: true,
      blending: THREE.AdditiveBlending, side: THREE.FrontSide, toneMapped: false,
    });
  }

  // three's transmission reconstructs the view ray as
  // normalize(worldPosition - cameraPosition), which is only correct for a
  // perspective camera. This scene's camera is orthographic, where the view
  // direction is constant, so the refraction vectors came out wrong across the
  // whole shell and it sampled distant parts of the backdrop — the hard-edged
  // maroon rectangles were refracted pieces of the ring, and they persisted at
  // every thickness and both supersample settings.
  //
  // At transmission 0.985 the shell is almost entirely a pass-through anyway:
  // what it actually contributes is a fresnel rim and specular highlights, which
  // are cheap to compute directly and do not need a backdrop at all.
  function shellMaterial(spec, lights) {
    if (spec.gain !== undefined && options.ringGain !== undefined) {
      spec = { ...spec, gain: options.ringGain };
    }
    const positions = new Float32Array(15);
    const colours = new Float32Array(15);
    // These are area lights 23 to 40 degrees wide as seen from the character,
    // and treating them as points concentrated every one of them into a hot dot:
    // a roughness of 0.085 is a Blinn-Phong exponent of 277, where a light that
    // broad is worth about 3 to 9. Five warm dots is exactly what showed up
    // inside the glass as "red reflections", 141 red where Cycles renders 37.
    // The exponent is capped per light at what its own solid angle supports,
    // and the peak scaled down with it so the lobe keeps its energy.
    const shines = new Float32Array(5).fill(1e6);
    lights.slice(0, 5).forEach((l, i) => {
      positions.set([l.position.x, l.position.y, l.position.z], i * 3);
      colours.set([l.color.r * l.intensity, l.color.g * l.intensity, l.color.b * l.intensity], i * 3);
      const distance = Math.max(l.position.length(), 1e-3);
      const alpha = Math.sqrt(l.width * l.height / Math.PI) / distance;
      shines[i] = 2 * Math.LN2 / Math.max(alpha * alpha, 1e-6);
    });
    const f0 = Math.pow((spec.ior - 1) / (spec.ior + 1), 2);
    return new THREE.ShaderMaterial({
      defines: { NLIGHTS: Math.min(lights.length, 5) },
      uniforms: {
        uTint: { value: new THREE.Color().setRGB(...spec.tint, THREE.LinearSRGBColorSpace) },
        uEmissive: {
          value: new THREE.Color().setRGB(
            ...(spec.emissive ? spec.emissive[0].map(c => c * spec.emissive[1]) : [0, 0, 0]),
            THREE.LinearSRGBColorSpace),
        },
        uLightPos: { value: positions },
        uLightCol: { value: colours },
      uLightShine: { value: shines },
        uRoughness: { value: spec.roughness },
        uF0: { value: f0 },
        uFresnelPower: { value: spec.fresnelPower !== undefined ? spec.fresnelPower : 5.0 },
        uFresnelMax: { value: spec.fresnelMax !== undefined ? spec.fresnelMax : 1.0 },
      uFresnelLit: {
        value: spec.fresnelLit !== undefined ? spec.fresnelLit
             : (spec.fresnelMax !== undefined ? spec.fresnelMax : 1.0),
      },
        uTransmission: { value: spec.transmission },
        uReflect: { value: spec.reflect },
        uEnv: { value: equirectEnv },
        uEnvIntensity: { value: spec.env !== undefined ? spec.env : 0.0 },
        uAura: {value: appearance.sphereRim},
        uScatterColour: {
          value: new THREE.Color().setRGB(
            ...(spec.scatter ? spec.scatter[0] : [0, 0, 0]), THREE.LinearSRGBColorSpace),
        },
        uScatter: { value: spec.scatter ? spec.scatter[1] : 0.0 },
        uBodyOpacity: { value: spec.bodyOpacity !== undefined ? spec.bodyOpacity : 0.0 },
        // The reference render and the design sheet want different rings: Cycles'
      // band is restrained, the sheet's is a bright glowing gold. This scales
      // the whole band away from the measured match, so ?ring=<n> can take it
      // towards the sheet without any of the fitting being thrown away.
      uGain: { value: spec.gain !== undefined ? spec.gain : 1.0 },
        uSpecular: { value: spec.specular !== undefined ? spec.specular : 0.02 },
      uSpread: { value: spec.spreadSpecular === false ? 0.0 : 1.0 },
      uBackdrop: { value: null },
      uRefract: {
        value: options.refract !== undefined ? options.refract : (spec.refract || 0.0),
      },
      uEta: { value: 1.0 / (spec.ior || 1.0) },
      uScreenRight: { value: new THREE.Vector3(1, 0, 0) },
      uScreenUp: { value: new THREE.Vector3(0, 1, 0) },
      // the camera's world extents, so the displacement can be stated in world
      // units and stay the same size on the character whatever the canvas is
      uOrthoSize: { value: new THREE.Vector2(1, 1) },
      uScatterFloor: { value: spec.scatterFloor !== undefined ? spec.scatterFloor : 0.35 },
        uInlayAxis: { value: new THREE.Vector3(...(spec.inlay ? spec.inlay.axis : [0, 1, 0])) },
        uInlayColour: {
          value: new THREE.Color().setRGB(
            ...(spec.inlay ? spec.inlay.colour : [0, 0, 0]), THREE.LinearSRGBColorSpace),
        },
        uInlayRails: { value: new THREE.Vector2(...(spec.inlay ? spec.inlay.rails : [0, 0])) },
        uInlaySpan: { value: new THREE.Vector2(...(spec.inlay ? spec.inlay.span : [0, 0])) },
        uInlayH: { value: spec.inlay ? spec.inlay.h : 0.0 },
        uInlayRail: { value: spec.inlay ? spec.inlay.rail : 0.0 },
        uInlayField: { value: spec.inlay ? spec.inlay.field : 0.0 },
        uInlayFalloff: { value: spec.inlay ? spec.inlay.falloff : 1.0 },
      // A bake of Cycles' own ring shading, indexed by where a fragment is on
      // the ring rather than by where it is on screen. The lights do not move
      // and the ring only spins about its own axis, so the shading at a given
      // world angle is fixed while the geometry turns through it: baking on
      // (world angle, position across the band) is invariant under that spin,
      // where a bake in the mesh's UV would carry the highlights around with it.
      uBandDebug: { value: 0 },
      uResolution: { value: new THREE.Vector2(1, 1) },
      // flipY off: the table is addressed, not looked at. Left on, the three
      // tilt slices stack upside down and the two faces of the band swap, so
      // every fragment reads a cell belonging to some other part of the ring -
      // which still looked plausible, because the wrong cells are drawn from
      // the same ring.
      uRingBake: { value: spec.ringBake ? ringBakeTex(spec.ringBake[0]) : null },
      uRingEnv: { value: spec.ringBake ? ringBakeTex("./assets/ring-envelope.png") : null },
      uRingSpin: { value: 0 },
      // the band's half-thickness along the ring's own axis, so the
      // cross-section angle is measured on a circle rather than an ellipse
      uBandHalfT: { value: spec.bandHalfT !== undefined ? spec.bandHalfT : 0.0656 },
      uRingBakeScale: { value: spec.ringBake ? spec.ringBake[1] : 1.0 },
      uRingBakeMix: { value: spec.ringBake ? spec.ringBake[2] : 0.0 },
      uRingBakeContrast: { value: spec.ringBakeContrast !== undefined ? spec.ringBakeContrast : 1.0 },
      uViewElev: { value: 0.5 },
      uRingBakeMid: { value: spec.ringBakeMid !== undefined ? spec.ringBakeMid : 1.00 },
      uRingAxisWorld: {
        value: new THREE.Vector3(...(spec.worldAxis || [0, 1, 0])).normalize(),
      },
      uRingRef: { value: new THREE.Vector3() },
      uRingRef2: { value: new THREE.Vector3() },
      // Cycles' own cross-section, sampled across the band. The band is a
      // surface of revolution, so its shape really is a function of radius
      // alone and this stays correct as the ring turns. Every analytic model
      // tried here - two ridges, a smooth ramp, a fitted specular - missed it,
      // so it is measured rather than guessed.
      uBandCurve: {
        value: new Float32Array((spec.inlay && spec.inlay.bandCurve) || new Array(16).fill(1)),
      },
      },
      vertexShader: `
        varying vec3 vN; varying vec3 vW; varying vec3 vL;
        void main(){
          vec4 world = modelMatrix * vec4(position, 1.0);
          vW = world.xyz;
          // object space as well: the ring spins and the body breathes, and the
          // inlays are fixed in the geometry, not in the world
          vL = position;
          vN = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * viewMatrix * world;
        }`,
      fragmentShader: `
        uniform vec3 uTint;
        uniform vec3 uEmissive;
        uniform float uLightPos[NLIGHTS * 3];
        uniform float uLightCol[NLIGHTS * 3];
      uniform float uLightShine[NLIGHTS];
        uniform float uRoughness; uniform float uF0; uniform float uGain;
        uniform float uSpecular; uniform float uSpread; uniform float uScatterFloor;
      uniform sampler2D uBackdrop; uniform float uRefract; uniform float uEta;
      uniform vec3 uScreenRight; uniform vec3 uScreenUp; uniform vec2 uOrthoSize;
        uniform float uFresnelPower; uniform float uFresnelMax;
      uniform float uFresnelLit;
        uniform float uTransmission; uniform float uReflect;
        uniform vec3 uScatterColour; uniform float uScatter; uniform float uBodyOpacity;
        uniform sampler2D uEnv; uniform float uEnvIntensity;
        uniform float uAura;
        uniform vec3 uInlayAxis; uniform vec3 uInlayColour;
        uniform vec2 uInlayRails; uniform vec2 uInlaySpan;
        uniform float uInlayH; uniform float uInlayRail;
        uniform float uInlayField; uniform float uInlayFalloff;
      uniform float uBandDebug;
      uniform vec2 uResolution;
      uniform float uBandCurve[16];
      uniform sampler2D uRingBake; uniform float uRingBakeMix;
      uniform float uRingBakeScale;
      uniform float uRingBakeContrast; uniform float uRingBakeMid;
      uniform sampler2D uRingEnv; uniform float uRingSpin;
      uniform float uBandHalfT;
      uniform float uViewElev;
      uniform vec3 uRingAxisWorld; uniform vec3 uRingRef; uniform vec3 uRingRef2;
        varying vec3 vN; varying vec3 vW; varying vec3 vL;

        void main(){
          // Orthographic: one view direction for every fragment.
          vec3 V = normalize(vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]));
          vec3 N = normalize(vN);
          float ndv = clamp(dot(N, V), 0.0, 1.0);
          // Schlick's exponent of 5 describes one interface. This is a thin
          // shell: light that reflects off the front is partly re-transmitted by
          // the back, so the real grazing rise is far gentler. Blender's shell
          // measures centre:mid:outer = 1 : 2.07 : 2.94, where an exponent of 5
          // gives 1 : 2.4 : 15.
          // A semi-infinite dielectric reaches total reflection at grazing; a thin
          // shell cannot, because its second interface leaks the light back out.
          // Blender's shell measures centre:mid:outer = 1 : 2.07 : 2.95 — nearly
          // flat — where uncapped Schlick gives 1 : 2.25 : 14.94. Lowering the
          // exponent made the shape worse, so the grazing end is capped instead.
          // Two caps, not one. How much the shell *blocks* at grazing is what
          // steadies the limb - it is what suppresses the animated artwork there
          // - but how much it *adds* is a separate number, and Cycles' shell adds
          // almost nothing: rendered alone it peaks at 32. Raising one cap for
          // both drew a rust-coloured arc right round the silhouette, which is
          // the environment probe's warm lights arriving thirty times stronger.
          float fresnelRaw = uF0 + (1.0 - uF0) * pow(1.0 - ndv, uFresnelPower);
          float fresnel = min(fresnelRaw, uFresnelMax);
          float fresnelLit = min(fresnelRaw, uFresnelLit);

          float shine = 2.0 / max(uRoughness * uRoughness, 1e-4);
          vec3 spec = vec3(0.0);
          float diffuse = 0.0;
          for (int i = 0; i < NLIGHTS; i++) {
            vec3 lp = vec3(uLightPos[i*3], uLightPos[i*3+1], uLightPos[i*3+2]);
            vec3 lc = vec3(uLightCol[i*3], uLightCol[i*3+1], uLightCol[i*3+2]);
            vec3 L = normalize(lp - vW);
            vec3 H = normalize(L + V);
            float ndl = max(dot(N, L), 0.0);
            // An area light cannot focus tighter than its own solid angle, and
          // the peak drops as the lobe widens so the energy is conserved. That
          // is right for the outer sphere, where Cycles renders almost no
          // specular at all - rendered alone that shell peaks at 32 - and it is
          // wrong for the ring: its cross-section is tightly curved, so Cycles
          // puts a narrow bright line on it that reaches 221, and capping the
          // lobe there cut the peak by 88/3 and left a flat slab.
          float lobe = mix(shine, min(shine, uLightShine[i]), uSpread);
          float fall = mix(1.0, lobe / shine, uSpread);
          spec += lc * pow(max(dot(N, H), 0.0), lobe) * ndl * fall;
            diffuse += ndl;
          }
          diffuse = clamp(diffuse / float(NLIGHTS), 0.0, 1.0);

          // A shell both attenuates what is behind it and adds its own reflection.
          // With premultiplied alpha the blend is dst*(1-a) + src, so writing
          // a = 1 - transmittance reproduces the attenuation exactly, and the
          // colour term carries the reflected light. Treating the shell as purely
          // additive left the interior unattenuated and the frame 30% too bright.
          // Real reflected content, sampled straight from the equirectangular
          // probe. three's screen-space transmission cannot be used here: it is
          // wrong under an orthographic camera, it drops transparent objects from
          // its backdrop, and it replaced the interior outright — the inner core
          // contributed +80 with the shell off and -11 with it on.
          vec3 reflectDir = reflect(-V, N);
          vec2 envUv = vec2(atan(reflectDir.z, reflectDir.x) / 6.2831853 + 0.75,
                            0.5 - asin(clamp(reflectDir.y, -1.0, 1.0)) / 3.14159265);
          vec3 envColour = texture2D(uEnv, envUv).rgb * uEnvIntensity;

          // A Volume Scatter inside the body lights the whole band, not just its
          // highlights: without it the ring assembly measured 67% of the
          // reference's brightness even though its coverage matched (IoU 0.988).
          // Path length through a thin body grows as 1/cos, so grazing angles
          // scatter more.
          float path = 1.0 / max(ndv, 0.22);
          // How much reaches the side facing away from every light. Cycles
          // renders the ring's inner face as dark bronze; a floor of 0.35 lit
          // it as brightly as the outer face and the band read as one flat
          // colour from every angle.
          vec3 inscatter = uScatterColour * uScatter * path
                         * (uScatterFloor + (1.0 - uScatterFloor) * diffuse);

          // A dense scattering medium reads as a solid body even at high
          // transmission: Cycles' ring is opaque gold with the glyphs embedded in
          // it, while an alpha of 1 - (1-F)*0.94 leaves it 93% transparent and the
          // sphere shows straight through the band.
          float transmittance = (1.0 - fresnel) * uTransmission * (1.0 - uBodyOpacity);
          float alpha = 1.0 - transmittance;
          // Only the fraction that is not transmitted can be reflected. Leaving
          // that out made the grazing rim equal the whole environment's
          // brightness — 104 against Blender's 12.66 — because fresnel goes to 1
          // there. At transmission 0.985 the shell reflects 1.5%, and the probe's
          // mean radiance of 1.34 times that lands on Blender's measured peak.
          float reflectFraction = 1.0 - uTransmission;
          // Cycles' band is not lit by the scene: it is lit by what is embedded
          // in it. The rails and the forty-seven glyphs are emissive and sit
          // inside the gold, so rendered with the body they take its band from
          // 52.56 to 134.9 - most of its brightness. Binned on the corrected
          // axis, its near arc runs 93, 99, 127, 108, 107, 146, 159, 154, 121
          // across the band: bright at each rail, dark in the channel between.
          vec3 inlay = vec3(0.0);
          if (uInlayRail > 0.0 || uInlayField > 0.0) {
            float rad = length(vL - uInlayAxis * dot(vL, uInlayAxis));
            float d1 = abs(rad - uInlayRails.x);
            float d2 = abs(rad - uInlayRails.y);
            inlay = uInlayColour * (uInlayRail * (exp(-d1 / uInlayFalloff) + exp(-d2 / uInlayFalloff))
                                  + uInlayField);
          }

          vec3 reflected = uTint * fresnelLit * uReflect + spec * uSpecular + uEmissive
                         + inscatter + inlay + envColour * fresnelLit * reflectFraction;
          if (uBandDebug > 1.5) {
            // measurement aid: where this fragment sits on the ring, so Cycles'
            // render of the same frame can be scattered into that space
            float radL = length(vL - uInlayAxis * dot(vL, uInlayAxis));
            float uu = clamp((radL - uInlaySpan.x) /
                             max(uInlaySpan.y - uInlaySpan.x, 1e-4), 0.0, 1.0);
            vec3 flat3 = vW - uRingAxisWorld * dot(vW, uRingAxisWorld);
            float th = atan(dot(flat3, uRingRef2), dot(flat3, uRingRef));
            // Sixteen bits of angle across two channels. At eight the table
            // could never be finer than 256 cells round the whole ring, which
            // is about five screen pixels a cell at the size this is drawn -
            // coarser than the engraving it is meant to carry.
            float t16 = clamp(th / 6.2831853 + 0.5, 0.0, 0.999985) * 65535.0;
            float hi = floor(t16 / 256.0);
            // Where the fragment sits round the band's cross-section. Radius
            // alone does not name a point on the ring - the top face, the
            // bottom face and the two rims all share it - and splitting on
            // which way the normal leans only separates the faces, leaving
            // every point on a rim wall in one cell. Seen from the far side of
            // the ring that wall is the whole visible band, so the table
            // returned one value across it and the engraving disappeared into
            // a smooth gradient. The angle round the cross-section names every
            // surface point exactly once.
            float radC = length(vL - uInlayAxis * dot(vL, uInlayAxis));
            float rn = (radC - 0.5 * (uInlaySpan.x + uInlaySpan.y))
                     / max(0.5 * (uInlaySpan.y - uInlaySpan.x), 1e-4);
            float an = dot(vL, uInlayAxis) / max(uBandHalfT, 1e-4);
            float q = atan(an, rn) / 6.2831853 + 0.5;
            gl_FragColor = vec4(hi / 255.0, (t16 - hi * 256.0) / 255.0, q, 1.0);
            return;
          }
          if (uBandDebug > 0.5) {
            // measurement aid: write the fragment's position across the band so
            // Cycles' own cross-section can be binned against the real geometry
            float rad = length(vL - uInlayAxis * dot(vL, uInlayAxis));
            gl_FragColor = vec4(vec3(clamp((rad - uInlaySpan.x) /
                                    max(uInlaySpan.y - uInlaySpan.x, 1e-4), 0.0, 1.0)), 1.0);
            return;
          }
          if (uRingBakeMix > 0.0) {
            // Cycles' own answer for this point on the ring, replayed. It
            // already contains the bevel highlights and the light the inlays
            // pour into the gold, which is everything the analytic band could
            // not produce: a cut across Cycles' band runs 67, 217, 81, 220, 103
            // where the analytic one was a smooth 132 to 186.
            vec3 flatW = vW - uRingAxisWorld * dot(vW, uRingAxisWorld);
            float thB = atan(dot(flatW, uRingRef2), dot(flatW, uRingRef)) / 6.2831853 + 0.5;
            // Three slices stacked, rendered at a camera pitch of -30, 0 and
            // +30: the band is glass, so what it shows depends on where it is
            // looked at from, and one slice is a hero-angle answer replayed at
            // every angle. Dragged down to -30 it came back as a bright cream
            // hoop where Cycles has dark amber with the engraving cut into it.
            // Within a slice the row is the angle round the band's own
            // cross-section, which names each surface point exactly once - see
            // the debug channel above for why radius alone does not.
            float radC = length(vL - uInlayAxis * dot(vL, uInlayAxis));
            float rnB = (radC - 0.5 * (uInlaySpan.x + uInlaySpan.y))
                      / max(0.5 * (uInlaySpan.y - uInlaySpan.x), 1e-4);
            float anB = dot(vL, uInlayAxis) / max(uBandHalfT, 1e-4);
            float within = atan(anB, rnB) / 6.2831853 + 0.5;
            float slice = uViewElev * 2.0;
            float s0 = floor(slice), sf = slice - s0;

            // The table holds two things that do not travel together. The
            // engraving, and the light the hidden inlays pour into the gold
            // around it, are fixed to the ring and turn with it. How the lamps
            // fall round the band is fixed to the world and does not. Indexed
            // by world angle alone the whole thing stood still while the
            // glyphs turned over it, which is what the ring looked like once
            // the table was sharp enough to see: the outside stopped moving.
            //
            // So the detail is read at the ring's own angle and the smooth
            // envelope is divided out there and put back at the world angle.
            // At rest the two angles agree and this is exactly 1, which is why
            // nothing fitted against the hero frame moves.
            float thObj = fract(thB - uRingSpin / 6.2831853 + 1.0);
            float v0 = (s0 + within) / 3.0;
            float v1 = (min(s0 + 1.0, 2.0) + within) / 3.0;
            vec3 e0 = texture2D(uRingBake, vec2(thObj, v0)).rgb;
            vec3 e1 = texture2D(uRingBake, vec2(thObj, v1)).rgb;
            vec3 e = mix(e0, e1, sf);
            vec3 wW = mix(texture2D(uRingEnv, vec2(thB, v0)).rgb,
                          texture2D(uRingEnv, vec2(thB, v1)).rgb, sf);
            vec3 wO = mix(texture2D(uRingEnv, vec2(thObj, v0)).rgb,
                          texture2D(uRingEnv, vec2(thObj, v1)).rgb, sf);
            // Both are stored under the same gamma as the table, so the ratio
            // can be taken before the square without decoding either. Clamped:
            // this is meant to slide a smooth envelope round the ring, and a
            // ratio outside about a factor of two is the encoding running out
            // rather than anything Cycles rendered.
            e *= clamp(wW / max(wO, vec3(0.04)), vec3(0.45), vec3(2.2));
            vec3 eb = e * e * uRingBakeScale;
            // 256 cells around the whole circumference is about five screen
            // pixels a cell at this size, so the bake comes back softer than
            // Cycles drew it: in the band outside the ball Cycles runs 94.7 at
            // the tenth percentile and 223.1 at the ninetieth, the port 109.5
            // and 213.2 - the same mean and the same gold, over a range a
            // quarter narrower. A gamma about the band's own midpoint puts the
            // range back without touching the colour or the average.
            eb = uRingBakeMid * pow(max(eb / uRingBakeMid, vec3(1e-4)),
                                    vec3(uRingBakeContrast));
            reflected = mix(reflected, eb, uRingBakeMix);
          }

          // Not while the bake is driving the band: the curve was solved for the
          // analytic version, and multiplying Cycles' own answer by it corrected
          // the same thing twice - locally the band came out at 157% and the
          // engraving washed out, 1.16x contrast where Cycles has 1.32x.
          if (uRingBakeMix < 1.0 && (uInlayRail > 0.0 || uInlayField > 0.0)) {
            float rad = length(vL - uInlayAxis * dot(vL, uInlayAxis));
            float bu = clamp((rad - uInlaySpan.x) /
                             max(uInlaySpan.y - uInlaySpan.x, 1e-4), 0.0, 1.0) * 15.0;
            // Walked, not indexed: GLSL ES 1.0 will not take a computed index
            // into a uniform array, and the silent result was a curve applied
            // at the wrong radius - the band changed brightness but the shape
            // it was solved for did not appear.
            float k = uBandCurve[15];
            for (int i = 0; i < 15; i++) {
              if (bu >= float(i) && bu < float(i + 1)) {
                k = mix(uBandCurve[i], uBandCurve[i + 1], bu - float(i));
              }
            }
            reflected *= k;
          }

          // Only the displacement is added: the straight sample is already in
          // the frame under this fragment, so subtracting it leaves exactly what
          // the bending moved, and a refraction of zero reproduces the frame the
          // reflection-only shell produced.
          if (uRefract > 0.0) {
            // Faded out towards the silhouette. Physically the bending is
            // strongest at grazing, but that is also where a screen-space sample
            // walks off the object and drags the black background inwards - at
            // full strength it drew a hard dark ring right round the ball. What
            // survives is the part that reads as looking through glass, and the
            // rim keeps the profile that was fitted against Cycles.
            float bendable = smoothstep(0.0, 0.45, ndv);
            vec3 bent = refract(-V, N, uEta);
            vec2 uvScreen = gl_FragCoord.xy / uResolution;
            // World units first, then divided by what the camera actually
            // covers. Stated straight in UV the same number moved a different
            // distance on the character at every canvas size and aspect, so the
            // glass changed strength when the window was resized.
            vec2 world = vec2(dot(bent, uScreenRight), dot(bent, uScreenUp))
                       * (uRefract * bendable);
            vec2 offset = world / uOrthoSize;
            vec3 straight = texture2D(uBackdrop, uvScreen).rgb;
            vec3 moved = texture2D(uBackdrop, clamp(uvScreen + offset, 0.001, 0.999)).rgb;
            reflected += (moved - straight) * uTransmission * uTint * bendable;
          }

          // A single monotonic grazing glow; no bright/dark ring correction.
          // World-space lighting remains anchored while camera and body move.
          float sky=.28+.72*smoothstep(-.35,.65,N.y);
          float warm=pow(max(dot(N,normalize(vec3(.8,.5,.12))),0.0),5.0);
          vec3 rimColour=mix(vec3(.56,.72,1.0),vec3(1.0,.79,.42),warm*.65);
          reflected+=rimColour*pow(1.0-ndv,4.5)*sky*uAura;
          gl_FragColor = vec4(reflected * uGain, alpha);
        }`,
      transparent: true,
      // The emission half of the glass composite adds and never covers; what
      // the band takes out of the frame is the separate multiply pass, which
      // runs just before it.
      premultipliedAlpha: !spec.additive,
      blending: spec.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      // Depth is written by the add pass so the ball's own shell, which draws
      // after, is rejected where the band is in front of it. The far arc stays
      // hidden either way: the rear backdrop writes depth nearer than the ring
      // ever reaches.
      depthWrite: spec.occludes === true,
      side: THREE.FrontSide, toneMapped: false,
    });
  }

  /**
   * The multiply half of the band's glass composite: what the frame behind it
   * survives. Same coordinates as the emission table - angle round the ring,
   * angle round the band's own cross-section, and the tilt slice - so the two
   * stay registered, and the same spin offset so it turns with the ring.
   */
  function ringTransmitMaterial(spec) {
    return new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: ringBakeTex(spec.ringTransmit) },
        uRingAxisWorld: { value: new THREE.Vector3(...(spec.worldAxis || [0, 1, 0])).normalize() },
        uRingRef: { value: new THREE.Vector3() },
        uRingRef2: { value: new THREE.Vector3() },
        uInlayAxis: { value: new THREE.Vector3(...((spec.inlay && spec.inlay.axis) || [0, 1, 0])) },
        uInlaySpan: { value: new THREE.Vector2(...((spec.inlay && spec.inlay.span) || [0, 1])) },
        uBandHalfT: { value: spec.bandHalfT !== undefined ? spec.bandHalfT : 0.0656 },
        uRingSpin: { value: 0 },
        uViewElev: { value: 0.5 },
        uGain: { value: 1 },
        // a little past the shell, so the limb glow that reaches beyond it is
        // covered too
        uBallRadius: { value: 1.03 },
      },
      vertexShader: `
        varying vec3 vW; varying vec3 vL;
        void main(){
          vec4 world = modelMatrix * vec4(position, 1.0);
          vW = world.xyz; vL = position;
          gl_Position = projectionMatrix * viewMatrix * world;
        }`,
      fragmentShader: `
        uniform sampler2D uMap;
        uniform vec3 uRingAxisWorld; uniform vec3 uRingRef; uniform vec3 uRingRef2;
        uniform vec3 uInlayAxis; uniform vec2 uInlaySpan;
        uniform float uBandHalfT; uniform float uRingSpin; uniform float uViewElev;
        uniform float uGain; uniform float uBallRadius;
        varying vec3 vW; varying vec3 vL;
        void main(){
          // The ball's own glow is drawn by transparent domes, which write no
          // depth, so the depth buffer cannot tell this pass that the band is
          // behind the ball. Without that, the far arc - which at the hero view
          // runs right along the top of the silhouette - tinted the limb it is
          // supposed to be hidden behind, and cut it roughly in half.
          vec3 toFrag = vW - cameraPosition;
          float dist = length(toFrag);
          vec3 dir = toFrag / max(dist, 1e-5);
          float b = dot(dir, -cameraPosition);
          float c = dot(cameraPosition, cameraPosition) - uBallRadius * uBallRadius;
          float disc = b * b - c;
          if (disc > 0.0) {
            float enter = b - sqrt(disc);
            if (enter > 0.0 && dist > enter + 1e-3) discard;
          }
          vec3 flatW = vW - uRingAxisWorld * dot(vW, uRingAxisWorld);
          float thB = atan(dot(flatW, uRingRef2), dot(flatW, uRingRef)) / 6.2831853 + 0.5;
          float thObj = fract(thB - uRingSpin / 6.2831853 + 1.0);
          float radC = length(vL - uInlayAxis * dot(vL, uInlayAxis));
          float rn = (radC - 0.5 * (uInlaySpan.x + uInlaySpan.y))
                   / max(0.5 * (uInlaySpan.y - uInlaySpan.x), 1e-4);
          float an = dot(vL, uInlayAxis) / max(uBandHalfT, 1e-4);
          float within = atan(an, rn) / 6.2831853 + 0.5;
          float slice = uViewElev * 2.0;
          float s0 = floor(slice), sf = slice - s0;
          vec3 t0 = texture2D(uMap, vec2(thObj, (s0 + within) / 3.0)).rgb;
          vec3 t1 = texture2D(uMap, vec2(thObj, (min(s0 + 1.0, 2.0) + within) / 3.0)).rgb;
          // stored under the same gamma-2 convention as the emission table
          vec3 t = mix(t0, t1, sf);
          gl_FragColor = vec4(mix(vec3(1.0), t * t, uGain), 1.0);
        }`,
      blending: THREE.CustomBlending,
      blendSrc: THREE.ZeroFactor, blendDst: THREE.SrcColorFactor,
      transparent: true, depthWrite: false, depthTest: true,
      side: THREE.FrontSide, toneMapped: false,
    });
  }

  function extraMaterial(name) {
    if (name === "Atmosphere_Continuous_Rim") return rimMaterial();
    if (name === "GroundGlow_Cold") {
      const m = groundGlowMaterial([0.025, 0.045, 0.12], 0.24, 0.05, 0.62);
      glowMaterials.set(name, m); return m;
    }
    if (name === "GroundGlow_Warm") {
      const m = groundGlowMaterial([0.18, 0.045, 0.006], 0.12, 0.045, 0.42);
      glowMaterials.set(name, m); return m;
    }
    return null;
  }

  function solidMaterial(name) {
    const hit = SOLIDS.find(([prefix]) => name.startsWith(prefix));
    if (!hit) return null;
    const [, base, metalness, roughness, emissive, strength, unlit] = hit;
    if (unlit) {
      const flat = new THREE.MeshBasicMaterial({ toneMapped: false, side: THREE.DoubleSide });
      flat.color.setRGB(emissive[0] * strength, emissive[1] * strength, emissive[2] * strength,
                        THREE.LinearSRGBColorSpace);
      return flat;
    }
    const material = new THREE.MeshStandardMaterial({
      metalness, roughness, toneMapped: false,
      side: THREE.DoubleSide,   // Cycles shades both faces; culling dropped a rail
    });
    material.color.setRGB(...base, THREE.LinearSRGBColorSpace);
    material.emissive.setRGB(...emissive, THREE.LinearSRGBColorSpace);
    material.emissiveIntensity = strength;
    return material;
  }

  // Blender's watt-based area lights, converted to radiance on export. One global
  // factor is left to calibrate against a Blender render, rather than four.
  let lightScale = 1.0;
  const areaLights = [];

  fetch("./assets/lights.json").then(r => r.json()).then((data) => {
    if (disposed) return;
    for (const entry of data.lights) {
      if (entry.type !== "AREA") continue;
      const light = new THREE.RectAreaLight(0xffffff, entry.radiance, entry.size[0], entry.size[1]);
      light.color.setRGB(...entry.color, THREE.LinearSRGBColorSpace);
      light.position.set(...entry.position);
      light.lookAt(...entry.target);
      light.userData.radiance = entry.radiance;
      light.userData.specularFactor = entry.specular_factor ?? 0;
      light.userData.visibleGlossy = entry.visible_glossy ?? false;
      light.layers.set(0);              // never reaches the glass shell
      scene.add(light);
      areaLights.push(light);
    }
    const bg = data.background;
    scene.add(new THREE.AmbientLight(
      new THREE.Color().setRGB(...bg.color, THREE.LinearSRGBColorSpace), bg.strength));
    api.lightsLoaded = areaLights.length;
    applyOuterGlass();
    syncDirectLights();
  });

  // Both the model and the lights arrive asynchronously; whichever lands second
  // installs the shell material.
  function applyOuterGlass() {
    if (areaLights.length === 0 || modelParts.size === 0) return;
    for (const [name, spec] of Object.entries(SHELLS)) {
      const mesh = modelParts.get(name);
      if (!mesh) continue;
      mesh.material = physicalShell(spec);
      mesh.renderOrder = spec.order;
    }
    for (const [name, spec] of Object.entries(SCATTER_SHELLS)) {
      if (name === "Ring_GlassBody") continue;
      const mesh = modelParts.get(name);
      if (!mesh) continue;
        mesh.material = shellMaterial(spec, areaLights);
      mesh.renderOrder = spec.order;
      shellMaterials.set(name, mesh.material);
      if (spec.refract && refractionEnabled) {
        mesh.material.uniforms.uBackdrop.value = backdropTarget.texture;
        if (!refractors.includes(mesh)) refractors.push(mesh);
      } else {
        mesh.material.uniforms.uRefract.value = 0;
      }
      if (spec.worldAxis) {
        // any two perpendicular directions in the ring's plane will do, as long
        // as the bake and the lookup agree on them
        const u = mesh.material.uniforms;
        const axis = u.uRingAxisWorld.value;
        const seed = Math.abs(axis.y) > 0.9 ? new THREE.Vector3(1, 0, 0)
                                            : new THREE.Vector3(0, 1, 0);
        u.uRingRef.value.copy(seed).cross(axis).normalize();
        u.uRingRef2.value.copy(axis).cross(u.uRingRef.value).normalize();
        // The multiply half of the glass composite: a second draw of the same
        // geometry, just before the emission pass, so what is behind the band
        // is attenuated instead of replaced.
        if (spec.ringTransmit && !ringTransmitMesh) {
          ringTransmitMesh = new THREE.Mesh(mesh.geometry, ringTransmitMaterial(spec));
          const tu = ringTransmitMesh.material.uniforms;
          tu.uRingAxisWorld.value.copy(axis);
          tu.uRingRef.value.copy(u.uRingRef.value);
          tu.uRingRef2.value.copy(u.uRingRef2.value);
          ringTransmitMesh.renderOrder = spec.order - 0.5;
          ringTransmitMesh.frustumCulled = false;
          mesh.add(ringTransmitMesh);
          // it rides the ring's own transform, so its local matrix is identity
          ringTransmitMesh.position.set(0, 0, 0);
          ringTransmitMesh.quaternion.identity();
          ringTransmitMesh.scale.setScalar(1);
        }
      }
    }
    // Rendered alone in Blender the shell peaks at 32/255; lit by three's area
    // lights it peaks at ~220 and that band is what washes over the artwork.
    // Layers are how three expresses "this object is not lit by those lights":
    // the shell sits on its own layer, so it keeps the image-based reflection and
    // loses the punctual specular.
    const shell = modelParts.get("Outer_Physical_Glass");
    if (!shell) return;
    shell.layers.set(GLASS_LAYER);
    camera.layers.enable(GLASS_LAYER);
    // The shell encloses the projected atmosphere in Blender, so it must draw
    // after the domes in order to attenuate them too.
    shell.renderOrder = 30;
  }

  function setLightScale(scale) {
    lightScale = scale;
    areaLights.forEach(l => { l.intensity = l.userData.radiance * scale; });
  }

  // The phone tier loads a Draco-compressed, decimated model: the sphere shells
  // were tessellated for Cycles (the outer glass alone is 97k triangles for what
  // is geometrically a ball) and decimate freely, while the ring, its rails and
  // the forty-seven glyphs — the reason the model is reused at all — are untouched.
  // 7.08 MB -> 290 KB.
  const MODEL = quality.supersample === 1
    ? "./assets/zhihe-hero-mobile.glb"
    : "./assets/zhihe-hero.glb";
  const gltfLoader = new GLTFLoader();
  let draco = null;
  if (MODEL.includes("mobile")) {
    draco = new DRACOLoader();
    draco.setDecoderPath("./vendor/draco/gltf/");
    gltfLoader.setDRACOLoader(draco);
  }
  gltfLoader.load(MODEL, (gltf) => {
    draco?.dispose();
    if (disposed) {
      gltf.scene.traverse(node => { node.geometry?.dispose(); if (node.material) {
        for (const m of [node.material].flat()) m.dispose();
      }});
      return;
    }
    gltf.scene.traverse((node) => {
      if (!node.isMesh) return;
      if (node.name === "Outer_Physical_Glass") {
        const original = node.geometry;
        node.geometry = exteriorShellGeometry(original);
        original.dispose();
      }
      modelParts.set(node.name, node);
      // Standalone floor discs are not part of the native floating character.
      if (node.name.startsWith("GroundGlow_")) node.visible = false;
      const importedMaterial = node.material;
      node.material = solidMaterial(node.name)
        || glassMaterial(node.name)
        || translucentMaterial(node.name)
        || opaqueMaterial(node.name)
        || extraMaterial(node.name)
        || new THREE.MeshBasicMaterial({ color: 0xff00ff, toneMapped: false });  // magenta = unhandled
      for (const m of [importedMaterial].flat()) m.dispose();
      // after the chain: the occluder must not be overwritten by the fallback
      // the inlays sit inside the glass and are drawn after the band composites,
      // so the band's multiply pass does not dim them twice - their own
      // brightness was fitted against Cycles' render of them alone
      if (node.name.startsWith("Glyph_") || node.name.startsWith("RingEdge_")) {
        node.renderOrder = 22;
      }
      if (DEPTH_ONLY.has(node.name)) {
        node.material = depthOnlyMaterial();
        node.renderOrder = -10;
        node.userData.depthOnly = true;
      }
    });
    modelRoot.add(gltf.scene);
    applyOuterGlass();
    const ring = modelParts.get("Ring_GlassBody");
    ringOptics = createRingOptics({renderer, ring, parts: modelParts,
      backdrop: backdropTarget.texture, gain: options.ringGain ?? 1,
      emissionGain: 1});
    refractors.push(ring);
    runtime = createZhiheRuntime({
      parts: modelParts, domes, atmosphereLayers:[...domes,...fillDomes,...veilDomes], camera, videoEl, root: modelRoot, appearance,
    });
    bloomMask.setParts(modelParts,runtime.icons.mesh);
    runtime.applyAppearance();
    api.modelLoaded = true;
    api.partNames = [...modelParts.keys()];
  }, undefined, (err) => { draco?.dispose(); if (!disposed) api.modelError = String(err); });

  // Verification harness. Each layer of this port is checked against a Blender
  // render of the same subset, so the page has to be able to hand back exactly
  // what it drew and to isolate one subsystem at a time.
  let readback = new Uint8Array(width * height * 4);

  // Metrics that only need numbers should not have to round-trip a PNG through
  // the dev server; a loop sweep is hundreds of frames.
  function pixels() {
    draw();
    const gl = renderer.getContext();
    if (readback.length !== width * height * 4) readback = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, readback);
    return { data: readback, width, height };   // gl origin, bottom-left
  }

  async function grab(name) {
    draw();
    const gl = renderer.getContext();
    const row = width * 4;
    if (readback.length !== width * height * 4) readback = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, readback);
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext("2d");
    const image = ctx.createImageData(width, height);
    for (let y = 0; y < height; y++) {
      const src = (height - 1 - y) * row, dst = y * row;   // gl origin is bottom-left
      for (let x = 0; x < row; x += 4) {
        image.data[dst + x] = readback[src + x];
        image.data[dst + x + 1] = readback[src + x + 1];
        image.data[dst + x + 2] = readback[src + x + 2];
        image.data[dst + x + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
    const blob = await new Promise(res => canvas.toBlob(res, "image/png"));
    return (await fetch("/save/" + name, { method: "POST", body: blob })).ok;
  }

  // Debug channels have to come back untouched. grab() reads the presented
  // frame, which has been through AgX, so anything written as data - the band's
  // radius, its angle round the ring - came back curved. The ring bake and the
  // band curve were both built on coordinates that had been through it.
  async function grabRaw(name) {
    const mat = compositeScene.children[0].material;
    mat.uniforms.uRaw.value = 1;
    const ok = await grab(name);
    mat.uniforms.uRaw.value = 0;
    return ok;
  }

  /** Show only the model parts whose name matches, and set the atmosphere weight. */
  function isolate({ parts = null, atmosphere = false, fill = null, yaw: y = 0 } = {}) {
    applyWeights(y);
    if (!atmosphere) domes.forEach(m => { m.material.uniforms.uDirWeight.value = 0; });
    if (!(fill === null ? atmosphere : fill)) {
      fillDomes.concat(veilDomes).forEach(m => { m.material.uniforms.uDirWeight.value = 0; });
    }
    let shown = 0;
    const showingRing = parts === null || parts.some(p => "Ring_GlassBody".startsWith(p));
    modelParts.forEach((mesh, name) => {
      // the depth-only occluder stays on for composites, off for single-part checks
      // the depth-only occluder is on for composites and can also be asked for
      // by name: a subset compared against a Cycles render that still contains
      // it has to contain it too, and leaving it out read as 12% too bright
      mesh.visible = parts === null ? true
        : parts.some(p => name.startsWith(p) || name === p);
      if (mesh.userData.opticalInlay && showingRing) mesh.visible = false;
      if (mesh.visible) shown++;
    });
    return shown;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    powerLoop?.dispose();
    document.removeEventListener('visibilitychange',syncVisibility);
    document.removeEventListener('zhihe-host-visibility',onHostVisibility);
    intersection?.disconnect();
    window.removeEventListener("pointerdown", resumeVideo);
    videoEl.pause(); videoEl.replaceChildren(); videoEl.removeAttribute("src"); videoEl.load(); videoEl.remove();
    draco?.dispose();
    const geometries = new Set(), materials = new Set();
    for (const graph of [scene, compositeScene]) graph.traverse(node => {
      if (node.geometry) geometries.add(node.geometry);
      if (node.material) for (const m of [node.material].flat()) materials.add(m);
    });
    materials.forEach(m => {
      for (const value of Object.values(m)) if (value?.isTexture) ownedTextures.add(value);
      for (const u of Object.values(m.uniforms || {})) if (u.value?.isTexture) ownedTextures.add(u.value);
      m.dispose();
    });
    geometries.forEach(g => g.dispose());
    ownedTextures.forEach(t => t.dispose());
    ringOptics?.dispose(); bloom.dispose(); bloomMask.dispose(); linearTarget.dispose(); backdropTarget?.dispose(); environmentTarget?.dispose(); pmrem.dispose();
    renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
  }

  Object.assign(api, {
    renderer, scene, camera, domes, fillDomes, veilDomes, videoEl, draw, grab, grabRaw, isolate,
    resize, fitToBudget, setOrbit, setUseVideo, pixels, dispose,
    start: () => powerLoop?.start(),
    wake: () => powerLoop?.wake(),
    setSuspended(value) { hostSuspended=!!value;syncVisibility(); },
    setAppearance(patch) {
      if (disposed) return;
      Object.assign(appearance,normalizeAppearance(patch,appearance));
      // Increase the authored moving cloud radiance, not a flat opaque fill.
      domes.forEach(m => { m.material.uniforms.uEmission.value = EMISSION * (1 + appearance.daylight * 3.05); });
      fillDomes.forEach(m => { m.material.uniforms.uGain.value=appearance.sphereFill; m.material.uniforms.uDaylight.value=appearance.daylight; });
      const u=compositeScene.children[0].material.uniforms;
      u.uBloomGains.value.set(appearance.eyeGlow,appearance.ringGlow,appearance.sphereGlow);
      u.uBloomRadii.value.set(appearance.eyeRadius,appearance.ringRadius,appearance.sphereRadius);
      runtime?.applyAppearance();
      applyWeights();
      powerLoop?.wake();
    },
    /** 算圖用：影片跳到指定時間後，強制把那一格送進貼圖（暫停中的影片不會自己送）。 */
    pushVideoFrame() { if (videoEl.readyState >= 2) { videoHasFrame = true; videoMap.needsUpdate = true; } },
    setLoopGainAmount(v) { loopGainAmount = v; },
    setLoopScalar(v) { loopScalarOverride = v; },
    setDomeWeightYawOnly(v) { domeWeightYawOnly = v; },
    setRadialRamp: (a, b) => domes.forEach(m => m.material.uniforms.uRadial.value.set(a, b)),
    setOnlyFront: (v) => { onlyFront.checked = v; },
    setFillGain: (g) => fillDomes.forEach(m => { m.material.uniforms.uGain.value = g; }),
    setRingBakeCurve: (contrast, mid) => shellMaterials.forEach((m) => {
      if (!m.uniforms.uRingBakeContrast) return;
      m.uniforms.uRingBakeContrast.value = contrast;
      if (mid !== undefined) m.uniforms.uRingBakeMid.value = mid;
    }),
    SUPERSAMPLE,
    setYaw: v => { yaw = v; },
    applyWeights,
    modelRoot, modelParts, shellMaterials, glowMaterials,
    modelLoaded: false,
    lightsLoaded: 0,
    areaLights, setLightScale,
    setUseDirectLights: (v) => { useDirectLights = v; syncDirectLights(); },
    setFilterWidth: (w) => {
      filterWidth = w;
      const mat = compositeScene.children[0].material;
      mat.uniforms.uWeights.value = new Float32Array(resolveWeights(w));
      mat.uniformsNeedUpdate = true;
    },
    THREE,
  });
  // Accessors, not values: Object.assign invokes a source getter and copies the
  // result, so declaring these inline froze width and height at their mount-time
  // numbers and every caller read a stale size after the first resize.
  Object.defineProperties(api, {
    visualReady: { get: () => api.modelLoaded && api.environmentLoaded && [...ownedTextures].every(t=>t.isVideoTexture || !!t.image?.width) },
    width: { get: () => width },
    height: { get: () => height },
    linearTarget: { get: () => linearTarget },
    runtime: { get: () => runtime, configurable: true },
    orbit: { get: () => ({ yaw: orbitYaw, pitch: orbitPitch }) },
    disposed: { get: () => disposed },
    appearance: { get: () => ({...appearance}) },
    performance: { get: () => ({...powerLoop.stats,hidden:document.hidden,hostSuspended,offscreen,width,height,hdrWidth:linearTarget.width,hdrHeight:linearTarget.height,quality:options.quality||'high'}) },
  });
  powerLoop=createPowerLoop({mobile,showcase,render:frame,state:()=>runtime?.state||'idle',
    onPolicy(policy){videoAllowed=policy.video;setUseVideo(useVideo.checked);}});
  let suspendedNow=false;
  function syncVisibility(){
    const next=!!(document.hidden||hostSuspended||offscreen);
    // 停下來時最後一格會一直留在畫面上（例如被對話框蓋住一半、減少動態）：先把眼睛張開畫一格，免得停在眨眼中
    if(next&&!suspendedNow&&!disposed){try{runtime?.openEyes?.();frame(0);}catch(e){}}
    suspendedNow=next;powerLoop.suspend(next);
  }
  function onHostVisibility(event){hostSuspended=event.detail===false;syncVisibility();}
  document.addEventListener('visibilitychange',syncVisibility);
  document.addEventListener('zhihe-host-visibility',onHostVisibility);
  const intersection=typeof IntersectionObserver==='undefined'?null:new IntersectionObserver(entries=>{
    offscreen=!entries[0].isIntersecting;syncVisibility();
  });
  intersection?.observe(stage);
  syncVisibility();
  if(options.autoStart!==false)powerLoop.start();
  return api;
}

