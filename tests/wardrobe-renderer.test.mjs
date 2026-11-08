import test from 'node:test';
import assert from 'node:assert/strict';
import {createWardrobeRenderer} from '../src/wardrobe-renderer.ts';

class Element {
  constructor(document,tag){this.ownerDocument=document;this.tagName=tag;this.children=[];this.parentElement=null;this.attributes=new Map();this.dataset={};this.className='';this.scrollTop=0;this.scrollLeft=0;this.writes=[];this.moves=0;this.classList={toggle:(name,on)=>{const names=new Set(this.className.split(' ').filter(Boolean));on?names.add(name):names.delete(name);this.className=[...names].join(' ');}};}
  get firstElementChild(){return this.children[0]||null;}
  get nextElementSibling(){if(!this.parentElement)return null;const all=this.parentElement.children;return all[all.indexOf(this)+1]||null;}
  setAttribute(name,value){this.attributes.set(name,value);this.writes.push([name,value]);}
  getAttribute(name){return this.attributes.get(name)??null;}
  removeAttribute(name){this.attributes.delete(name);this.writes.push([name,null]);}
  append(node){this.insertBefore(node,null);}
  insertBefore(node,before){node.remove();const index=before?this.children.indexOf(before):this.children.length;assert(index>=0);this.children.splice(index,0,node);node.parentElement=this;this.moves++;}
  remove(){if(this.parentElement){const all=this.parentElement.children;all.splice(all.indexOf(this),1);this.parentElement=null;}}
}
function fixture(){const document={createElement:tag=>new Element(document,tag)};const panels={left:document.createElement('div'),right:document.createElement('div')};const picked=[];return {panels,picked,renderer:createWardrobeRenderer(panels,id=>picked.push(id))};}
const garment=(id,type='2d')=>({id,name:`Clothing ${id}`,imageUrl:`/image/${id}`,assetType:type,hasModel:type==='3d'});
const imageWrites=button=>button.children[0].writes.filter(([name])=>name==='src');
const rowOrder=panels=>panels.left.children.flatMap((button,i)=>[button,panels.right.children[i]].filter(Boolean));

for(const count of [19,20,0,1])test(`${count} garments are balanced between both sides without duplicates and keep row-wise ranking`,()=>{
  const {panels,renderer}=fixture(),items=Array.from({length:count},(_,i)=>garment(String(i),i<14?'3d':'2d'));renderer.sync(items,items[0]?.id);
  assert.equal(panels.left.children.length,Math.ceil(count/2));assert.equal(panels.right.children.length,Math.floor(count/2));
  const ids=rowOrder(panels).map(button=>button.dataset.garmentId);assert.deepEqual(ids,items.map(item=>item.id));assert.equal(new Set(ids).size,count);
  const nodes=rowOrder(panels),moves=Object.values(panels).map(p=>p.moves);
  renderer.sync(items.map(item=>({...item,assetType:item.assetType==='3d'?'2d':'3d',hasModel:!item.hasModel})),items[0]?.id);
  assert.deepEqual(rowOrder(panels),nodes);assert.deepEqual(Object.values(panels).map(p=>p.moves),moves);
});

test('selection preserves every card/image and both scroll positions without writing image sources',()=>{
  const {panels,renderer,picked}=fixture(),items=[garment('a','3d'),garment('b','3d'),garment('c'),garment('d')];renderer.sync(items,'a');
  const before=rowOrder(panels),images=before.map(b=>b.children[0]),moves=Object.values(panels).map(p=>p.moves);panels.left.scrollTop=180;panels.right.scrollTop=70;
  for(const id of ['b','d','c','a','d'])renderer.setSelected(id);
  before[1].onclick();assert.deepEqual(picked,['b']);assert.deepEqual(rowOrder(panels),before);assert.deepEqual(before.map(b=>b.children[0]),images);
  assert.deepEqual(before.map(imageWrites).map(w=>w.length),[1,1,1,1]);assert.deepEqual(Object.values(panels).map(p=>p.moves),moves);assert.equal(panels.left.scrollTop,180);assert.equal(panels.right.scrollTop,70);
  assert.equal(before.filter(b=>b.getAttribute('aria-pressed')==='true').length,1);assert.equal(before[3].getAttribute('aria-pressed'),'true');
});

