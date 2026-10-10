import {PRESENTATIONS} from './zhihe-rig.js';

// Small, interruptible performances driven by scene time: background suspension
// pauses them too. No camera access, audio capture, or persistent pointer data.

const TAU=Math.PI*2;
const clamp=(v,a=0,b=1)=>Math.min(b,Math.max(a,v));
const seg=(p,a,b)=>clamp((p-a)/(b-a));              // p 走到 a..b 這一段的進度
const ease=p=>p<.5?2*p*p:1-Math.pow(-2*p+2,2)/2;      // 緩進緩出
const out=p=>1-Math.pow(1-p,3);                       // 快出慢收
const bell=p=>Math.sin(Math.PI*clamp(p));             // 0→1→0
const hold=(p,a,b)=>out(seg(p,0,a))*(1-ease(seg(p,b,1)));   // 上去、停住、回來

// 第二批動作（2026-10-05）。每個回傳「相對於目前樣子的偏移」：
//   h 頭的角度 [低頭,轉頭,歪頭]、ho 頭的位置、hs 頭的大小
//   n 環面的傾斜 [左右,上下]、o 環的位置、s 環的大小
//   rt 環直接轉（弧度，可以超過一圈）、ht 頭直接轉
//   eye [寬,高] 眼睛倍率、glow 亮度、spin 環沿著自己多轉、look 眼睛看哪
// d＝方向（1 或 -1）。時間都是秒。
const SHOWS={
  // 環翻筋斗：整個環往前翻一圈，人跟著小跳
  flip:{t:1.3,f:(p)=>{const e=ease(p),up=bell(p);return{rt:[e*TAU,0,0],o:[0,up*.10,0],ho:[0,up*.08,0],h:[-up*.12,0,0],glow:1+up*.5,eye:[1,1+up*.12]};}},
  // 硬幣轉：環像桌上的硬幣立起來轉兩圈，越轉越慢
  coin:{t:1.9,f:(p,d)=>{const a=out(p)*TAU*2*d,w=Math.sin(p*TAU*2)*(1-p);return{rt:[0,a,0],s:1-bell(p)*.06,h:[0,w*.1,0],look:[Math.sin(a)*.6,0],glow:1+bell(p)*.3};}},
  // 陀螺儀：兩個軸一起轉，想事情想到發亮
  gyro:{t:2.4,f:(p)=>{const e=ease(p),a=bell(p);return{rt:[e*TAU,e*TAU*2,0],h:[-a*.1,0,0],eye:[1,1-a*.25],glow:1+a*.6,spin:p*3};}},
  // 呼拉圈：環歪著繞三圈，頭往反方向晃
  hula:{t:2.6,f:(p)=>{const env=Math.pow(bell(p),.6),g=p*TAU*3,c=Math.cos(g),s=Math.sin(g);return{n:[c*.55*env,s*.4*env],o:[c*.07*env,s*.05*env,0],ho:[-c*.05*env,0,0],h:[0,0,-c*.14*env],spin:p*8,eye:[1,1-env*.2]};}},
  // 光環：環縮小、躺平、升到頭頂，瞇眼得意
  halo:{t:2.8,f:(p)=>{const a=hold(p,.25,.78);return{rt:[-a*1.15,0,0],o:[0,a*1.12,0],s:1-a*.45,h:[-a*.08,0,Math.sin(p*TAU*1.5)*.06*a],eye:[1+a*.1,1-a*.45],glow:1+a*.7,spin:p*4};}},
  // 打瞌睡：慢慢低頭、眼睛越閉越小、點兩次頭，然後自己驚醒甩甩頭
  doze:{t:6.5,follow:6,f:(p)=>{
    const wake=seg(p,.80,.86),s=ease(seg(p,0,.3))*(1-wake),n1=bell(seg(p,.3,.5)),n2=bell(seg(p,.5,.72));
    const droop=s*(.22+n1*.18+n2*.3),jolt=bell(seg(p,.80,1)),sh=Math.sin(seg(p,.86,1)*TAU*2)*(1-ease(seg(p,.86,1)));
    return{h:[droop-jolt*.1,sh*.18,s*.1+n2*.05*s],ho:[0,-droop*.25+jolt*.1,0],hs:1+jolt*.05,o:[0,-s*.1+jolt*.06,0],n:[0,s*.25],
      eye:[1,1-s*(.72+.2*Math.max(n1,n2))+jolt*.3],glow:1-s*.35+jolt*.3};}},
  // 打哈欠：頭往後仰、眼睛擠起來、環撐大
  yawn:{t:2.4,f:(p)=>{const a=Math.pow(bell(p),.7);return{h:[-a*.28,0,a*.06],hs:1+a*.07,ho:[0,a*.05,0],eye:[1+a*.1,1-a*.85],s:1+a*.14,o:[0,a*.08,0],n:[0,a*.2]};}},
  // 歪頭：咦？
  tilt:{t:1.8,f:(p,d,once)=>{const a=hold(p,.2,.75);once('b1',.38);once('b2',.52);return{h:[a*.05,a*d*.12,a*d*.52],n:[-a*d*.42,.06*a],ho:[a*d*.07,-a*.02,0],o:[-a*d*.05,0,0],eye:[1,1+a*.08]};}},
  // 東張西望：看左邊、停一下、看右邊、停一下
  lookAround:{t:2.8,f:(p,d)=>{const x=Math.sin(p*TAU),f=Math.sign(x)*Math.pow(Math.abs(x),.45)*d,env=Math.pow(bell(p),.3);return{h:[-.04*env,f*.55*env,0],look:[f*.9,.1],n:[f*.18*env,0],ho:[f*.04*env,0,0]};}},
  // 開心扭：左右快扭幾下加小跳
  wiggle:{t:1.3,f:(p)=>{const w=Math.sin(p*TAU*4)*(1-p)*out(seg(p,0,.15)),hop=Math.abs(Math.sin(p*TAU*2))*(1-p);return{h:[0,0,w*.3],ho:[w*.05,hop*.07,0],n:[-w*.3,hop*.1],o:[0,hop*.06,0],eye:[1,1-.4*bell(p)],glow:1+.3*bell(p)};}},
  // 嚇一跳：往後一縮、眼睛瞪大、環彈起來
  startle:{t:1.0,follow:18,f:(p)=>{const a=out(seg(p,0,.12))*(1-ease(seg(p,.3,1)));return{ho:[Math.sin(p*60)*.012*a,a*.16,-a*.1],hs:1-a*.07,h:[-a*.2,0,0],o:[0,a*.3,0],s:1+a*.16,eye:[1+a*.15,1+a*.3],glow:1+a*.8,spin:out(p)*5};}},
  // 跳舞：左右搖四拍，每拍環轉一格，最後一拍翻一圈
  dance:{t:3.4,f:(p)=>{const ph=p*4,x=Math.sin(p*TAU*2),bo=Math.abs(Math.sin(p*TAU*4))*.06,env=Math.min(1,p*8)*Math.min(1,(1-p)*8);
    return{h:[-bo*env,x*.26*env,x*.36*env],ho:[x*.15*env,bo*1.8*env,0],n:[-x*.62*env,.1*env+bo*2*env],o:[-x*.10*env,bo*1.5*env,0],
      spin:(Math.floor(ph)+out(ph%1))*1.2,glow:1+bo*4*env,rt:[ease(seg(p,.75,1))*TAU,0,0],eye:[1,1-.3*env]};}},
  // 繞行：環縮小，像月亮一樣繞著頭走兩圈，眼睛跟著看
  orbit:{t:2.6,f:(p,d)=>{const env=Math.pow(bell(p),.5),g=p*TAU*2*d,c=Math.cos(g),s=Math.sin(g);return{o:[c*.26*env,s*.2*env+.05*env,0],n:[c*.3*env,.25*env],s:1-env*.18,h:[-s*.08*env,c*.2*env,0],look:[c,s],spin:p*5};}},
  // 想事情：抬頭看旁邊、瞇眼，環慢慢自己轉一整圈
  ponder:{t:3.0,f:(p,d)=>{const a=hold(p,.2,.8);return{h:[-a*.16,a*d*.3,a*d*.1],look:[d*.7,.7],eye:[1,1-a*.3],n:[Math.sin(p*TAU)*.2*a,.15*a+Math.cos(p*TAU)*.12*a],rt:[0,ease(p)*TAU*d,0],glow:1+a*.2};}},
  // 打噴嚏：吸、吸——哈啾！環被噴大一圈
  sneeze:{t:1.7,follow:16,f:(p)=>{const i1=ease(seg(p,0,.25)),i2=ease(seg(p,.3,.5)),snap=seg(p,.55,.62),rec=ease(seg(p,.62,1));
    const back=(i1*.5+i2*.5)*(1-snap),fwd=snap*(1-rec);
    return{h:[-back*.3+fwd*.5,0,back*.05],hs:1+back*.06-fwd*.05,ho:[0,back*.05-fwd*.08,fwd*.08],eye:[1,1-back*.5-fwd*.9],
      s:1+fwd*.3,o:[0,fwd*.12,0],n:[Math.sin(p*40)*.2*fwd,fwd*.3],glow:1+fwd,spin:snap*2.5+rec};}},
  // 鞠躬：謝謝你
  bow:{t:1.7,f:(p)=>{const a=hold(p,.25,.7);return{h:[a*.5,0,0],ho:[0,-a*.1,a*.05],rt:[a*.45,0,0],o:[0,-a*.08,0],eye:[1,1-a*.6]};}},
  // 歡呼：跳兩下，第二下環翻一圈
  cheer:{t:1.9,f:(p)=>{const up=bell(seg(p,0,.4))*.7+bell(seg(p,.4,1));return{ho:[0,up*.13,0],o:[0,up*.12,0],hs:1+up*.05,h:[-up*.14,0,Math.sin(p*TAU*2)*.06],rt:[ease(seg(p,.4,.95))*TAU,0,0],eye:[1+up*.08,1-up*.4],glow:1+up*.7,spin:p*4};}},
  // 轉暈：被撥太多次，頭繞圈圈、環像快倒的硬幣越晃越小
  dizzy:{t:2.8,f:(p)=>{const env=(1-ease(p))*out(seg(p,0,.1)),g=p*TAU*3.5,k=g*(1+p);return{h:[Math.sin(g)*.14*env,0,Math.cos(g)*.22*env],ho:[Math.cos(g)*.05*env,0,0],n:[Math.cos(k)*.6*env,Math.sin(k)*.5*env],o:[Math.cos(k)*.05*env,0,0],eye:[1,1-.35*env],look:[Math.cos(g),Math.sin(g)]};}},
  // 嘆氣：吸一口、整個垮下來
  sigh:{t:2.0,f:(p)=>{const up=ease(seg(p,0,.4))*(1-ease(seg(p,.45,.85))),down=ease(seg(p,.45,.85))*(1-ease(seg(p,.85,1)));return{hs:1+up*.06-down*.03,h:[-up*.1+down*.2,0,0],ho:[0,up*.05-down*.07,0],o:[0,up*.06-down*.1,0],s:1+up*.05-down*.06,eye:[1,1-down*.5],glow:1-down*.25};}},
};

