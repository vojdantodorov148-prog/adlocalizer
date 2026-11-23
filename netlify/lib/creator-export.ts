import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {initWasm, Resvg} from '@resvg/resvg-wasm';
import opentype from 'opentype.js';
import {drawLayer} from '../../src/localizerSvg.mjs';
import {assetStore, saveAsset, signedUrl, stateStore} from './core';
import {approvalKey,producer} from './packages';
import {COUNTRIES} from '../../src/options';

type Translation={market:string;texts:Record<string,string>};
type Layer={id:string;text:string;editable:boolean;z:number};
let wasm:Promise<void>|undefined;
async function bytes(url:string){
  const r=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(25000)});
  if(!r.ok)throw Error('Source asset unavailable. Retry to refresh the package.');
  return Buffer.from(await r.arrayBuffer());
}
export async function localizeCreator(owner:string,origin:string,job_id:string,output_id:string,translations:Translation[],sourceHash?:string){
  const ids={job_id,output_id};
  const review=new URL('/creator.html',origin);
  review.search=new URLSearchParams({...ids,prepare:'1'}).toString();
  let pkg=await producer('get_localization_package',ids);
  if(pkg.status==='not_prepared'){
    pkg=await producer('prepare_for_localization',ids);
    if(pkg.status==='needs_review') pkg=await producer('get_localization_package',ids);
  }
  const manifest=pkg.manifest;
  if(!manifest)return {status:pkg.status,reason:pkg.reason,review_url:review.href};
  if(manifest.version!==1 || manifest.job_id!==job_id || manifest.output_id!==output_id)throw Error('Unexpected producer package');
  const sha=manifest.source_sha256;
  const layers=(manifest.blocks as Layer[]).filter(b=>b.editable).sort((a,b)=>a.z-b.z);
  const info={review_url:review.href,source_sha256:sha,blocks:layers.map(({id,text})=>({id,text}))};
  if(!layers.length)return {status:'manual_edit_required',...info};
  if(!await stateStore().get(approvalKey(job_id,output_id,sha)))return {status:'needs_review',...info};
  if(!translations.length)return {status:'awaiting_translations',...info};
  if(sourceHash!==sha)throw Error('source_sha256: read the approved package before export');
  let art:Promise<[Buffer,opentype.Font]>|undefined;
  const results=[];
  for(const {market,texts} of translations){
    try{
      if(!COUNTRIES.includes(market))throw Error('Unknown market');
      if(Object.keys(texts).length!==layers.length || layers.some(b=>!Object.hasOwn(texts,b.id)||!texts[b.id].trim()))throw Error('Supply translated text for every editable block');
      const hash=createHash('sha256').update(JSON.stringify([1,job_id,output_id,sha,market,layers.map(b=>texts[b.id])])).digest('hex');
      const path=owner+'/creator/'+hash+'.png';
      if(!await assetStore().getMetadata(path)){
        art??=Promise.all([bytes(manifest.assets.base),bytes(manifest.assets.font).then(b=>opentype.parse(Uint8Array.from(b).buffer))]);
        const [base,font]=await art;
        const paths=layers.map(b=>drawLayer(b,font,texts[b.id])).join('');
        wasm??=readFile(resolve(process.env.LAMBDA_TASK_ROOT || process.cwd(),'node_modules/@resvg/resvg-wasm/index_bg.wasm')).then(initWasm);
        await wasm;
        const size='width="'+manifest.width+'" height="'+manifest.height+'"';
        const renderer=new Resvg('<svg xmlns="http://www.w3.org/2000/svg" '+size+'><image '+size+' href="data:image/png;base64,'+base.toString('base64')+'"/>'+paths+'</svg>');
        try{const image=renderer.render();try{await saveAsset(path,Buffer.from(image.asPng()),'image/png');}finally{image.free();}}finally{renderer.free();}
      }
      results.push({market,url:signedUrl(path)});
    }catch(e){results.push({market,error:e instanceof Error?e.message:'Export failed'});}
  }
  return {status:results.some(r=>r.error)?'needs_attention':'done',results,...info};
}
