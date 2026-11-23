import type { Config } from '@netlify/functions';
import { readAsset } from '../lib/packages';
export default async (req:Request) => {
  const asset=readAsset(new URL(req.url));
  if (!asset || req.method!=='GET') return new Response('Refresh the package',{status:403});
  const r=await fetch(asset.url,{redirect:'error',signal:AbortSignal.timeout(30000)});
  if (!r.ok) return new Response('Refresh the package',{status:410});
  return new Response(r.body,{headers:{'content-type':asset.kind==='font'?'font/ttf':asset.kind==='license'?'text/plain':'image/png','x-content-type-options':'nosniff','cache-control':'private, max-age=300','content-security-policy':"default-src 'none'; sandbox"}});
};
export const config:Config={path:'/creator-asset'};
