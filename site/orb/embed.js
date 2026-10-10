
import { createZhiheScene } from "./zhihe-scene.js";
import {createCompanion} from './zhihe-companion.js';
import {roomAppearance} from './zhihe-room.js';

// 只放形象本身，沒有 demo 面板。宿主（Android）透過 window.ZhiheHost 驅動。
// 模型是非同步載入的：createZhiheScene 回來的時候 runtime 還是 null，
// 要等 scene.modelLoaded 才能碰，這點照 app.html 的 ready() 來做。
const stage = document.getElementById("stage");
const params = new URLSearchParams(location.search);
const quality = params.get("quality") || "mobile";

let scene = null;
let ready = false;
let pendingState = params.get("state") || "idle";
let pendingIcon = null;
let pendingAudio = 0;
let pendingPresentation = "rest";
let pendingPoseGain = 1, pendingRingTilt = 0;
let reducedMotion = false;
let companion=null, playful=false, light=params.get('light')==='true';
function applyTheme(){
  // Same authored material in both rooms. Native compositing handles transparency.
  scene?.setAppearance(roomAppearance(light));
}

function size() {
  const density = Math.min(window.devicePixelRatio || 1, 2.5);
  return [Math.round((stage.clientWidth || 1) * density), Math.round((stage.clientHeight || 1) * density)];
}

function notify(what) {
  try {
    if (window.ZhiheBridge && window.ZhiheBridge.onEvent) window.ZhiheBridge.onEvent(what);
  } catch (e) { /* 沒有宿主就算了 */ }
}

function mount() {
  const [w, h] = size();
  try {
    // Android WebView's half-float MSAA resolve can retain previous ring poses.
    // Keep the density-scaled native buffer and spatial reconstruction filter,
    // but avoid multisampled HDR targets in this transparent native surface.
    scene = createZhiheScene({ container: stage, size: Math.min(w, 1150), quality, msaa: 0, nativeComposite: true, orthoSize: 4.6, appearance: roomAppearance(light) });
  } catch (e) {
    console.error("createZhiheScene threw", e);
    notify("failed");
    return;
  }
  scene.resize(w, h);

  const canvas = stage.querySelector("canvas");
  if (canvas) {
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.addEventListener("webglcontextlost", () => notify("contextlost"));
  }
  if (scene.renderer && scene.renderer.debug) {
    scene.renderer.debug.onShaderError = () => {
      console.error("shader compilation failed");
      notify("failed");
    };
  }

  const mounted = scene;
  const deadline = performance.now() + 30000;

  // 用計時器輪詢而不是 rAF：畫面被切到背景時 rAF 會被節流。
  const poll = () => {
    if (scene !== mounted || mounted.disposed) return;
    if (mounted.modelError) { console.error("model load error"); notify("failed"); return; }
    if (performance.now() > deadline) { console.error("model load timeout"); notify("failed"); return; }
    if (!mounted.visualReady) return void setTimeout(poll, 100);

    ready = true;
    mounted.runtime?.setPoseGain(pendingPoseGain);
    mounted.runtime?.setRingTilt(pendingRingTilt);
    companion=createCompanion(mounted);
    companion.setPresentation(pendingPresentation);companion.setEnabled(playful);companion.setReduced(reducedMotion);
    applyTheme();
    // The host supplies the stage. Keep the authored character, omit only the
    // standalone demo's glowing floor discs that compete with native controls.
    mounted.modelParts?.forEach((part, name) => {
      if (name.startsWith("GroundGlow_")) part.visible = false;
    });
    try {
      mounted.runtime.setState(pendingState);
      mounted.runtime.setAudioLevel(pendingAudio);
      mounted.runtime.setPresentation(pendingPresentation);
      mounted.runtime.showIcon(pendingIcon);
      mounted.runtime.rig.snap();
      mounted.applyWeights();
      mounted.draw();
    } catch (e) { console.error("runtime init", e); }
    if (mounted.wake) mounted.wake();
    notify("ready");
  };
  poll();
}

function withRuntime(fn) {
  if (!ready || !scene || !scene.runtime) return false;
  try {
    fn(scene.runtime);
    if (reducedMotion) { scene.runtime.rig.snap(); scene.applyWeights(); scene.draw(); }
    else if (scene.wake) scene.wake();
    return true;
  }
  catch (e) { console.error(e); return false; }
}

