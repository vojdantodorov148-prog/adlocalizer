import { test } from 'node:test';
import assert from 'node:assert/strict';
import mcp from '../netlify/functions/mcp.mts';
import { isAuthorized, inspectImage, ownedPath, signedUrl, validateUrl, verifyAsset } from '../netlify/lib/core';
import { languageOptions, options } from '../netlify/lib/jobs';
import { adCreatorSources, extractAdCreatorImages } from '../netlify/lib/ad-creator';
import { COUNTRIES, ASPECT_RATIOS } from '../src/options';

process.env.ADLOCALIZER_MCP_TOKEN = 'test-token-that-is-not-real';
process.env.URL = 'https://adlocalizer.netlify.app';

test('auth and origin protections block unauthenticated requests before initialization', async () => {
  const url = 'https://adlocalizer.netlify.app/mcp';
  const unauthenticated = await mcp(new Request(url, { method: 'POST' }));
  assert.equal(unauthenticated.status, 401);
  const foreignOrigin = await mcp(new Request(url, { method: 'POST', headers: {
    authorization: 'Bearer test-token-that-is-not-real', origin: 'https://evil.example',
  } }));
  assert.equal(foreignOrigin.status, 403);
  assert.equal(isAuthorized('Bearer bad', process.env.ADLOCALIZER_MCP_TOKEN!), false);
});

test('MCP Streamable HTTP initializes and lists all seven tools', async () => {
  const url = 'https://adlocalizer.netlify.app/mcp';
  const call = (id: number, method: string, params: unknown) => mcp(new Request(url, {
    method: 'POST', headers: {
      authorization: 'Bearer test-token-that-is-not-real',
      accept: 'application/json, text/event-stream', 'content-type': 'application/json',
    }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  }));
  const initialized = await call(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(initialized.status, 200);
  assert.equal((await initialized.json()).result.serverInfo.name, 'ad-localizer');
  const listed = await call(2, 'tools/list', {});
  assert.deepEqual((await listed.json()).result.tools.map((tool: { name: string }) => tool.name).sort(), [
    'get_job', 'get_job_zip', 'list_jobs', 'list_languages', 'list_options', 'localize_creator_output', 'start_localization', 'upload_image',
  ].sort());
});

test('shared UI lists and file validation', () => {
  assert.deepEqual(languageOptions().map((item) => item.code), COUNTRIES);
  assert.deepEqual(options().aspect_ratios, ASPECT_RATIOS.map((ratio) => ratio.value));
  assert.equal(options().default_aspect_ratio, '4:5');
  assert.equal(options().ad_creator_job_id.requires_adapter, false);
  assert.equal(inspectImage(Buffer.from([137,80,78,71,13,10,26,10,0])).ext, 'png');
  assert.throws(() => inspectImage(Buffer.from('not-an-image')), /only PNG/);
  assert.throws(() => validateUrl('http://127.0.0.1/private', 'url'), /public HTTPS/);
});

test('Ad Creator results require a finished job and support selecting image IDs', () => {
  const job = { status: 'done', results: [
    { image_id: 'first', url: 'https://firebasestorage.googleapis.com/one.png?token=one' },
    { image_id: 'second', url: 'https://firebasestorage.googleapis.com/two.png?token=two' },
  ] };
  assert.deepEqual(extractAdCreatorImages(job, ['second']), ['https://firebasestorage.googleapis.com/two.png?token=two']);
  assert.throws(() => extractAdCreatorImages({ ...job, status: 'running' }), /Ad Creator job not finished: running/);
  assert.throws(() => extractAdCreatorImages(job, ['missing']), /image_ids: image ID/);
  assert.throws(() => extractAdCreatorImages(job, ['first', 'first']), /image_ids: expected/);
  assert.throws(() => extractAdCreatorImages({ status: 'done', results: [{ url: 'http:\/\/localhost/private' }] }), /HTTPS/);
});

test('Ad Creator MCP adapter sends server-only Bearer token and calls get_job', async () => {
  process.env.ADCREATOR_MCP_URL = 'https://adcreatorpro.netlify.app/mcp';
  process.env.ADCREATOR_MCP_TOKEN = 'private-ad-creator-token';
  const original = globalThis.fetch;
  const methods: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    assert.equal(request.url, process.env.ADCREATOR_MCP_URL);
    assert.equal(request.headers.get('authorization'), 'Bearer private-ad-creator-token');
    const message = await request.json();
    methods.push(message.method);
    if (message.method === 'initialize') return Response.json({ jsonrpc:'2.0', id:message.id,
      result:{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'ad-creator',version:'1.0.0'}} });
    if (message.method === 'tools/call') {
      assert.deepEqual(message.params, {name:'get_job',arguments:{job_id:'creator-job-1'}});
      return Response.json({jsonrpc:'2.0',id:message.id,result:{content:[{type:'text',text:JSON.stringify({status:'done',results:[
        {id:'a',url:'https://firebasestorage.googleapis.com/a.png?token=one'},
        {id:'b',url:'https://firebasestorage.googleapis.com/b.png?token=two'},
      ]})}]}});
    }
    return new Response(null, {status:202});
  }) as typeof fetch;
  try {
    assert.deepEqual(await adCreatorSources('creator-job-1', ['b']), ['https://firebasestorage.googleapis.com/b.png?token=two']);
    assert.ok(methods.includes('initialize'));
    assert.ok(methods.includes('tools/call'));
  } finally {
    globalThis.fetch = original;
    delete process.env.ADCREATOR_MCP_TOKEN;
    delete process.env.ADCREATOR_MCP_URL;
  }
});

test('30-day asset link is scoped, signed and expires', async () => {
  const path = 'owner/sources/test.png';
  const url = new URL(await signedUrl(path));
  const expires = url.searchParams.get('expires')!;
  const sig = url.searchParams.get('sig')!;
  assert.equal(url.pathname, '/asset');
  assert.ok(Number(expires) * 1000 - Date.now() >= 30 * 24 * 60 * 60 * 1000 - 1000);
  assert.equal(verifyAsset(path, expires, sig), true);
  assert.equal(ownedPath(url.toString(), 'owner'), path);
  assert.equal(ownedPath(url.toString(), 'someone-else'), null);
  assert.equal(verifyAsset(path + 'x', expires, sig), false);
  assert.equal(verifyAsset(path, '1000000000', sig), false);
});

test('bot API denies anonymous key management and bot operations', async () => {
  const { default: api } = await import('../netlify/functions/bot-api.mts');
  for (const path of ['keys', 'generate', 'localize', 'jobs/gen_example', 'options']) {
    const response = await api(new Request('https://adlocalizer.netlify.app/api/v1/' + path, { method: 'POST' }));
    assert.equal(response.status, 401);
  }
});
