import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { validateUrl } from './core';

type RecordValue = Record<string, unknown>;
const object = (value: unknown): value is RecordValue => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function jobPayload(value: unknown): RecordValue {
  let current = value;
  for (let i = 0; i < 3; i++) {
    if (!object(current)) break;
    if ('status' in current || 'state' in current) return current;
    current = current.job ?? current.result ?? current.data;
  }
  throw new Error('ad_creator_job_id: get_job returned no job status');
}

function imageEntries(job: RecordValue): unknown[] {
  const value = job.results ?? job.images ?? job.image_urls ?? job.output_urls ?? job.outputs;
  if (!Array.isArray(value)) throw new Error('ad_creator_job_id: get_job returned no result images');
  // Some job APIs group the images under a result, while others return one result per image.
  return value.flatMap((entry) => object(entry) && Array.isArray(entry.images) ? entry.images : [entry]);
}

function imageUrl(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry;
  if (!object(entry)) return undefined;
  return [entry.url, entry.image_url, entry.imageUrl, entry.output_url]
    .find((value): value is string => typeof value === 'string' && Boolean(value.trim()));
}

function imageId(entry: unknown): string | undefined {
  if (!object(entry)) return undefined;
  const value = entry.image_id ?? entry.imageId ?? entry.id;
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
}

export function extractAdCreatorImages(result: unknown, requestedIds?: string[]): string[] {
  const job = jobPayload(result);
  const status = String(job.status ?? job.state ?? 'unknown').toLowerCase();
  if (status !== 'done') throw new Error(`Ad Creator job not finished: ${status}`);
  const entries = imageEntries(job);
  let selected = entries;
  if (requestedIds !== undefined) {
    if (!Array.isArray(requestedIds) || !requestedIds.length || requestedIds.length > 20 ||
        requestedIds.some((id) => typeof id !== 'string' || !id.trim()) || new Set(requestedIds).size !== requestedIds.length) {
      throw new Error('image_ids: expected 1 to 20 unique nonempty image IDs');
    }
    const byId = new Map<string, unknown>();
    for (const entry of entries) {
      const id = imageId(entry);
      if (id) byId.set(id, entry);
    }
    const missing = requestedIds.find((id) => !byId.has(id));
    if (missing) throw new Error(`image_ids: image ID ${JSON.stringify(missing)} not found in Ad Creator job results`);
    selected = requestedIds.map((id) => byId.get(id));
  }
  if (!selected.length || selected.length > 20) throw new Error('ad_creator_job_id: expected 1 to 20 result images');
  return selected.map((entry, index) => {
    const url = imageUrl(entry);
    if (!url) throw new Error(`ad_creator_job_id.results[${index}]: missing image URL`);
    validateUrl(url, `ad_creator_job_id.results[${index}].url`);
    return url;
  });
}

export async function adCreatorSources(jobId: string, imageIds?: string[]): Promise<string[]> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(jobId)) throw new Error('ad_creator_job_id: invalid ID');
  if (imageIds !== undefined && (!Array.isArray(imageIds) || !imageIds.length || imageIds.length > 20 ||
      imageIds.some((id) => typeof id !== 'string' || !id.trim()) || new Set(imageIds).size !== imageIds.length)) {
    throw new Error('image_ids: expected 1 to 20 unique nonempty image IDs');
  }
  const endpoint = process.env.ADCREATOR_MCP_URL;
  const token = process.env.ADCREATOR_MCP_TOKEN;
  if (!endpoint || !token) throw new Error('ad_creator_job_id: ADCREATOR_MCP_URL and ADCREATOR_MCP_TOKEN must be configured on the server');
  const url = validateUrl(endpoint, 'ADCREATOR_MCP_URL');
  if (url.pathname !== '/mcp' || url.search || url.hash) throw new Error('ADCREATOR_MCP_URL: expected an HTTPS /mcp endpoint');

  const client = new Client({ name: 'ad-localizer', version: '3.7.0' });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` }, redirect: 'error' },
    redirectPolicy: 'same-origin',
  });
  try {
    await client.connect(transport, { timeout: 10000 });
    const response = await client.callTool({ name: 'get_job', arguments: { job_id: jobId } }, undefined, { timeout: 10000 });
    const content = Array.isArray(response.content) ? response.content : [];
    const text = content.find((item) => item.type === 'text') as { text?: string } | undefined;
    if (response.isError) throw new Error('ad_creator_job_id: Ad Creator get_job failed: ' + (text?.text || 'unknown error').slice(0, 250));
    const data = response.structuredContent ?? (text?.text ? JSON.parse(text.text) as unknown : undefined);
    return extractAdCreatorImages(data, imageIds);
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).replaceAll(token, '[redacted]');
    if (message.startsWith('ad_creator_job_id:') || message.startsWith('image_ids:') || message.startsWith('Ad Creator job not finished:')) throw error;
    throw new Error(`ad_creator_job_id: Ad Creator MCP connection or response failed (${message.slice(0, 180)})`);
  } finally {
    await client.close().catch(() => {});
  }
}
