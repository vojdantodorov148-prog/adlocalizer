import type { Config } from '@netlify/functions';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { audit, enforceRate, env, imageFromBase64, imageFromUrl, isAuthorized, storeImage, tokenId } from '../lib/core';
import { createJob, languageOptions, listJobs, options, publicJob, zipJob } from '../lib/jobs';
import { dispatchJob } from '../lib/dispatch';

function json(data: unknown) { return { content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: data as Record<string, unknown> }; }

function createServer(owner: string, origin: string, markAudited: () => void) {
  const server = new McpServer({ name: 'ad-localizer', version: '3.6.0' });
  const wrap = <A extends Record<string, unknown>>(name: string, fn: (args: A) => Promise<unknown>) => async (args: A) => {
    try {
      const value = await fn(args);
      await audit(owner, name, 'success');
      markAudited();
      return json(value);
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error);
      await audit(owner, name, 'error', message);
      markAudited();
      return { content: [{ type: 'text' as const, text: message }], isError: true };
    }
  };

  server.registerTool('list_languages', { description: 'List exactly the markets in the Ad Localizer UI.', inputSchema: {} }, wrap('list_languages', async () => ({ languages: languageOptions() })));
  server.registerTool('list_options', { description: 'List image model, ratio, resolution and defaults from the UI.', inputSchema: {} }, wrap('list_options', async () => options()));
  server.registerTool('upload_image', {
    description: 'Upload one PNG, JPEG or WebP source image from a public HTTPS URL or base64, returning a 30-day signed URL.',
    inputSchema: { url: z.string().optional(), base64: z.string().optional(), filename: z.string().min(1).max(150) },
  }, wrap('upload_image', async (args) => {
    if (Boolean(args.url) === Boolean(args.base64)) throw new Error('url/base64: provide exactly one');
    if (/[\/\\]/.test(String(args.filename))) throw new Error('filename: only a basename is allowed');
    const image = args.url ? await imageFromUrl(String(args.url)) : imageFromBase64(String(args.base64));
    const stored = await storeImage(owner, image);
    return { url: stored.url, filename: args.filename, expires_in_days: 30 };
  }));

  server.registerTool('start_localization', {
    description: 'Queue a localization job; returns job_id immediately. Finished Ad Creator PRO jobs can be used by ID.',
    inputSchema: {
      image_urls: z.array(z.string()).optional(), ad_creator_job_id: z.string().optional(),
      target_languages: z.array(z.string()), notes: z.string().optional(), keep_layout: z.boolean().optional(),
      model: z.enum(['gemini','chatgpt','grok']).optional(), resolution: z.string().optional(),
      aspect_ratio: z.string().optional(), strict_text_check: z.boolean().optional(), idempotency_key: z.string().optional(),
    },
  }, wrap('start_localization', async (args) => ({ job_id: await createJob(owner, args, (id) => dispatchJob(id, origin)), status: 'queued' })));

  server.registerTool('get_job', { description: 'Fetch job status, progress, errors and available image URLs.', inputSchema: { job_id: z.string() } },
    wrap('get_job', async ({ job_id }) => publicJob(owner, String(job_id))));
  server.registerTool('list_jobs', {
    description: 'List your recent jobs, optionally filtered by status or language.',
    inputSchema: { status: z.string().optional(), language: z.string().optional(), limit: z.number().int().optional() },
  }, wrap('list_jobs', async ({ status, language, limit }) => ({ jobs: await listJobs(owner, status as string | undefined, language as string | undefined, limit as number | undefined) })));
  server.registerTool('get_job_zip', {
    description: 'Get a 30-day signed ZIP URL; ZIP folders are organized by market.',
    inputSchema: { job_id: z.string(), language: z.string().optional() },
  }, wrap('get_job_zip', async ({ job_id, language }) => zipJob(owner, String(job_id), language as string | undefined)));
  return server;
}

export default async (request: Request) => {
  if (!isAuthorized(request.headers.get('authorization'), env('ADLOCALIZER_MCP_TOKEN'))) {
    return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } });
  }
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return new Response('Forbidden Origin', { status: 403 });
  if (request.method === 'GET') return new Response('SSE is not supported. Use POST.', { status: 405 });
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  const owner = tokenId(env('ADLOCALIZER_MCP_TOKEN'));
  const envelope = await request.clone().json().catch(() => null);
  if (envelope?.method === 'tools/call') {
    const name = String(envelope.params?.name || 'unknown');
    try { await enforceRate(owner, name); }
    catch (error) {
      const message = String(error instanceof Error ? error.message : error);
      await audit(owner, name, 'error', message);
      return Response.json({ jsonrpc: '2.0', id: envelope.id ?? null, error: { code: -32000, message } }, { status: 429 });
    }
  }
  let audited = false;
  const server = createServer(owner, request.url, () => { audited = true; });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  const response = await transport.handleRequest(request);
  if (envelope?.method === 'tools/call' && !audited) {
    await audit(owner, String(envelope.params?.name || 'unknown'), 'error', 'Tool input or method validation failed');
  }
  return response;
};

export const config: Config = { path: '/mcp' };
