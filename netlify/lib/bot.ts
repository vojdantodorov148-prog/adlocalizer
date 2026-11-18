import { randomBytes } from 'node:crypto';
import { env, stateStore, tokenId } from './core';

export async function issueKey() {
  const key = 'al_' + randomBytes(32).toString('hex');
  const id = tokenId(key);
  await stateStore().setJSON('keys/' + id, { created: new Date().toISOString() });
  return { key, id };
}

export async function botOwner(header: string | null) {
  const match = /^Bearer (al_[a-f0-9]{64})$/i.exec(header || '');
  if (!match) return null;
  const owner = tokenId(match[1]);
  return await stateStore().get('keys/' + owner) ? owner : null;
}

async function provider(path: string, body?: object) {
  const response = await fetch('https://api.kie.ai/api/v1/jobs/' + path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: 'Bearer ' + env('KIE_API_KEY'), 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const json = await response.json();
  if (!response.ok || json.code !== 200 || !json.data) throw new Error('Image provider request failed');
  return json.data;
}

export async function generate(owner: string, prompt: string) {
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('prompt: enter an image description');
  const data = await provider('createTask', { model: 'grok-imagine/text-to-image', input: { prompt, aspect_ratio: '1:1' } });
  if (typeof data.taskId !== 'string' || !data.taskId) throw new Error('Missing provider task ID');
  const id = 'gen_' + randomBytes(16).toString('hex');
  await stateStore().setJSON('generation/' + owner + '/' + id, { task: data.taskId });
  return { job_id: id, status: 'queued' };
}

export async function generationStatus(owner: string, id: string) {
  if (!/^gen_[a-f0-9]{32}$/.test(id)) throw new Error('job_id: invalid ID');
  const job = await stateStore().get('generation/' + owner + '/' + id, { type: 'json' });
  if (!job) throw new Error('job_id: not found');
  const data = await provider('recordInfo?taskId=' + encodeURIComponent(job.task));
  const status = data.state === 'success' ? 'done' : data.state === 'fail' ? 'failed' : 'running';
  const urls: string[] = status === 'done' ? JSON.parse(data.resultJson).resultUrls : [];
  return { job_id: id, status, results: urls.map(url => ({ url })), error: status === 'failed' ? 'Generation failed' : null };
}
