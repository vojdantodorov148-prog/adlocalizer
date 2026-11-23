import type { Config } from '@netlify/functions';
import { assetLink, producer, validId, variants } from '../lib/packages';
import { botOwner } from '../lib/bot';
import { env, isAuthorized } from '../lib/core';
import { translateLayers } from '../../src/kie';
import { COUNTRIES } from '../../src/options';
export default async (req:Request) => {
  const auth=req.headers.get('authorization');
  const reply=(data:unknown,status=200)=>Response.json(data,{status,headers:{'cache-control':'no-store'}});
  if (req.method!=='POST') return reply({error:'Use POST'},405);
  if (!isAuthorized(auth,env('ADLOCALIZER_MCP_TOKEN')) && !await botOwner(auth)) return reply({error:'Enter a Localizer bot key'},401);
  try {
    const {job_id,output_id,action,market,source_sha256}=await req.json();
    if (!validId(job_id)) return reply({error:'Invalid job ID'},400);
    const images=await variants(job_id);
    if (action==='variants') return reply({images:images.map(i=>({...i,url:assetLink(i.url,'original')}))});
    if (!validId(output_id) || !images.some(i=>i.id===output_id)) return reply({error:'Output does not belong to this job'},404);
    if (!['get','prepare','translate'].includes(action)) return reply({error:'Unknown action'},400);
    const pkg=await producer(action==='prepare'?'prepare_for_localization':'get_localization_package',{job_id,output_id});
    const m=pkg.manifest;
    if (!m) return reply({status:pkg.status,reason:String(pkg.reason??pkg.error??'')});
    if (m.version!==1 || m.job_id!==job_id || m.output_id!==output_id || !m.source_sha256) throw Error('Package identity mismatch');
    if (action==='translate') {
      if (m.source_sha256!==source_sha256 || !COUNTRIES.includes(market)) return reply({error:'Review the current package and select a market'},409);
      return reply({texts:await translateLayers(m.blocks.filter((b:any)=>b.editable).map((b:any)=>({id:b.id,text:b.text})),market,env('KIE_API_KEY'))});
    }
    const assets:Record<string,string>={};
    for (const key of ['original','preview','base','font','license']) if (m.assets[key]) assets[key]=assetLink(m.assets[key],key);
    return reply({status:pkg.status,manifest:{...m,assets}});
  } catch (e) {
    const message=e instanceof Error?e.message:'';
    return reply({error:/^(Server configuration missing|Ad Creator|Package identity|Missing structured)/.test(message)?message:'Package request failed. Refresh and try again.'},502);
  }
};
export const config:Config={path:'/api/creator-package'};
