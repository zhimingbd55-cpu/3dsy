import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';

export async function showModel(container:HTMLElement,url:string){
  const renderer=new THREE.WebGLRenderer({antialias:true,alpha:false,preserveDrawingBuffer:true});
  renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.setClearColor(0xf6f5f1);renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.1;
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(32,1,.01,1000);
  scene.add(new THREE.HemisphereLight(0xffffff,0xb5b1a9,2.7));
  const key=new THREE.DirectionalLight(0xffffff,3.2);key.position.set(3,5,6);scene.add(key);const fill=new THREE.DirectionalLight(0xffffff,1.4);fill.position.set(-4,2,-3);scene.add(fill);
  const controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=true;
  container.replaceChildren(renderer.domElement);
  const gltf=await new GLTFLoader().loadAsync(url);scene.add(gltf.scene);
  const box=new THREE.Box3().setFromObject(gltf.scene),size=box.getSize(new THREE.Vector3()),center=box.getCenter(new THREE.Vector3());
  if(!Number.isFinite(size.length())||size.length()===0)throw new Error('模型尺寸无效。');
  const aspect=container.clientWidth/Math.max(1,container.clientHeight);
  const distance=Math.max(size.y,size.x/Math.min(aspect,2/3))/(2*Math.tan(THREE.MathUtils.degToRad(16)))*1.15+size.z/2;
  camera.position.set(center.x,center.y,center.z+distance);controls.target.copy(center);controls.update();
  const resize=()=>{const width=container.clientWidth,height=container.clientHeight;renderer.setSize(width,height,false);camera.aspect=width/height;camera.updateProjectionMatrix();};
  const observer=new ResizeObserver(resize);observer.observe(container);resize();
  let disposed=false,frame=0;
  const draw=()=>{if(disposed)return;controls.update();renderer.render(scene,camera);frame=requestAnimationFrame(draw);};draw();
  return {
    capture:async()=>{
      const oldSize=renderer.getSize(new THREE.Vector2()),oldAspect=camera.aspect,oldRatio=renderer.getPixelRatio();
      renderer.setPixelRatio(1);renderer.setSize(1024,1536,false);camera.aspect=2/3;camera.updateProjectionMatrix();renderer.render(scene,camera);
      const blob=await new Promise<Blob>((resolve,reject)=>renderer.domElement.toBlob(value=>value?resolve(value):reject(new Error('参考图生成失败。')),'image/png'));
      renderer.setPixelRatio(oldRatio);renderer.setSize(oldSize.x,oldSize.y,false);camera.aspect=oldAspect;camera.updateProjectionMatrix();return blob;
    },
    dispose:()=>{disposed=true;cancelAnimationFrame(frame);observer.disconnect();controls.dispose();gltf.scene.traverse(object=>{if(object instanceof THREE.Mesh){object.geometry.dispose();for(const material of Array.isArray(object.material)?object.material:[object.material]){for(const value of Object.values(material))if(value instanceof THREE.Texture)value.dispose();material.dispose();}}});renderer.dispose();renderer.forceContextLoss();container.replaceChildren();}
  };
}
