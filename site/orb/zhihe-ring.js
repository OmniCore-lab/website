import * as THREE from 'three';

// This atlas stores the authored emitters, NOT a rendered view of the glass.
// Their apparent positions are reconstructed by a refracted ray at runtime.
function bakeEmitters(renderer, ring, parts) {
  ring.updateWorldMatrix(true, false);
  const inverse = ring.matrixWorld.clone().invert();
  const positions = [], colours = [];
  const point = new THREE.Vector3();
  for (const [name, mesh] of parts) {
    if (!name.startsWith('Glyph_') && !name.startsWith('RingEdge_')) continue;
    mesh.updateWorldMatrix(true, false);
    const transform = new THREE.Matrix4().multiplyMatrices(inverse, mesh.matrixWorld);
    const p = mesh.geometry.attributes.position, index = mesh.geometry.index;
    // GLTFLoader sanitises dots in node names (1.314 becomes 1314). Classify
    // rails by their actual radius in ring space, never by that display name.
    let radius=0;
    if (name.startsWith('RingEdge_')) {
      for(let i=0;i<p.count;i++) {
        point.fromBufferAttribute(p,i).applyMatrix4(transform);
        radius+=Math.hypot(point.x,point.z);
      }
      radius/=p.count;
    }
    const colour = name.startsWith('Glyph_') ? new THREE.Color(1,0,0)
      : radius < 1.4 ? new THREE.Color(0,1,0) : new THREE.Color(0,0,1);
    const count = index ? index.count : p.count;
    for (let i = 0; i < count; i += 3) {
      const uv = [];
      for (let j = 0; j < 3; j++) {
        point.fromBufferAttribute(p, index ? index.getX(i + j) : i + j).applyMatrix4(transform);
        uv.push([Math.atan2(point.z, point.x) / (Math.PI * 2) + .5,
          (Math.hypot(point.x, point.z) - 1.28) / .24]);
      }
      const seam = Math.max(...uv.map(p => p[0])) - Math.min(...uv.map(p => p[0])) > .5;
      if (seam) uv.forEach(p => { if (p[0] < .5) p[0] += 1; });
      for (const shift of seam ? [0, -1] : [0]) {
        for (const [u, v] of uv) {
          positions.push((u + shift) * 2 - 1, v * 2 - 1, 0);
          colours.push(colour.r, colour.g, colour.b);
        }
      }
    }
    // The ray samples these emitters exactly once through the band. Keep the
    // source meshes for animation/API purposes, but don't draw a second image.
    mesh.visible = false;
    mesh.userData.opticalInlay = true;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('radiance', new THREE.Float32BufferAttribute(colours, 3));
  const material = new THREE.ShaderMaterial({
    vertexShader: 'attribute vec3 radiance; varying vec3 e; void main(){e=radiance;gl_Position=vec4(position,1.0);}',
    fragmentShader: 'varying vec3 e; void main(){gl_FragColor=vec4(e,1.0);}',
    side: THREE.DoubleSide, depthTest: false, depthWrite: false, toneMapped: false,
  });
  const stage = new THREE.Scene();
  stage.add(new THREE.Mesh(geometry, material));
  const target = new THREE.WebGLRenderTarget(4096, 256, {
    type: THREE.HalfFloatType, depthBuffer: false,
    minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
    generateMipmaps: true, wrapS: THREE.RepeatWrapping, wrapT: THREE.ClampToEdgeWrapping,
  });
  const previous = renderer.getRenderTarget();
  const clear = renderer.getClearColor(new THREE.Color()), alpha = renderer.getClearAlpha();
  renderer.setRenderTarget(target); renderer.setClearColor(0, 0); renderer.clear();
  renderer.render(stage, new THREE.Camera());
  renderer.setRenderTarget(previous); renderer.setClearColor(clear, alpha);
  geometry.dispose(); material.dispose();
  return target;
}

export function createRingOptics({renderer, ring, parts, backdrop, gain = 1, emissionGain = 1}) {
  const atlas = bakeEmitters(renderer, ring, parts);
  // Arc length, not raw polar angle, makes the engraved light travel at an
  // even speed as the circle becomes a rounded square. Rows are shape values.
  const arcW=512,arcH=33,arcData=new Float32Array(arcW*arcH*4);
  for(let row=0;row<arcH;row++){
    const exponent=2+2*row/(arcH-1),lengths=[0];let total=0;
    const point=a=>{const c=Math.cos(a),s=Math.sin(a),f=Math.pow(Math.pow(Math.abs(c),exponent)+Math.pow(Math.abs(s),exponent),-1/exponent);return [c*f,s*f];};
    let previous=point(-Math.PI);
    for(let col=1;col<arcW;col++){const p=point(-Math.PI+2*Math.PI*col/(arcW-1));total+=Math.hypot(p[0]-previous[0],p[1]-previous[1]);lengths.push(total);previous=p;}
    for(let col=0;col<arcW;col++){const i=(row*arcW+col)*4;arcData[i]=lengths[col]/total;arcData[i+3]=1;}
  }
  // Mali（Note 9 等）沒有 OES_texture_float_linear：32 位元浮點貼圖配線性過濾會變成「不完整貼圖」、取樣全黑，光環就壞了。
  // 這時改用半精度（WebGL2 的半精度一定能線性過濾；弧長 0..1 用半精度的誤差約 1/2048，看不出來）。
  const floatLinear=renderer.extensions.has('OES_texture_float_linear');
  const arcMap=floatLinear?new THREE.DataTexture(arcData,arcW,arcH,THREE.RGBAFormat,THREE.FloatType)
    :new THREE.DataTexture(Uint16Array.from(arcData,v=>THREE.DataUtils.toHalfFloat(v)),arcW,arcH,THREE.RGBAFormat,THREE.HalfFloatType);
  arcMap.minFilter=arcMap.magFilter=THREE.LinearFilter;arcMap.needsUpdate=true;
  const uniforms = {
    uShape:{value:0},uDaylight:{value:0},uArcMap:{value:arcMap},
    uInlays: {value: atlas.texture}, uBackdrop: {value: backdrop},
    uViewLocal: {value: new THREE.Vector3()}, uLocalToWorld: {value: new THREE.Matrix4()},
    uResolution: {value: new THREE.Vector2()}, uScreenRight: {value: new THREE.Vector3()},
    uScreenUp: {value: new THREE.Vector3()}, uOrthoSize: {value: new THREE.Vector2()},
    uBallCenter: {value: new THREE.Vector3()}, uBallRadius: {value: 1},
    uInlaySpin: {value: 0}, uGlow: {value: 1}, uRefract: {value: 1},
    uLightPos: {value: Array.from({length:5},()=>new THREE.Vector3())},
    uLightCol: {value: Array.from({length:5},()=>new THREE.Color())},
    uLightArea: {value: new Float32Array(5)}, uLightNormal: {value: Array.from({length:5},()=>new THREE.Vector3())},
    uLightRight: {value: Array.from({length:5},()=>new THREE.Vector3())},
    uLightUp: {value: Array.from({length:5},()=>new THREE.Vector3())},
    uLightSize: {value: Array.from({length:5},()=>new THREE.Vector2())},
    uLightSpecular: {value: new Float32Array(5)},
    uGain: {value: gain},
    uEmissionGain: {value: emissionGain},
    uGlyphGain: {value: 1}, uInnerGain: {value: 1}, uOuterGain: {value: 1},
    uInnerWidth: {value: 1}, uOuterWidth: {value: 1},
    uBodyGain: {value: 1}, uTransmission: {value: 1}, uScatterGain: {value: 1}, uInternalReflection: {value: 1},
    uMode: {value: 0},
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: `varying vec3 p; varying vec3 n; varying vec3 w;
      uniform float uShape;
      vec3 deform(vec3 q){float exponent=2.0+2.0*uShape;float r=length(q.xz);vec2 unit=q.xz/max(r,.00001);float f=pow(pow(abs(unit.x),exponent)+pow(abs(unit.y),exponent),-1.0/exponent);float width=mix(1.0,.48,uShape);float radius=1.4+(r-1.4)*width;return vec3(unit.x*radius*f,q.y*width,unit.y*radius*f);}
      void main(){
        p=deform(position);
        vec3 tangent=normalize(cross(normal,abs(normal.y)<.9?vec3(0,1,0):vec3(1,0,0)));
        vec3 bitangent=cross(normal,tangent);
        n=normalize(cross(deform(position+tangent*.0005)-p,deform(position+bitangent*.0005)-p));
        vec4 world=modelMatrix*vec4(p,1.0);w=world.xyz;gl_Position=projectionMatrix*viewMatrix*world;
      }`,
    fragmentShader: `
      uniform sampler2D uInlays,uBackdrop;
      uniform sampler2D uArcMap;uniform float uShape,uDaylight;
      uniform vec3 uViewLocal,uScreenRight,uScreenUp,uBallCenter;
      uniform mat4 uLocalToWorld;
      uniform vec2 uResolution,uOrthoSize;
      uniform float uInlaySpin,uGlow,uBallRadius,uGain,uMode,uEmissionGain;
      uniform float uGlyphGain,uInnerGain,uOuterGain,uInnerWidth,uOuterWidth;
      uniform float uBodyGain,uTransmission,uScatterGain,uInternalReflection;
      uniform vec3 uLightPos[5],uLightCol[5],uLightNormal[5];
      uniform vec3 uLightRight[5],uLightUp[5];uniform vec2 uLightSize[5];
      uniform float uLightArea[5],uLightSpecular[5];
      varying vec3 p,n,w;
      const float PI=3.141592653589793;
      float bandRadius(vec3 q){float exponent=2.0+2.0*uShape;float r=pow(pow(abs(q.x),exponent)+pow(abs(q.z),exponent),1.0/exponent);return 1.4+(r-1.4)/mix(1.0,.48,uShape);}
      vec2 atlasUV(vec3 q){float angle=atan(q.z,q.x)/(2.0*PI)+.5;float arc=texture2D(uArcMap,vec2((angle*511.0+.5)/512.0,(uShape*32.0+.5)/33.0)).r;return vec2(fract(arc+uInlaySpin/(2.0*PI)),(bandRadius(q)-1.28)/.24);}
      vec4 inlays(vec2 uv,float bias){
        float glyph=texture2D(uInlays,uv,bias).r;
        float innerV=(uv.y-(.034/.24))/max(uInnerWidth,.001)+(.034/.24);
        float outerV=(uv.y-(.206/.24))/max(uOuterWidth,.001)+(.206/.24);
        float inner=texture2D(uInlays,vec2(uv.x,innerV),bias).g*step(.001,uInnerWidth);
        float outer=texture2D(uInlays,vec2(uv.x,outerV),bias).b*step(.001,uOuterWidth);
        vec3 light=vec3(1.0,.82,.45)*4.0*glyph*uGlyphGain
          +vec3(1.0,.66,.22)*3.0*(inner*uInnerGain+outer*uOuterGain);
        return vec4(light,clamp(glyph+inner+outer,0.0,1.0));
      }
      float halfThickness(float r){float x=clamp((r-1.28)/.24,0.0,1.0);return .5*(mix(.130,.056,x*x*(3.0-2.0*x))+.010*sin(PI*x));}
      float insideBand(vec3 q){float r=bandRadius(q);float width=mix(1.0,.48,uShape);return min(min(r-1.28,1.52-r)*width,halfThickness(r)*width-abs(q.y));}
      float dielectric(float c,float eta){float st2=eta*eta*(1.0-c*c);if(st2>=1.0)return 1.0;float ct=sqrt(1.0-st2);float rs=(eta*c-ct)/(eta*c+ct);float rp=(c-eta*ct)/(c+eta*ct);return .5*(rs*rs+rp*rp);}
      float exitDistance(vec3 origin,vec3 dir){
        float lo=.0002,hi=.05;
        for(int i=0;i<36;i++){if(insideBand(origin+dir*hi)<=0.0)break;lo=hi;hi+=.05;}
        for(int i=0;i<9;i++){float mid=(lo+hi)*.5;if(insideBand(origin+dir*mid)>0.0)lo=mid;else hi=mid;}
        return (lo+hi)*.5;
      }
      vec3 exitNormal(vec3 q){vec2 e=vec2(.0001,0.0);return -normalize(vec3(insideBand(q+e.xyy)-insideBand(q-e.xyy),insideBand(q+e.yxy)-insideBand(q-e.yxy),insideBand(q+e.yyx)-insideBand(q-e.yyx)));}
      void main(){
        vec3 V=normalize(uViewLocal),N=normalize(n);
        vec3 worldV=normalize(mat3(uLocalToWorld)*V);
        // Orthographic visibility: every ray is parallel, even off centre.
        vec3 ball=w-uBallCenter;float z=dot(ball,worldV),b2=dot(ball,ball)-z*z;
        if(b2<uBallRadius*uBallRadius && z<sqrt(max(0.0,uBallRadius*uBallRadius-b2)))discard;
        float F=dielectric(clamp(dot(N,V),0.0,1.0),1.0/1.24);
        vec3 D=refract(-V,N,1.0/1.24);
        // Follow the internal ray to the central emitter plane and the exit.
        // Binary search on the authored tapered cross-section keeps thickness
        // and side-wall exits dependent on the viewing direction.
        float travel=exitDistance(p,D);
        vec3 direct=vec3(0.0),origin=p,ray=D,throughput=vec3(.94*(1.0-F));
        float covered=0.0;
        for(int bounce=0;bounce<3;bounce++){
          float distanceIn=bounce==0?travel:exitDistance(origin,ray);
          float tPlane=abs(ray.y)>.0001?-origin.y/ray.y:-1.0;
          if(tPlane>=0.0&&tPlane<=distanceIn+.002){
            vec3 hit=origin+ray*tPlane;vec2 at=atlasUV(hit);
            vec4 emission=(at.y>=0.0&&at.y<=1.0)?inlays(at,0.0):vec4(0.0);
            direct+=emission.rgb*throughput*exp(-vec3(.35,.60,1.5)*tPlane)*uGlow*uEmissionGain;
            if(bounce==0)covered=emission.a;
            throughput*=1.0-emission.a;
          }
          vec3 end=origin+ray*distanceIn,normal=exitNormal(end);
          float internalF=dielectric(clamp(dot(ray,normal),0.0,1.0),1.24);
          throughput*=internalF*uInternalReflection*exp(-vec3(.35,.60,1.5)*distanceIn);
          ray=reflect(ray,normal);origin=end+ray*.0003;
        }
        // Smooth inlay irradiance supplies a local scattering approximation.
        // It contains no view-specific glyph image and therefore cannot ghost.
        vec2 uv=atlasUV(p);
        vec3 scatter=inlays(uv,5.0).rgb;
        vec3 worldN=normalize(mat3(uLocalToWorld)*N);
        vec3 diffuse=vec3(0.0),volume=vec3(0.0),reflected=vec3(0.0),R=reflect(-worldV,worldN);
        vec3 farN=normalize(mat3(uLocalToWorld)*exitNormal(p+D*travel));
        for(int i=0;i<5;i++){
          vec3 l=uLightPos[i]-w;float d2=dot(l,l);vec3 L=normalize(l);
          float solid=uLightArea[i]/(d2+uLightArea[i]*.25)*max(dot(-L,uLightNormal[i]),0.0);
          diffuse+=uLightCol[i]*solid*(max(dot(worldN,L),0.0)+.94*max(dot(farN,L),0.0))/PI;
          float phase=(1.0-.18*.18)/(4.0*PI*pow(1.0+.18*.18+2.0*.18*dot(L,worldV),1.5));
          volume+=uLightCol[i]*solid*phase;
          // Local rectangles, not a probe captured at the sphere's centre:
          // parallax matters for a band as wide as the light-source distances.
          float den=dot(R,uLightNormal[i]);
          float t=dot(l,uLightNormal[i])/min(den,-.00001);
          if(uLightSpecular[i]>0.0&&den<0.0&&t>0.0){
            vec3 hit=w+R*t-uLightPos[i];
            vec2 q=abs(vec2(dot(hit,uLightRight[i]),dot(hit,uLightUp[i])))-uLightSize[i]*.5;
            float blur=max(.015,t*.15*.15);
            float visible=(1.0-smoothstep(-blur,blur,q.x))*(1.0-smoothstep(-blur,blur,q.y));
            vec3 toBall=uBallCenter-w;float along=dot(toBall,R);
            if(along>0.0&&along<t&&dot(toBall,toBall)-along*along<uBallRadius*uBallRadius)visible=0.0;
            reflected+=uLightCol[i]*visible*F*uLightSpecular[i];
          }
        }
        vec3 tint=vec3(.88,.72,.34);
        vec3 body=diffuse*tint*.06*(1.0-F)*uBodyGain;
        body+=volume*vec3(1.0,.78,.32)*(.24*travel)*.94*(1.0-F)*uScatterGain;
        body+=scatter*(tint*.06*1.94+vec3(1.0,.78,.32)*(.24*travel))*uGlow*(1.0-F)*uEmissionGain*uScatterGain;
        body+=vec3(.18,.045,.006)*.08*uBodyGain;
        // Host room is outside the black render target: add missing ambient illumination.
        body+=vec3(.48,.29,.095)*uDaylight*(.45+.55*abs(dot(worldN,worldV)))*uBodyGain;
        vec3 transmit=tint*.94*(1.0-F)*exp(-vec3(.35,.60,1.5)*travel)*uTransmission;
        vec3 exitWorld=mat3(uLocalToWorld)*(D*travel);
        vec2 offset=vec2(dot(exitWorld,uScreenRight),dot(exitWorld,uScreenUp))/uOrthoSize;
        vec2 screen=gl_FragCoord.xy/uResolution;
        vec3 background=texture2D(uBackdrop,clamp(screen+offset,vec2(.001),vec2(.999))).rgb;
        // An emitter intercepts the ray; background must not shine through it.
        gl_FragColor=vec4((direct+reflected+body)*uGain+background*transmit*(1.0-covered),1.0);
        if(uMode==1.0)gl_FragColor=vec4(direct,1.0);
        if(uMode==2.0)gl_FragColor=vec4(reflected,1.0);
        if(uMode==3.0)gl_FragColor=vec4(body,1.0);
        if(uMode==4.0)gl_FragColor=vec4(background*transmit,1.0);
      }`,
    transparent: true, depthWrite: true, depthTest: true, side: THREE.FrontSide, toneMapped: false,
  });
  ring.material.dispose(); ring.material=material; ring.renderOrder=21;
  const inverse=new THREE.Matrix4(),V=new THREE.Vector3(),direction=new THREE.Vector3();
  return {
    material,atlas,
    update({camera,root,runtime,lights,width,height,backdrop,appearance}){
      uniforms.uShape.value=runtime?.rig?.shape || 0;
      if (appearance) {
        uniforms.uDaylight.value=appearance.daylight;
        uniforms.uEmissionGain.value=1;
        for (const [uniform,key] of Object.entries({uGlyphGain:'ringGlyph',uInnerGain:'ringInnerRail',uOuterGain:'ringOuterRail',uInnerWidth:'ringInnerWidth',uOuterWidth:'ringOuterWidth',uBodyGain:'ringBody',uTransmission:'ringTransmission',uScatterGain:'ringScatter',uInternalReflection:'ringReflection'})) uniforms[uniform].value=appearance[key];
      }
      ring.updateWorldMatrix(true,false);inverse.copy(ring.matrixWorld).invert();
      V.setFromMatrixColumn(camera.matrixWorld,2).normalize();
      uniforms.uViewLocal.value.copy(V).transformDirection(inverse);
      uniforms.uLocalToWorld.value.copy(ring.matrixWorld);
      uniforms.uScreenRight.value.setFromMatrixColumn(camera.matrixWorld,0);
      uniforms.uScreenUp.value.setFromMatrixColumn(camera.matrixWorld,1);
      uniforms.uOrthoSize.value.set(camera.right-camera.left,camera.top-camera.bottom);
      uniforms.uResolution.value.set(width,height);
      root.getWorldPosition(uniforms.uBallCenter.value);
      uniforms.uBallRadius.value=root.getWorldScale(direction).x*.982;
      uniforms.uInlaySpin.value=runtime ? runtime.spin-runtime.ringSpin : 0;
      uniforms.uGlow.value=runtime ? runtime.glow : 1;
      uniforms.uBackdrop.value=backdrop;
      lights.slice(0,5).forEach((l,i)=>{
        uniforms.uLightPos.value[i].copy(l.position);
        uniforms.uLightCol.value[i].copy(l.color).multiplyScalar(l.intensity);
        uniforms.uLightArea.value[i]=l.width*l.height;
        l.getWorldDirection(uniforms.uLightNormal.value[i]).negate();
        uniforms.uLightRight.value[i].setFromMatrixColumn(l.matrixWorld,0);
        uniforms.uLightUp.value[i].setFromMatrixColumn(l.matrixWorld,1);
        uniforms.uLightSize.value[i].set(l.width,l.height);
        uniforms.uLightSpecular.value[i]=l.userData.visibleGlossy===false?0:(l.userData.specularFactor ?? 0);
      });
    },
    dispose(){atlas.dispose();arcMap.dispose();material.dispose();},
  };
}
