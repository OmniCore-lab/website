import * as THREE from 'three';

// One space for placement; independent head and ring spaces beneath it.
// Breathing is additive here, never an overwrite of the caller's world pose.
export const PRESENTATIONS = {
  rest:    {normal:[-.06,.57,1], offset:[0,.10,.08], scale:1.03, head:[-.03,-.08,.02]},
  distant: {normal:[.12,.17,1], offset:[0,.16,.22], scale:1.08, head:[-.06,.17,-.05]},
  listen:  {normal:[-.06,.08,1],offset:[0,.18,.28], scale:1.09, head:[-.08,-.06,.035]},
  think:   {normal:[-.24,.32,1],offset:[.02,.20,.20],scale:1.10, head:[-.14,.18,-.07]},
  type:    {normal:[.06,.09,1], offset:[0,.18,.30], scale:1.10, head:[.04,-.17,.035]},
  compose: {normal:[.013,.041,1],offset:[0,-.37,.20],scale:.92,head:[-.08,-.16,-.06],headOffset:[.705,1.175,.25],headScale:.54,shape:1,protectEyes:false},
  result:  {normal:[-.12,.25,1],offset:[0,.16,.22], scale:1.12, head:[-.06,.05,-.04]},
  caution: {normal:[0,.10,1],  offset:[0,.18,.27], scale:1.10, head:[0,0,0]},
  night:   {normal:[.16,.42,1],offset:[0,.12,.17], scale:1.05, head:[.02,.10,-.025]},
};

