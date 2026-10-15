import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { get as httpsGet } from 'node:https';
import { isIP } from 'node:net';
import { getStore } from '@netlify/blobs';

export const MONTH = 30 * 24 * 60 * 60 * 1000;
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_INLINE_BYTES = 4 * 1024 * 1024;
export const jobsStore = () => getStore({ name: 'ad-localizer-jobs', consistency: 'strong' });
export const stateStore = () => getStore({ name: 'ad-localizer-state', consistency: 'strong' });
export const assetStore = () => getStore({ name: 'ad-localizer-assets', consistency: 'strong' });
export const tokenId = (token: string) => createHash('sha256').update(token).digest('hex').slice(0, 32);

export function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Server configuration missing: ${name}`);
  return value;
}
export function isAuthorized(value: string | null, secret: string): boolean {
  const supplied = /^Bearer (\S+)$/i.exec(value || '')?.[1] || '';
  const a = Buffer.from(supplied), b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function signedUrl(path: string): string {
  const expires = String(Math.ceil((Date.now() + MONTH) / 1000));
  const sig = createHmac('sha256', env('ADLOCALIZER_MCP_TOKEN')).update(`${path}\n${expires}`).digest('hex');
  const url = new URL('/asset', env('URL'));
  url.searchParams.set('path', path);
  url.searchParams.set('expires', expires);
  url.searchParams.set('sig', sig);
  return url.toString();
}
export function verifyAsset(path: string, expires: string, signature: string): boolean {
  if (!path || path.startsWith('/') || path.includes('..') || !/^\d{10}$/.test(expires) || Number(expires) <= Date.now() / 1000) return false;
  const expected = createHmac('sha256', env('ADLOCALIZER_MCP_TOKEN')).update(`${path}\n${expires}`).digest('hex');
  const a = Buffer.from(signature), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function ownedPath(url: string, owner: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== new URL(env('URL')).origin || parsed.pathname !== '/asset') return null;
    const path = parsed.searchParams.get('path') || '';
    if (!path.startsWith(`${owner}/sources/`) || !verifyAsset(path, parsed.searchParams.get('expires') || '', parsed.searchParams.get('sig') || '')) return null;
    return path;
  } catch { return null; }
}
export function internalSignature(jobId: string): string {
  return createHmac('sha256', env('ADLOCALIZER_MCP_TOKEN')).update(`worker:${jobId}`).digest('hex');
}
export function verifyInternal(jobId: string, signature: string | null): boolean {
  const a = Buffer.from(signature || ''), b = Buffer.from(internalSignature(jobId));
  return a.length === b.length && timingSafeEqual(a, b);
}
export function validateUrl(url: string, field: string): URL {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error(`${field}: expected an absolute HTTPS URL`); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) throw new Error(`${field}: expected a public HTTPS URL`);
  if (parsed.hostname === 'localhost' || parsed.hostname.endsWith('.localhost') || parsed.hostname.endsWith('.local') || isIP(parsed.hostname) || !parsed.hostname.includes('.')) throw new Error(`${field}: private or literal-IP hosts are not allowed`);
  return parsed;
}
export async function assertPublicHost(hostname: string): Promise<{ address: string; family: number }> {
  let addresses: Array<{ address: string; family: number }>;
  try { addresses = await lookup(hostname, { all: true }); } catch { throw new Error('url: hostname could not be resolved'); }
  if (!addresses.length || addresses.some(({ address, family }) => family === 4
    ? /^(?:0\.|10\.|127\.|169\.254\.|192\.168\.|192\.0\.0\.|192\.0\.2\.|198\.18\.|198\.19\.|198\.51\.100\.|203\.0\.113\.|255\.)/.test(address)
      || (/^172\.(\d+)\./.test(address) && Number(/^172\.(\d+)\./.exec(address)?.[1]) >= 16 && Number(/^172\.(\d+)\./.exec(address)?.[1]) <= 31)
      || (/^100\.(\d+)\./.test(address) && Number(/^100\.(\d+)\./.exec(address)?.[1]) >= 64 && Number(/^100\.(\d+)\./.exec(address)?.[1]) <= 127)
      || Number(address.split('.')[0]) >= 224
    : !/^[23][0-9a-f]{3}:/i.test(address) || /^2001:db8:/i.test(address))) throw new Error('url: private network addresses are not allowed');
  return addresses[0];
}
export async function imageFromUrl(url: string, redirects = 0): Promise<{ bytes: Buffer; mime: string; ext: string }> {
  const parsed = validateUrl(url, 'url');
  const pinned = await assertPublicHost(parsed.hostname);
  return new Promise((resolve, reject) => {
    const req = httpsGet(parsed, { signal: AbortSignal.timeout(20000), lookup: (_host, _options, callback) => callback(null, pinned.address, pinned.family) }, async (response) => {
      try {
        if ([301,302,303,307,308].includes(response.statusCode || 0)) {
          if (redirects >= 2 || !response.headers.location) throw new Error('url: too many redirects');
          response.resume(); resolve(await imageFromUrl(new URL(response.headers.location, parsed).toString(), redirects + 1)); return;
        }
        if (response.statusCode !== 200) throw new Error(`url: image download HTTP ${response.statusCode}`);
        if (Number(response.headers['content-length'] || 0) > MAX_IMAGE_BYTES) throw new Error('url: image exceeds 12 MB');
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of response) { size += chunk.length; if (size > MAX_IMAGE_BYTES) throw new Error('url: image exceeds 12 MB'); chunks.push(chunk); }
        resolve(inspectImage(Buffer.concat(chunks, size)));
      } catch (error) { response.destroy(); reject(error); }
    }); req.on('error', reject);
  });
}
export function inspectImage(bytes: Buffer): { bytes: Buffer; mime: string; ext: string } {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('image: image must be between 1 byte and 12 MB');
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return { bytes, mime: 'image/png', ext: 'png' };
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { bytes, mime: 'image/jpeg', ext: 'jpg' };
  if (bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP') return { bytes, mime: 'image/webp', ext: 'webp' };
  throw new Error('image: only PNG, JPEG and WebP files are supported');
}
export function imageFromBase64(value: string) {
  const encoded = value.replace(/^data:image\/(?:png|jpeg|webp);base64,/i, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length > MAX_INLINE_BYTES * 1.35) throw new Error('base64: invalid image or over 4 MB; use url for larger files');
  return inspectImage(Buffer.from(encoded, 'base64'));
}
export async function saveAsset(path: string, bytes: Buffer, mime: string) {
  await assetStore().set(path, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { metadata: { contentType: mime, size: bytes.byteLength } });
}
export async function getAsset(path: string): Promise<Buffer> {
  const data = await assetStore().get(path, { type: 'arrayBuffer' });
  if (!data) throw new Error('asset: stored image not found');
  return Buffer.from(data);
}
export async function storeImage(owner: string, image: { bytes: Buffer; mime: string; ext: string }) {
  const path = `${owner}/sources/${randomUUID()}.${image.ext}`;
  await saveAsset(path, image.bytes, image.mime);
  return { path, url: signedUrl(path) };
}
export async function updateJSON<T>(store: ReturnType<typeof getStore>, key: string, fn: (value: T | null) => T): Promise<T> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const previous = await store.getWithMetadata(key, { type: 'json' });
    const next = fn(previous?.data as T || null);
    const saved = await store.setJSON(key, next, previous ? { onlyIfMatch: previous.etag } : { onlyIfNew: true });
    if (saved.modified) return next;
  }
  throw new Error('state: concurrent update contention; retry the request');
}
export async function enforceRate(owner: string, name: string) {
  const key = `rate/${owner}/${Math.floor(Date.now() / 60000)}`;
  await updateJSON<{count:number;starts:number}>(stateStore(), key, (previous) => {
    const count = previous?.count || 0, starts = previous?.starts || 0;
    if (count >= 60) throw new Error('rate_limit: maximum 60 tool calls per minute');
    if (name === 'start_localization' && starts >= 3) throw new Error('rate_limit: maximum 3 new jobs per minute');
    return { count: count + 1, starts: starts + (name === 'start_localization' ? 1 : 0) };
  });
}
export async function audit(owner: string, tool: string, result: 'success'|'error', detail = '') {
  await stateStore().setJSON(`audit/${owner}/${Date.now()}-${randomUUID()}`, { token_id: owner, tool, time: new Date().toISOString(), result, detail: detail.slice(0,300) });
}
