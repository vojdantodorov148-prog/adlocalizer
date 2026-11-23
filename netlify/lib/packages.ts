import { env, validateUrl } from './core';
import { createHmac, timingSafeEqual } from 'node:crypto';

export function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(value);
}
export async function producer(tool: string, args: Record<string,string>) {
  const response = await fetch('https://adcreatorpro.netlify.app/mcp', {
    method:'POST', redirect:'error', signal:AbortSignal.timeout(25000),
    headers:{authorization:'Bearer '+env('ADCREATOR_MCP_TOKEN'),'content-type':'application/json',accept:'application/json, text/event-stream'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:tool,arguments:args}})
  });
  if (!response.ok) throw Error('Ad Creator MCP HTTP '+response.status);
  const raw = await response.text();
  const data = response.headers.get('content-type')?.includes('text/event-stream')
    ? raw.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>JSON.parse(line.slice(5))).find(item=>item.id===1)
    : JSON.parse(raw);
  if (data?.error || data?.result?.isError) throw Error('Ad Creator rejected '+tool);
  if (!data?.result?.structuredContent) throw Error('Missing structured MCP result');
  return data.result.structuredContent;
}
export async function variants(job_id:string) {
  const raw = await producer('get_job',{job_id});
  const job = raw.job ?? raw;
  const images = job.images ?? job.results;
  if (!Array.isArray(images)) throw Error('Ad Creator returned no variants');
  return images.map((image:any) => ({id:image.id ?? image.image_id, url:image.url ?? image.image_url})).filter(image=>validId(image.id) && typeof image.url==='string');
}
const signature = (payload:string) => createHmac('sha256',env('ADLOCALIZER_MCP_TOKEN')).update('package-asset:'+payload).digest('hex');
export function assetLink(url:string,kind:string) {
  validateUrl(url,'producer asset');
  const payload = Buffer.from(JSON.stringify({url,kind,expires:Date.now()+30*60000})).toString('base64url');
  return '/creator-asset?p='+payload+'&s='+signature(payload);
}
export function readAsset(url:URL) {
  const p=url.searchParams.get('p')||'', s=url.searchParams.get('s')||'';
  if (!/^[a-f0-9]{64}$/.test(s) || !timingSafeEqual(Buffer.from(signature(p)),Buffer.from(s))) return null;
  const asset=JSON.parse(Buffer.from(p,'base64url').toString());
  return asset.expires>Date.now()?asset:null;
}