export function createCharacterRig({root,parts,atmosphere=[],camera}) {
  const space=new THREE.Group(),head=new THREE.Group(),ringPivot=new THREE.Group(),glyphPivot=new THREE.Group();
  space.name='CharacterMotion';head.name='HeadPose';ringPivot.name='RingPose';glyphPivot.name='InlaySpin';
  root.add(space);space.add(head,ringPivot);ringPivot.add(glyphPivot);
  const ring=parts.get('Ring_GlassBody');
  ringPivot.position.copy(ring.getWorldPosition(new THREE.Vector3()));space.worldToLocal(ringPivot.position);
  const restCenter=ringPivot.position.clone();
  for(const [name,m] of parts) {
    if(name==='Ring_GlassBody'||name.startsWith('RingEdge_'))ringPivot.attach(m);
    else if(name.startsWith('Glyph_'))glyphPivot.attach(m);
    else if(!name.startsWith('GroundGlow_'))head.attach(m);
  }
  atmosphere.forEach(m=>head.attach(m));
  const axis=new THREE.Vector3(0,1,0).applyQuaternion(ring.quaternion).normalize();
  const target={normal:new THREE.Vector3(0,.1,1).normalize(),offset:new THREE.Vector3(0,.16,.2),scale:1.08,head:new THREE.Quaternion(),headOffset:new THREE.Vector3(),headScale:1,shape:0};
  const orientation=new THREE.Quaternion(),headGoal=new THREE.Quaternion(),spinQ=new THREE.Quaternion(),euler=new THREE.Euler();
  const alignment=new THREE.Quaternion(),inverse=new THREE.Matrix4(),view=new THREE.Vector3(),center=new THREE.Vector3();
  const basis=new THREE.Matrix4(),right=new THREE.Vector3(),depth=new THREE.Vector3(),upright=new THREE.Quaternion();
  const authoredInverse=ring.quaternion.clone().invert();
  // 表演用：疊在姿勢上面的直接旋轉（弧度，畫面座標的 x／y／z）。不經過 slerp，所以 0→2π 就是真的轉一整圈。
  const ringTurn=new THREE.Quaternion(),headTurn=new THREE.Quaternion(),headBase=new THREE.Quaternion();
  let shape=0,manual=false,guarded=false,followRate=4.8,composerEntry=false;
  const eyes=['Eye_0','Eye_1'].map(n=>parts.get(n));

  // Conservative hold-pose test. A transition may sweep past the eyes; a target
  // must leave the projected face clear. Include margins for eye glow and gaze.
  function obstructs(normal,offset,scale) {
    space.updateWorldMatrix(true,false);
    inverse.copy(space.matrixWorld).invert();
    camera.updateMatrixWorld();view.setFromMatrixColumn(camera.matrixWorld,2).transformDirection(inverse);
    const den=view.dot(normal);if(Math.abs(den)<.08)return true;
    center.copy(restCenter).add(offset);
    const headMatrix=new THREE.Matrix4().compose(target.headOffset,target.head,new THREE.Vector3().setScalar(target.headScale));
    for(const eye of eyes)for(const dx of [-.13,0,.13])for(const dy of [-.24,0,.24]) {
      const p=eye.position.clone().add(new THREE.Vector3(dx,dy,0)).applyMatrix4(headMatrix);
      const distance=center.clone().sub(p).dot(normal)/den;
      if(distance<0)continue;
      const radial=p.addScaledVector(view,distance).sub(center).length()/scale;
      if(radial>1.20&&radial<1.60)return true;
    }
    return false;
  }
  function setPose(p={},snap=false) {
    const array=(v,n)=>Array.isArray(v)&&v.length===n&&v.every(Number.isFinite);
    if(p.normal!==undefined&&!array(p.normal,3))throw new Error('normal must contain 3 finite numbers');
    if(p.offset!==undefined&&!array(p.offset,3))throw new Error('offset must contain 3 finite numbers');
    if(p.head!==undefined&&!array(p.head,3))throw new Error('head must contain 3 finite angles');
    if(p.headOffset!==undefined&&!array(p.headOffset,3))throw new Error('headOffset must contain 3 finite numbers');
    if(p.normal){if(Math.hypot(...p.normal)<1e-6)throw new Error('normal cannot be zero');target.normal.fromArray(p.normal).normalize();}
    if(p.offset)target.offset.fromArray(p.offset).clampScalar(-4,4);
    if(p.head)target.head.setFromEuler(euler.set(...p.head));
    if(p.headOffset)target.headOffset.fromArray(p.headOffset).clampScalar(-4,4);
    if(p.headScale!==undefined){if(!Number.isFinite(p.headScale))throw new Error('invalid headScale');target.headScale=THREE.MathUtils.clamp(p.headScale,.3,2);}
    if(p.scale!==undefined){if(!Number.isFinite(p.scale))throw new Error('invalid scale');target.scale=THREE.MathUtils.clamp(p.scale,.4,2.4);}
    if(p.shape!==undefined){if(!Number.isFinite(p.shape))throw new Error('invalid shape');target.shape=THREE.MathUtils.clamp(p.shape,0,1);}
    if(array(p.ringTurn,3))ringTurn.setFromEuler(euler.set(...p.ringTurn));else ringTurn.identity();
    if(array(p.headTurn,3))headTurn.setFromEuler(euler.set(...p.headTurn));else headTurn.identity();
    guarded=p.protectEyes!==false&&obstructs(target.normal,target.offset,target.scale);
    if(guarded){target.normal.set(0,.04,1).normalize();target.offset.set(0,.12,.25);target.scale=Math.max(1.1,target.scale);}
    if(snap)apply(1,0,0,1,0,0,0);
    return !guarded;
  }
  function apply(alpha,bodySpin,glyphSpin,breathe,bob,gazeX,gazeY) {
    space.scale.setScalar(breathe);space.position.y=bob;
    headGoal.copy(target.head).multiply(new THREE.Quaternion().setFromEuler(euler.set(-gazeY*.055,gazeX*.08,0)));
    headBase.slerp(headGoal,alpha);head.quaternion.copy(headBase).multiply(headTurn);
    head.position.lerp(target.headOffset,alpha);head.scale.lerp(new THREE.Vector3().setScalar(target.headScale),alpha);
    alignment.setFromUnitVectors(axis,target.normal);
    if(target.shape>0){
      right.crossVectors(new THREE.Vector3(0,1,0),target.normal);
      if(right.lengthSq()<.001)right.set(1,0,0);right.normalize();
      depth.crossVectors(right,target.normal).normalize();
      upright.setFromRotationMatrix(basis.makeBasis(right,target.normal,depth)).multiply(authoredInverse);
      alignment.slerp(upright,target.shape);
    }
    orientation.slerp(alignment,alpha);
    shape=THREE.MathUtils.lerp(shape,target.shape,alpha);
    // The plane and in-plane motion are separate. Stop body spin as the ring
    // becomes a frame; the engraved light can continue travelling along it.
    spinQ.setFromAxisAngle(axis,bodySpin*(1-shape));
    ringPivot.quaternion.copy(ringTurn).multiply(orientation).multiply(spinQ);
    // Preserve the earlier compact turn-and-separate gesture, then open the
    // extra writing room. Shape drives this phase, so rapid reversals retain
    // the current transform without a delayed timer firing after close.
    const unfold=composerEntry&&target.shape===1&&alpha<1
      ? THREE.MathUtils.smoothstep(shape,.80,1) : 1;
    const ringScale=THREE.MathUtils.lerp(.761,target.scale,unfold);
    center.copy(target.offset);center.y=THREE.MathUtils.lerp(-.582,target.offset.y,unfold);
    ringPivot.position.lerp(center.add(restCenter),alpha);
    ringPivot.scale.lerp(new THREE.Vector3().setScalar(ringScale),alpha);
    glyphPivot.setRotationFromAxisAngle(axis,glyphSpin-bodySpin*(1-shape));
    root.updateWorldMatrix(true,true);
  }
  // 兩個獨立的旋鈕，因為它們控制的是不同的事。
  //
  // poseGain（張力）：把每個姿勢的側傾與頭部角度整體放大或收斂 —— 動作的幅度。
  // ringTilt（扁平）：往環的法線 y 加一個固定偏移 —— 環相對鏡頭躺平的程度。
  //   法線指向鏡頭時環是一個正圓；y 越大法線越往上倒，環在畫面上就越扁。
  //   設定稿上的環是扁的，所以這裡預設會加一點。
  //
  // 兩者分開的理由：以前只有 poseGain，想把環壓扁就得同時放大頭部轉動，
  // 而且像 distant 這種本來 y 就小的姿勢乘再大也還是正圓 —— 乘法收斂到 0。
  // 用加法才壓得動每一個姿勢。
  //
  // compose（書寫）兩者都不套用，那個姿勢的幾何是精算過的，動到會歪掉。
  let poseGain=1,ringTilt=0,lastPresentation='rest';
  function scaled(name){
    const p=PRESENTATIONS[name]||PRESENTATIONS.rest;
    if((poseGain===1&&ringTilt===0)||name==='compose')return p;
    const out={...p};
    if(p.normal)out.normal=[p.normal[0]*poseGain,p.normal[1]*poseGain+ringTilt,1];
    if(p.head)out.head=p.head.map(v=>v*poseGain);
    return out;
  }
  function reapply(){
    if(!manual)setPose({shape:0,headOffset:[0,0,0],headScale:1,...scaled(lastPresentation)});
  }
  return {space,head,ringPivot,glyphPivot,
    setPose(p,snap=false){manual=true;composerEntry=false;followRate=Number.isFinite(p?.follow)?Math.min(30,Math.max(1,p.follow)):4.8;return setPose(p,snap);},
    /** 這個樣子現在實際的基準姿勢（已經套用張力與扁平）。表演從這裡出發、回到這裡，頭尾才不會跳。 */
    base(name){return scaled(name||lastPresentation);},
    setPoseGain(g){
      const v=Number(g);
      poseGain=Number.isFinite(v)?Math.min(2.6,Math.max(.2,v)):1;
      reapply();
    },
    setRingTilt(t){
      const v=Number(t);
      ringTilt=Number.isFinite(v)?Math.min(1.4,Math.max(-.4,v)):0;
      reapply();
    },
    setPresentation(name){manual=false;composerEntry=name==='compose';followRate=12;lastPresentation=name;setPose({shape:0,headOffset:[0,0,0],headScale:1,...scaled(name)});},
    update(dt,{bodySpin=0,glyphSpin=0,breathe=1,bob=0,gazeX=0,gazeY=0}={}){apply(1-Math.exp(-followRate*dt),bodySpin,glyphSpin,breathe,bob,gazeX,gazeY);},
    snap({bodySpin=0,glyphSpin=0}={}){apply(1,bodySpin,glyphSpin,1,0,0,0);},
    get shape(){return shape;},get bodySpinFactor(){return 1-shape;},
    debug(){return {manual,guarded,shape,head:head.quaternion.toArray(),ringNormal:new THREE.Vector3(0,1,0).transformDirection(ring.matrixWorld).toArray(),offset:ringPivot.position.toArray(),scale:ringPivot.scale.x};},
  };
}
