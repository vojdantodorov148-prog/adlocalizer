import type { Config } from '@netlify/functions';
import { botOwner, generate, generationStatus, issueKey } from '../lib/bot';
import { env, isAuthorized, stateStore } from '../lib/core';
import { createJob, languageOptions, options, publicJob } from '../lib/jobs';
import { dispatchJob } from '../lib/dispatch';

export default async function handler(req: Request) {
  const url = new URL(req.url);
  const path = url.pathname.slice('/api/v1/'.length);
  const auth = req.headers.get('authorization');
  const reply = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
  try {
    if (path === 'keys' || path.startsWith('keys/')) {
      if (!isAuthorized(auth, env('ADLOCALIZER_MCP_TOKEN'))) return reply({ error: 'Owner token required' }, 401);
      if (path === 'keys' && req.method === 'POST') return reply(await issueKey(), 201);
      if (/^keys\/[a-f0-9]{32}$/.test(path) && req.method === 'DELETE') {
        await stateStore().delete(path);
        return reply({ revoked: true });
      }
      return reply({ error: 'Unsupported key operation' }, 405);
    }
    const owner = await botOwner(auth);
    if (!owner) return reply({ error: 'Valid bot API key required' }, 401);
    if (req.method === 'GET' && path === 'options') return reply({ ...options(), languages: languageOptions() });
    if (req.method === 'GET' && path.startsWith('jobs/')) {
      const id = path.slice(5);
      return reply(id.startsWith('gen_') ? await generationStatus(owner, id) : await publicJob(owner, id));
    }
    if (req.method === 'POST' && ['generate','localize'].includes(path)) {
      const body = await req.json().catch(() => null);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return reply({ error: 'Expected a JSON object' }, 400);
      if (path === 'generate') return reply(await generate(owner, body.prompt), 202);
      const id = await createJob(owner, body, job => dispatchJob(job, env('URL')));
      return reply({ job_id: id }, 202);
    }
    return reply({ error: 'Unknown endpoint' }, 404);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message === 'job_id: not found') return reply({ error: message }, 404);
    if (/^(prompt|job_id|image_urls|image_ids|target_languages|model|resolution|aspect_ratio|keep_layout|notes|idempotency_key)[:/\[]/.test(message)) return reply({ error: message }, 400);
    return reply({ error: 'Request could not be completed. Check service configuration or provider availability.' }, 502);
  }
}
export const config: Config = { path: '/api/v1/*' };
