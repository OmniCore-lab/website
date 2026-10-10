import * as THREE from 'three';

// A low-cost ownership buffer for the *visible* HDR image: R eyes/icons,
// G ring, B atmosphere. Geometry and transforms are shared with the real scene;
// there is no second, unoccluded image of the luminous runes.
export function createBloomMask(renderer, width, height, {mobile=false}={}) {
  const stage=new THREE.Scene(), copies=[], materials=[];
  stage.background=new THREE.Color(0,0,1);
  const target=new THREE.WebGLRenderTarget(1,1,{depthBuffer:true,samples:mobile?2:4});
  const add=(source,material)=>{
    const mesh=new THREE.Mesh(source.geometry,material);
    mesh.matrixAutoUpdate=false;mesh.frustumCulled=false;mesh.renderOrder=source.renderOrder;
    stage.add(mesh);copies.push({source,mesh});materials.push(material);
  };
  function resize(w,h){const scale=Math.min(1,(mobile?512:1024)/Math.max(w,h));target.setSize(Math.max(1,Math.round(w*scale)),Math.max(1,Math.round(h*scale)));}
  resize(width,height);
  return {
    texture:target.texture,resize,
    setParts(parts,icon){
      for (const [name,source] of parts) {
        if (source.userData.depthOnly) {
          add(source,new THREE.MeshBasicMaterial({colorWrite:false,side:source.material.side}));
        } else if (name.startsWith('Eye_') || name.startsWith('EyeSocket')) {
          add(source,new THREE.MeshBasicMaterial({color:0xff0000,toneMapped:false,side:source.material.side}));
        } else if (name==='Ring_GlassBody') {
          // Reuse its sphere-occlusion test, including the current orbit/pivot.
          const material=source.material.clone();material.uniforms=source.material.uniforms;
          material.fragmentShader=material.fragmentShader.replace('float F=dielectric', 'gl_FragColor=vec4(0.0,1.0,0.0,1.0);return;float F=dielectric');
          add(source,material);
        }
      }
      if (icon) {
        const material=icon.material.clone();material.uniforms=icon.material.uniforms;
        material.fragmentShader=material.fragmentShader.replace('vec4(colour, alpha)', 'vec4(1.0,0.0,0.0,alpha)');
        add(icon,material);
      }
    },
    render(camera){
      for (const {source,mesh} of copies) {
        source.updateWorldMatrix(true,false);mesh.matrix.copy(source.matrixWorld);
        mesh.visible=source.visible;
        for(let p=source.parent;p && mesh.visible;p=p.parent)mesh.visible=p.visible;
      }
      const previous=renderer.getRenderTarget();
      renderer.setRenderTarget(target);renderer.render(stage,camera);renderer.setRenderTarget(previous);
    },
    dispose(){target.dispose();materials.forEach(m=>m.dispose());copies.length=0;stage.clear();},
  };
}