// 閒著的時候自己做什麼，看牠現在是什麼樣子。沒列到的樣子（提醒、寫字）不自己亂動。
const IDLE={
  rest:['curious','stretch','lookAround','tilt','peek','nod','hula','coin','wiggle','sigh','yawn','orbit','lookAround','tilt'],
  distant:['curious','lookAround','tilt','orbit','coin','stretch','yawn'],
  night:['yawn','sigh','curious','stretch','yawn','tilt'],
  think:['ponder','gyro','orbit','tilt','ponder'],
  listen:['nod','tilt'],
  result:['wiggle','nod','tilt'],
};
// 多久沒人理牠就打瞌睡（秒）
const DOZE_AFTER={rest:75,distant:60,night:40};

export const SHOW_NAMES=['hello','pet','swipe','curious','stretch','nod','bounce','shy','peek','shake','spin',...Object.keys(SHOWS)];

export function createCompanion(scene) {
  const r=scene.runtime, update=r.update.bind(r);
  let enabled=false,reduced=false,auto=true,presentation='rest',active=null,clock=0,next=9,lastReaction=null,serial=0,lastIdle=null,lastTouch=0,swipes=[];
  function reset(){active=null;r.setFx?.();r.setPresentation(presentation);}
  function start(kind,direction){
    const D={pet:1.7,nod:.95,bounce:.9,shy:1.6,peek:1.4,shake:.9,spin:1.15};
    active={kind,direction,time:0,duration:SHOWS[kind]?.t||D[kind]||1.25,fired:new Set()};
    r.setFx?.();
    if(kind!=='doze')r.blink();
    next=clock+9+Math.random()*7;
  }
  // 外面叫的（他碰牠、App 有事要牠表示）。internal＝牠自己閒著做的，不算「有人理牠」。
  function react(kind='hello',direction=1,internal=false){
    if(!enabled||reduced)return false;
    if(!internal){
      lastTouch=clock;
      // 睡著被碰：嚇一跳（不管原本要牠做什麼）
      if(active?.kind==='doze'&&active.time/active.duration<.8)kind='startle';
      // 四秒內被撥三次：轉暈
      if(kind==='swipe'){swipes=swipes.filter(t=>clock-t<4);swipes.push(clock);if(swipes.length>=3){swipes=[];kind='dizzy';}}
    }
    if(SHOWS[kind]&&presentation==='compose')return false;   // 寫字那個樣子的幾何是精算過的，不疊表演
    lastReaction=kind;serial++;
    // hello 打招呼、pet 被摸、swipe 被撥、curious／stretch 自己動一動（原本的）
    // nod 點頭（聽到了）、bounce 跳一下（做好了）、shy 害羞躲一下（連點兩下）、peek 探頭看（他在打字）、shake 搖頭（沒成功）
    start(kind,direction);return true;
  }
  function idle(){
    const pool=IDLE[presentation];if(!pool){next=clock+10;return;}
    const after=DOZE_AFTER[presentation];
    if(after&&clock-lastTouch>after&&lastIdle!=='doze'&&Math.random()<.6){lastIdle='doze';react('doze',1,true);return;}
    let k=pool[Math.floor(Math.random()*pool.length)];
    if(k===lastIdle)k=pool[(pool.indexOf(k)+1+Math.floor(Math.random()*(pool.length-1)))%pool.length];
    lastIdle=k;react(k,Math.random()<.5?-1:1,true);
  }
  r.update=dt=>{
    clock+=dt;
    if(enabled&&!reduced&&auto&&!active&&clock>next)idle();
    if(active){
      active.time+=dt;const p=Math.min(1,active.time/active.duration),a=Math.sin(Math.PI*p),w=Math.sin(Math.PI*p*2)*a;
      const b=r.rig?.base?.(presentation)||PRESENTATIONS[presentation]||PRESENTATIONS.rest,d=active.direction;
      const k=active.kind,bh=b.head||[0,0,0],bn=b.normal||[0,.2,1],bo=b.offset||[0,.12,.2];
      const show=SHOWS[k];
      if(show){
        const once=(key,at)=>{if(p>=at&&!active.fired.has(key)){active.fired.add(key);r.blink();}};
        const s=show.f(p,d,once)||{};
        const v=(arr,i)=>Number.isFinite(arr?.[i])?arr[i]:0;
        r.setPose({...b,shape:0,protectEyes:false,follow:show.follow||11,
          head:[bh[0]+v(s.h,0),bh[1]+v(s.h,1),bh[2]+v(s.h,2)],
          headOffset:[v(s.ho,0),v(s.ho,1),v(s.ho,2)],headScale:Number.isFinite(s.hs)?s.hs:1,
          normal:[bn[0]+v(s.n,0),bn[1]+v(s.n,1),1],
          offset:[bo[0]+v(s.o,0),bo[1]+v(s.o,1),bo[2]+v(s.o,2)],
          scale:(b.scale||1.08)*(Number.isFinite(s.s)?s.s:1),
          ringTurn:s.rt||[0,0,0],headTurn:s.ht||[0,0,0]});
        r.setFx?.({eye:s.eye,glow:s.glow,spin:s.spin});
        if(s.look)r.lookAt(s.look[0],s.look[1],.5);
        if(p===1)reset();
        update(dt);return;
      }
      if(k==='spin'){
        // 做好了：整顆轉一圈、跳一下，環亮一點（緩進緩出，轉完剛好回正面）
        const e=p<.5?2*p*p:1-Math.pow(-2*p+2,2)/2, up=Math.sin(Math.PI*p);
        r.setPose({...b,shape:0,headScale:1+up*.06,head:[bh[0]-up*.08,bh[1]+e*Math.PI*2,bh[2]],headOffset:[0,up*.12,0],normal:[bn[0],bn[1]+up*.15,1],offset:[bo[0],bo[1]+up*.1,bo[2]]});
        if(p===1)reset();
        update(dt);return;
      }
      if(k==='nod'||k==='bounce'||k==='shy'||k==='peek'||k==='shake'){
        const two=Math.sin(Math.PI*p*4)*a;   // 來回兩次
        let pose;
        if(k==='nod')pose={headScale:1+a*.02,head:[bh[0]+Math.max(0,two)*.34+a*.05,bh[1],bh[2]],headOffset:[0,-Math.max(0,two)*.03,0],normal:[bn[0],bn[1]+a*.05,1],offset:bo};
        else if(k==='shake')pose={headScale:1,head:[bh[0]+a*.06,bh[1]+two*.36,bh[2]],headOffset:[two*.02,0,0],normal:[bn[0]+two*.07,bn[1],1],offset:bo};
        else if(k==='bounce'){const up=Math.abs(Math.sin(Math.PI*p*2))*(1-p*.45);pose={headScale:1+up*.05,head:[bh[0]-up*.1,bh[1],bh[2]+w*.05],headOffset:[0,up*.16,0],normal:[bn[0],bn[1]+up*.2,1],offset:[bo[0],bo[1]+up*.14,bo[2]]};}
        else if(k==='shy')pose={headScale:1-a*.06,head:[bh[0]+a*.22,bh[1]+a*d*.55,bh[2]+a*d*.1],headOffset:[a*d*.07,-a*.05,0],normal:[bn[0]-a*d*.2,bn[1]+a*.14,1],offset:[bo[0],bo[1]-a*.04,bo[2]]};
        else pose={headScale:1+a*.04,head:[bh[0]+a*.3,bh[1]+w*.12,bh[2]],headOffset:[0,-a*.09,a*.05],normal:[bn[0],bn[1]-a*.1,1],offset:[bo[0],bo[1]-a*.05,bo[2]]};
        r.setPose({...b,shape:0,...pose});
        if(p===1)reset();
        update(dt);return;
      }
      const pet=k==='pet',spin=k==='swipe',stretch=k==='stretch';
      r.setPose({...b,shape:0,headScale:1+a*(pet?.035:.055),
        head:[(b.head?.[0]||0)+w*(pet?.12:.06),(b.head?.[1]||0)+a*d*(spin?.62:.18),(b.head?.[2]||0)+a*d*(pet?.06:.16)],
        headOffset:[a*d*.045,a*(stretch?.13:.045),0],
        normal:[(b.normal?.[0]||0)+w*d*.18,(b.normal?.[1]||.2)+a*(stretch?.32:.08),1],
        offset:[0,(b.offset?.[1]||.12)+a*(stretch?.22:.06),b.offset?.[2]||.2]});
      if(p===1)reset();
    }
    update(dt);
  };
  return {react,
    // 表演到一半換樣子：不打斷，接著用新樣子當基準做完（寫字那個樣子例外，要馬上讓位）
    setPresentation(name){presentation=name;if(!active||name==='compose')reset();},
    setEnabled(value){enabled=!!value;next=clock+8+Math.random()*6;lastTouch=clock;if(!enabled)reset();},
    setReduced(value){reduced=!!value;if(reduced)reset();},
    look(x,y){if(enabled&&!reduced)r.lookAt(x,y,1.2);},   // 手機傾斜也會叫這個，所以不算「有人理牠」
    names:()=>SHOW_NAMES,
    /** 閒著時要不要自己動（預先算圖時關掉，動作全部照腳本）。 */
    setAuto(value){auto=!!value;},
    debug(){return {enabled,reduced,presentation,active:active?.kind||null,lastReaction,serial};},
  };
}
