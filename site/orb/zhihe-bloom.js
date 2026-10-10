import * as THREE from 'three';

// Optical glare from the finished, occluded HDR scene. Never blur the base
// image: thin runes retain their sharp core and hidden emitters cannot glow.
export function createZhiheBloom(renderer, width, height, {mobile=false}={}) {
  const stage = new THREE.Scene(), camera = new THREE.Camera();
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);stage.add(quad);
  const vertexShader = 'varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}';
  const down = new THREE.ShaderMaterial({
    vertexShader, depthTest:false,depthWrite:false,toneMapped:false,
    uniforms:{uMap:{value:null},uMask:{value:null},uStep:{value:new THREE.Vector2()},uExtract:{value:1},uThreshold:{value:.85},uKnee:{value:.55}},
    fragmentShader:`varying vec2 vUv;uniform sampler2D uMap,uMask;uniform vec2 uStep;
      uniform float uExtract,uThreshold,uKnee;
      vec3 sampleBright(vec2 uv){
        vec3 c=max(texture2D(uMap,uv).rgb,vec3(0.0));
        if(uExtract<.5)return c;
        float brightness=max(c.r,max(c.g,c.b));
        float soft=clamp(brightness-uThreshold+uKnee,0.0,2.0*uKnee);
        soft=soft*soft/(4.0*uKnee+.0001);
        // Pack three independent glare energies into RGB. One pyramid can now
        // blur all three without tripling passes or exceeding sampler limits.
        return texture2D(uMask,uv).rgb*max(brightness-uThreshold,soft);
      }
      void main(){
        vec3 sum=vec3(0.0);
        for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){
          float weight=(x==0?2.0:1.0)*(y==0?2.0:1.0);
          sum+=sampleBright(vUv+vec2(float(x),float(y))*uStep)*weight;
        }
        gl_FragColor=vec4(sum/16.0,1.0);
      }`,
  });
  const blur = new THREE.ShaderMaterial({
    vertexShader,depthTest:false,depthWrite:false,toneMapped:false,
    uniforms:{uMap:{value:null},uStep:{value:new THREE.Vector2()}},
    fragmentShader:`varying vec2 vUv;uniform sampler2D uMap;uniform vec2 uStep;
      void main(){
        vec3 c=texture2D(uMap,vUv).rgb*.2270270270;
        c+=(texture2D(uMap,vUv+uStep*1.3846153846).rgb+texture2D(uMap,vUv-uStep*1.3846153846).rgb)*.3162162162;
        c+=(texture2D(uMap,vUv+uStep*3.2307692308).rgb+texture2D(uMap,vUv-uStep*3.2307692308).rgb)*.0702702703;
        gl_FragColor=vec4(c,1.0);
      }`,
  });
  const levels=[];
  function resize(w,h){
    for(const level of levels){level.a.dispose();level.b.dispose();}levels.length=0;
    // Bound cost at large viewports; radius follows character size, not SSAA.
    const k=Math.min(1,(mobile?256:512)/Math.min(w,h),(mobile?512:1024)/Math.max(w,h));
    const radiusScale=Math.min(w,h)*k/512;
    for(let i=0;i<5;i++){
      const rw=Math.max(1,Math.round(w*k/Math.pow(2,i+1))),rh=Math.max(1,Math.round(h*k/Math.pow(2,i+1)));
      const make=()=>new THREE.WebGLRenderTarget(rw,rh,{type:THREE.HalfFloatType,depthBuffer:false,minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter});
      levels.push({a:make(),b:make(),w:rw,h:rh,radiusScale});
    }
  }
  resize(width,height);
  return {
    get textures(){return levels.map(l=>l.a.texture);},
    resize,
    render(source,mask){
      const previous=renderer.getRenderTarget();
      down.uniforms.uMask.value=mask;
      for(let i=0;i<levels.length;i++){
        const l=levels[i];quad.material=down;down.uniforms.uMap.value=i?levels[i-1].a.texture:source;
        down.uniforms.uStep.value.set(.5/l.w,.5/l.h);down.uniforms.uExtract.value=i===0?1:0;
        renderer.setRenderTarget(l.a);renderer.render(stage,camera);
        quad.material=blur;blur.uniforms.uMap.value=l.a.texture;blur.uniforms.uStep.value.set(l.radiusScale/l.w,0);
        renderer.setRenderTarget(l.b);renderer.render(stage,camera);
        blur.uniforms.uMap.value=l.b.texture;blur.uniforms.uStep.value.set(0,l.radiusScale/l.h);
        renderer.setRenderTarget(l.a);renderer.render(stage,camera);
      }
      renderer.setRenderTarget(previous);
    },
    dispose(){for(const l of levels){l.a.dispose();l.b.dispose();}quad.geometry.dispose();down.dispose();blur.dispose();},
  };
}