window.ZhiheHost = {
  filmCue(stage) {
    if(window.__filmCueTimer) clearInterval(window.__filmCueTimer);
    if(!stage){companion?.setEnabled(playful);return;}
    const began=performance.now();
    companion?.setEnabled(false);
    window.__filmCueTimer=setInterval(()=>{
      const t=(performance.now()-began)/1000;
      let x=0,y=0;
      if(stage==='clean') x=t<.65?-.55:t<1.3?.55:0;
      if(stage==='guide'){x=.48;y=.7;}
      withRuntime(r=>{
        r.setState('idle');r.showIcon(null);r.lookAt(x,y,.2);
        r.setPose({normal:[.06*Math.sin(t*.9),.23+.05*Math.sin(t*1.2),1],offset:[0,.12,.18],scale:1.05,
          head:[-y*.35,x*.65,.025*Math.sin(t)],headOffset:[0,0,0],headScale:1,shape:0,protectEyes:false});
      });
    },50);
  },
  setPresentation(name) {
    pendingPresentation = name;
    withRuntime(r => companion?companion.setPresentation(name):r.setPresentation(name));
  },
  setTheme(value){light=!!value;applyTheme();if(reducedMotion&&ready)scene.draw();},
  setPoseGain(value){pendingPoseGain=Number(value)||1;withRuntime(r=>r.setPoseGain(pendingPoseGain));},
  setRingTilt(value){pendingRingTilt=Number(value)||0;withRuntime(r=>r.setRingTilt(pendingRingTilt));},
  setPlayful(value){playful=!!value;companion?.setEnabled(playful);},
  react(kind,dir){companion?.react(kind||'hello',Number(dir)||1);scene?.wake();},
  // 手機歪向哪邊、他的手指在哪：看過去（不搶正在做的動作）
  look(x,y){companion?.look(Number(x)||0,Number(y)||0);scene?.wake();},
  companionState(){return companion?.debug();},
  setState(name) {
    pendingState = name;
    withRuntime(function (r) { r.showIcon(null); r.setState(name); });
  },
  showIcon(name) {
    pendingIcon = name || null;
    withRuntime(function (r) { r.showIcon(pendingIcon); });
  },
  setAudioLevel(v) {
    pendingAudio = Number(v) || 0;
    withRuntime(function (r) { r.setAudioLevel(pendingAudio); });
  },
  lookAt(x, y, hold) {
    withRuntime(function (r) { r.lookAt(Number(x) || 0, Number(y) || 0, hold); });
  },
  blink() { withRuntime(function (r) { r.blink(); }); },
  isReady() { return ready; },
  setReducedMotion(value) {
    reducedMotion = !!value;
    companion?.setReduced(reducedMotion);
    if (!scene) return;
    scene.setUseVideo(!value);
    scene.setSuspended(!!value);
    if (value) { scene.runtime?.openEyes?.(); scene.runtime?.update?.(0); scene.runtime?.rig.snap(); scene.applyWeights(); scene.draw(); } else scene.wake();
  },
};

let pointerDown = null,holdTimer=null,lastTap=0,tapTimer=null;
stage.addEventListener("pointerdown", e => {
  if(pointerDown)return;
  pointerDown={x:e.clientX,y:e.clientY,time:performance.now(),id:e.pointerId,held:false};
  stage.setPointerCapture(e.pointerId);
  holdTimer=setTimeout(()=>{if(pointerDown&&playful){pointerDown.held=true;companion?.react('pet');}},550);
});
stage.addEventListener('pointermove',e=>{
  if(!pointerDown||e.pointerId!==pointerDown.id)return;
  if(Math.hypot(e.clientX-pointerDown.x,e.clientY-pointerDown.y)>15)clearTimeout(holdTimer);
  companion?.look((e.clientX/stage.clientWidth-.5)*2,-(e.clientY/stage.clientHeight-.5)*2);
});
stage.addEventListener("pointerup", e => {
  if(!pointerDown||e.pointerId!==pointerDown.id)return;
  clearTimeout(holdTimer);const d=pointerDown,dx=e.clientX-d.x,dy=e.clientY-d.y;pointerDown=null;
  if(d.held)return;
  if(playful&&Math.hypot(dx,dy)>28)companion?.react('swipe',dx>=0?1:-1);
  else if(Math.hypot(dx,dy)<18&&performance.now()-d.time<700){
    // 連點兩下：害羞躲一下（不算「點一下」）；只點一下：等一下確定不是連點再回報
    const now=performance.now();
    if(playful&&now-lastTap<330){clearTimeout(tapTimer);lastTap=0;companion?.react('shy',e.clientX<stage.clientWidth/2?1:-1);}
    else{lastTap=now;tapTimer=setTimeout(()=>notify('tap'),playful?340:0);}
  }
});
stage.addEventListener('pointercancel',()=>{clearTimeout(holdTimer);pointerDown=null;});
stage.addEventListener('lostpointercapture',()=>{clearTimeout(holdTimer);pointerDown=null;});

