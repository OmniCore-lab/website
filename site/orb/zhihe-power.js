// One owner for frame scheduling. A timer sleeps between frames; rAF only
// aligns the actual draw to presentation. Hidden/offscreen scenes do no work.
export function createPowerLoop({mobile=false,showcase=false,render,state=()=> 'idle',onPolicy=()=>{},clock=()=>performance.now(),raf=requestAnimationFrame,caf=cancelAnimationFrame,timer=setTimeout,untimer=clearTimeout}) {
  let running=false,suspended=false,disposed=false,frameId=null,timerId=null;
  let last=clock(),due=last,boostUntil=last+2500,policyKey='',sampleAt=last,sampleFrames=0,lastFps=0;
  const stats={frames:0,fps:0,targetFps:0,mode:'paused',submitMs:0};
  function policy(now){
    const s=state(),interactive=now<boostUntil;
    const active=interactive||(s!=='idle'&&s!=='sleep');
    return {fps:!mobile?0:active?30:s==='sleep'?(showcase?10:5):showcase?30:10,
      mode:active?'interactive':s==='sleep'?'sleep':'idle',
      video:!mobile||(s!=='sleep'&&(showcase||active))};
  }
  function clear(){if(frameId!==null)caf(frameId);if(timerId!==null)untimer(timerId);frameId=timerId=null;}
  // Mobile, below 30 fps: draw straight from the timer instead of going through rAF.
  // Each rAF makes the WebView's begin-frame source subscribe to every vsync for a
  // while, so a 15 fps scene still woke the app's main thread ~60 times a second
  // (Note 9, 2026-10-01: 58 Choreographer callbacks/s, only 16 of them drew).
  // The canvas change is picked up at the next vsync, which is plenty at 5-15 fps.
  function queue(){
    if(!running||suspended||disposed)return;
    const delay=mobile?Math.max(0,due-clock()-6):0;
    const slow=mobile&&lastFps>0&&lastFps<30;
    if(slow)timerId=timer(()=>{timerId=null;tick();},Math.max(0,delay));
    else if(delay>0)timerId=timer(()=>{timerId=null;frameId=raf(tick);},delay);
    else frameId=raf(tick);
  }
  function tick(){
    frameId=null;if(!running||suspended||disposed)return;
    const now=clock(),p=policy(now);
    if(mobile&&now+1<due){queue();return;}
    const key=`${p.mode}:${p.video}`;
    if(key!==policyKey){policyKey=key;onPolicy(p);}
    // Normal low-rate frames keep real elapsed time. Resume resets last, so
    // returning after a minute never advances a minute of animation at once.
    const dt=Math.min(Math.max(0,(now-last)/1000),.25);last=now;
    stats.mode=p.mode;stats.targetFps=p.fps;lastFps=p.fps;
    try{render(dt);stats.frames++;sampleFrames++;stats.submitMs=clock()-now;
      if(now-sampleAt>=1000){stats.fps=sampleFrames*1000/(now-sampleAt);sampleAt=now;sampleFrames=0;}
    }finally{
      const interval=p.fps?1000/p.fps:0;
      due=interval?Math.max(due+interval,clock()+Math.min(4,interval)):clock();queue();
    }
  }
  function start(){if(disposed||running)return;running=true;last=due=sampleAt=clock();sampleFrames=0;queue();}
  function suspend(value){
    value=!!value;if(value===suspended)return;suspended=value;clear();policyKey='';
    last=due=sampleAt=clock();sampleFrames=0;stats.fps=0;
    if(value){stats.targetFps=0;stats.mode='paused';onPolicy({mode:'paused',fps:0,video:false});}
    else queue();
  }
  return {start,suspend,stats,
    wake(){if(disposed)return;const now=clock(),wasBoosted=now<boostUntil;boostUntil=now+2500;
      // Pointermove/input can arrive at 120 Hz; they extend the boost without
      // pulling each deadline forward and accidentally defeating the 30 cap.
      if(!wasBoosted&&stats.mode!=='interactive'){due=now;clear();queue();}},
    dispose(){disposed=true;running=false;clear();stats.mode='disposed';stats.targetFps=stats.fps=0;},
  };
}
