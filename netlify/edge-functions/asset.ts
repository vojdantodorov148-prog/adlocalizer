import { getStore } from '@netlify/blobs';

async function validSignature(path:string,expires:string,signature:string,secret:string):Promise<boolean> {
  if (!path || path.startsWith('/') || path.includes('..') || !/^\d{10}$/.test(expires) || Number(expires)<=Date.now()/1000 || !/^[a-f0-9]{64}$/.test(signature)) return false;
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const bytes=new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(`${path}\n${expires}`)));
  const expected=Array.from(bytes,(byte)=>byte.toString(16).padStart(2,'0')).join('');
  let different=0; for(let i=0;i<64;i++) different|=expected.charCodeAt(i)^signature.charCodeAt(i);
  return different===0;
}
export default async (request:Request) => {
  if(request.method!=='GET') return new Response('Method Not Allowed',{status:405});
  const url=new URL(request.url), path=url.searchParams.get('path')||'';
  const secret=Netlify.env.get('ADLOCALIZER_MCP_TOKEN');
  if(!secret || !await validSignature(path,url.searchParams.get('expires')||'',url.searchParams.get('sig')||'',secret)) return new Response('Invalid or expired URL',{status:403});
  const entry=await getStore({name:'ad-localizer-assets',consistency:'strong'}).getWithMetadata(path,{type:'stream'});
  if(!entry?.data) return new Response('File not found',{status:404});
  return new Response(entry.data as ReadableStream,{headers:{
    'Content-Type':String(entry.metadata?.contentType || 'application/octet-stream'),
    'Content-Disposition':`attachment; filename="${path.split('/').pop()?.replace(/[^a-zA-Z0-9._-]/g,'_') || 'download'}"`,
    'Cache-Control':'private, no-store', 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer',
  }});
};
export const config={path:'/asset'};