// 心跳（每 10 秒）：回報畫面有沒有在動、眼睛開合，宿主記到 logcat（長時間待機閉眼不張開的實測用）。
// 宿主說看得到、頁面也沒被藏起來，畫面卻停了 → 自己叫醒；眼睛停在閉著（不是睡覺狀態）→ 張開。
let hostVisible = true, hbFrames = -1, hbStuck = 0;
setInterval(function () {
  if (!scene || !ready || scene.disposed) return;
  try {
    const p = scene.performance, r = scene.runtime, d = r?.debug?.() || {};
    const eye = r?.eyeOpen ?? 1;
    const moving = p.frames !== hbFrames; hbFrames = p.frames;
    let fix = "";
    if (hostVisible && !document.hidden && !reducedMotion && !p.offscreen) {
      if (p.mode === "paused") { scene.setSuspended(false); fix = "unpause"; }
      else if (!moving) { hbStuck++; scene.wake(); fix = "wake"; }
      else hbStuck = 0;
      if (eye < 0.5 && d.profile !== "sleep" && !d.icon) { r.openEyes(); scene.wake(); fix += "+eyes"; }
    }
    notify("hb mode=" + p.mode + " fps=" + (p.fps || 0).toFixed(1) + " frames=" + p.frames + " eye=" + eye.toFixed(2) +
      " state=" + d.name + "/" + d.profile + " icon=" + (d.icon || "-") + " hidden=" + p.hidden + " host=" + hostVisible +
      " off=" + p.offscreen + " reduce=" + reducedMotion + " act=" + (companion?.debug?.().active || "-") + (fix ? " fix=" + fix : ""));
  } catch (e) { notify("hb error " + e); }
}, 10000);

// 宿主進背景就停下來，回來不快轉——跟 app.html 一樣的生命週期處理。
document.addEventListener("zhihe-host-visibility", function (e) {
  if (!scene) return;
  const visible = e.detail === true || e.detail === "true";
  hostVisible = visible;
  if(!visible){clearTimeout(holdTimer);pointerDown=null;}
  scene.setSuspended(reducedMotion || !visible);
  try {
    if (visible && scene.wake) scene.wake();
  } catch (err) { /* 沒有這個方法就算了 */ }
});

let resizeTimer = null;
window.addEventListener("resize", function () {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(function () { if (scene) scene.resize(...size()); }, 120);
});

window.addEventListener("error", function (e) {
  console.error("window error", e.message);
});

mount();


// ── 網站用的接線（官網首頁把這一頁放在 iframe 裡）────────────────────────────
// 父頁面用 postMessage 告訴牠滑鼠在哪、要不要暫停；牠準備好或失敗時回報，父頁面才把預備圖換掉。
const tell = what => { try { parent.postMessage({ zhihe: what }, location.origin); } catch (e) { /* 單獨開這一頁時沒有父頁面 */ } };
window.ZhiheBridge = { onEvent: tell };
const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)');
const whenReady = () => {
  if (!ready) return void setTimeout(whenReady, 150);
  window.ZhiheHost.setTheme(params.get('light') === 'true');
  window.ZhiheHost.setPlayful(true);
  window.ZhiheHost.setReducedMotion(prefersReduced.matches);
};
whenReady();
prefersReduced.addEventListener('change', e => window.ZhiheHost.setReducedMotion(e.matches));
window.addEventListener('message', e => {
  if (e.origin !== location.origin || !e.data) return;
  const d = e.data;
  if (d.look) window.ZhiheHost.look(d.look[0], d.look[1]);
  if (d.react) window.ZhiheHost.react(d.react, 1);
  if ('suspend' in d && scene && !prefersReduced.matches) { scene.setSuspended(!!d.suspend); if (!d.suspend && scene.wake) scene.wake(); }
});
