import { COUNTRIES } from './options';
import { loadArt, renderArt } from './package-render.mjs';

const el=id=>document.getElementById(id);
const params=new URLSearchParams(location.search);
el('job').value=params.get('job_id')||'';
for(const name of COUNTRIES) el('market').add(new Option(name,name));
el('market').value='North Macedonia';
let version=0, revision=0, job='', output='', manifest, art, storage, draft, canvas;
const notice=text=>el('status').textContent=text;
async function call(action,extra={}) {
  const r=await fetch('/api/creator-package',{method:'POST',headers:{authorization:'Bearer '+el('token').value.trim(),'content-type':'application/json'},body:JSON.stringify({action,job_id:job,output_id:output,...extra})});
  const data=await r.json(); if(!r.ok) throw Error(data.error||'Request failed');return data;
}
function reset(){
  version++;revision++;canvas=null;manifest=null;
  for(const id of ['review','prepare','approval','editor'])el(id).hidden=true;
  el('preview').removeAttribute('src');el('save').disabled=true;
  return version;
}
async function openJob(explicit){
  const v=reset();job=el('job').value.trim();output='';el('variants').replaceChildren();notice('Се вчитуваат креативите…');
  const {images}=await call('variants');if(v!==version)return;
  if(explicit && !images.some(i=>i.id===explicit))throw Error('Избраниот output_id не припаѓа на оваа задача.');
  for(const image of images){
    const b=document.createElement('button'), img=new Image();img.src=image.url;img.alt='';b.append(img,image.id);
    b.onclick=()=>safe(()=>select(image));el('variants').append(b);
  }
  if(explicit||images.length===1)await select(images.find(i=>i.id===explicit)||images[0]);
  else notice(images.length?'Избери креатива.':'Нема креативи.');
}
async function select(image){
  const v=reset();output=image.id;
  history.replaceState(null,'','?'+new URLSearchParams({job_id:job,output_id:output}));
  el('original').src=image.url;el('review').hidden=false;
  await readPackage(v,'get');
}
async function readPackage(v,action){
  el('prepare').hidden=true;notice('Се вчитува пакетот…');
  let delay=1500;
  while(v===version){
    const data=await call(action);if(v!==version)return;
    if(data.status==='queued'||data.status==='running'){
      notice('Подготовката е во тек…');await new Promise(r=>setTimeout(r,delay));delay=Math.min(15000,delay*1.7);action='get';continue;
    }
    if(data.status==='not_prepared'||data.status==='failed'){
      el('prepare').hidden=false;notice(data.reason|| (data.status==='failed'?'Подготовката не успеа. Обиди се повторно.':'Оваа креатива чека подготовка.'));return;
    }
    const m=data.manifest;if(!m)throw Error('Недостасува манифест за преглед.');
    el('original').src=m.assets.original;el('preview').src=m.assets.preview;el('base').src=m.assets.base;
    const [loaded]=await Promise.all([loadArt(m),el('original').decode(),el('preview').decode()]);if(v!==version)return;
    manifest=m;art=loaded;storage='creator:'+JSON.stringify([job,output,m.source_sha256]);draft=JSON.parse(localStorage.getItem(storage)||'{"approved":false,"texts":{}}');
    el('notes').textContent=[...(m.reasons||[]),...m.blocks.filter(b=>!b.editable).map(b=>b.text+' — '+b.reason)].join('\n');
    el('approval').hidden=false;el('approve').disabled=draft.approved;notice(draft.approved?'Реконструкцијата е одобрена.':'Спореди ги двете слики пред да одобриш.');
    if(draft.approved)await edit();return;
  }
}
function persist(){localStorage.setItem(storage,JSON.stringify(draft));}
async function edit(){
  el('editor').hidden=false;const lang=el('market').value, texts=draft.texts[lang]??={};
  el('fields').replaceChildren();
  for(const b of manifest.blocks.filter(b=>b.editable)){
    const label=document.createElement('label'),field=document.createElement('textarea'),error=document.createElement('small');
    label.append(b.id+' · '+b.text,field,error);error.className='issue';field.value=texts[b.id]??b.text;field.dataset.layer=b.id;
    field.oninput=()=>{texts[b.id]=field.value;persist();safe(draw);};el('fields').append(label);
  }
  await draw();
}
async function draw(){
  const r=++revision;el('save').disabled=true;
  const {canvas:next,errors}=await renderArt(manifest,art,draft.texts[el('market').value]);
  if(r!==revision)return;
  for(const field of el('fields').querySelectorAll('textarea')){
    const message=errors[field.dataset.layer]||'';field.nextElementSibling.textContent=message;field.setAttribute('aria-invalid',String(Boolean(message)));
  }
  el('drawing').replaceChildren(next);canvas=next;el('save').disabled=Object.keys(errors).length>0;
}
async function safe(fn){const before=version;try{await fn();}catch(e){if(version<=before+1)notice(e.message);}}
el('lookup').onsubmit=e=>{e.preventDefault();const p=new URLSearchParams(location.search);safe(()=>openJob(el('job').value.trim()===p.get('job_id')?p.get('output_id'):null));};
el('approve').onclick=()=>safe(async()=>{draft.approved=true;persist();el('approve').disabled=true;notice('Реконструкцијата е одобрена.');await edit();});
el('prepare').onclick=()=>safe(()=>readPackage(++version,'prepare'));
el('refresh').onclick=()=>safe(()=>openJob(output));
el('market').onchange=()=>safe(edit);
el('translate').onclick=()=>safe(async()=>{
  const v=version,r=revision,market=el('market').value;el('translate').disabled=true;notice('Се преведува текстот…');
  try{const data=await call('translate',{market,source_sha256:manifest.source_sha256});if(v!==version||r!==revision)return;
  draft.texts[market]=data.texts;persist();await edit();notice('Провери го преводот пред извоз.');}finally{el('translate').disabled=false;}
});
el('save').onclick=()=>{const a=document.createElement('a');a.download=output+'-'+el('market').value+'.png';canvas.toBlob(blob=>{a.href=URL.createObjectURL(blob);a.click();setTimeout(()=>URL.revokeObjectURL(a.href),60000);});};