test('unchanged API refresh retains mounted nodes and only refreshes changed metadata',()=>{
  const {panels,renderer}=fixture(),items=[garment('a'),garment('b')];renderer.sync(items,'a');const [a,b]=rowOrder(panels);const moves=Object.values(panels).map(p=>p.moves);
  renderer.sync(items.map(x=>({...x,name:x.id==='a'?'New name':x.name})),'b');
  assert.equal(panels.left.children[0],a);assert.equal(panels.right.children[0],b);assert.deepEqual(Object.values(panels).map(p=>p.moves),moves);assert.equal(a.getAttribute('aria-label'),'New name');assert.equal(imageWrites(a).length,1);assert.equal(imageWrites(b).length,1);
});

test('inserting a first-ranked upload and deleting it rebalances sides without replacing existing nodes',()=>{
  const {panels,renderer}=fixture(),items=Array.from({length:19},(_,i)=>garment(String(i),i<14?'3d':'2d'));renderer.sync(items,'0');
  const before=rowOrder(panels),images=before.map(b=>b.children[0]);panels.left.scrollTop=100;panels.right.scrollTop=70;
  renderer.sync([garment('upload'),...items],'upload');const uploaded=panels.left.children[0];assert.equal(panels.left.children.length,10);assert.equal(panels.right.children.length,10);
  assert.deepEqual(rowOrder(panels),[uploaded,...before]);assert.equal(before[0].parentElement,panels.right);assert.equal(before[1].parentElement,panels.left);assert.deepEqual(before.map(b=>b.children[0]),images);
  assert.equal(panels.left.scrollTop,100);assert.equal(panels.right.scrollTop,70);
  renderer.sync(items,'0');assert.deepEqual(rowOrder(panels),before);assert.equal(uploaded.parentElement,null);assert.equal(panels.left.children.length,10);assert.equal(panels.right.children.length,9);
  const reversed=[...items].reverse();renderer.sync(reversed,'0');assert.deepEqual(rowOrder(panels),[...before].reverse());assert(before.every(b=>imageWrites(b).length===1));
  renderer.sync([],null);assert.equal(panels.left.children.length,0);assert.equal(panels.right.children.length,0);assert(before.every(b=>b.parentElement===null));
});

test('only an actual image URL change writes src; absent image never becomes a null URL request',()=>{
  const {panels,renderer}=fixture();renderer.sync([garment('a'),{...garment('b'),imageUrl:null}],'a');const [a,b]=rowOrder(panels);assert.equal(b.children[0].getAttribute('src'),null);
  renderer.sync([{...garment('a'),imageUrl:'/image/a?v=2'},{...garment('b'),imageUrl:null}],'a');assert.equal(panels.left.children[0],a);assert.deepEqual(imageWrites(a),[['src','/image/a'],['src','/image/a?v=2']]);assert.equal(imageWrites(b).length,1);
  renderer.sync([{...garment('a'),imageUrl:'/image/a?v=2'},{...garment('b'),imageUrl:null}],'b');assert.equal(imageWrites(a).length,2);assert.equal(imageWrites(b).length,1);
});

test('cards prefer the lightweight thumbnail without changing the original reference mapping; failure falls back once',()=>{
  const {panels,renderer}=fixture(),item={...garment('a'),thumbnailUrl:'/thumbnail/a'};renderer.sync([item],'a');
  const button=panels.left.children[0],image=button.children[0];assert.equal(image.getAttribute('src'),'/thumbnail/a');assert.equal(item.imageUrl,'/image/a');
  renderer.setSelected(null);renderer.setSelected('a');renderer.sync([{...item}],'a');assert.equal(imageWrites(button).length,1);
  image.onerror();assert.equal(image.getAttribute('src'),'/image/a');image.onerror();renderer.sync([{...item}],'a');assert.equal(imageWrites(button).length,2);
  renderer.sync([{...item,thumbnailUrl:'/thumbnail/a?v=2'}],'a');assert.equal(image.getAttribute('src'),'/thumbnail/a?v=2');assert.equal(panels.left.children[0],button);
});
