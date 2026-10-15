import { test } from 'node:test';
import assert from 'node:assert/strict';
import mcp from '../netlify/functions/mcp.mts';
import { isAuthorized, inspectImage, ownedPath, signedUrl, validateUrl, verifyAsset } from '../netlify/lib/core';
import { languageOptions, options } from '../netlify/lib/jobs';
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
    'get_job', 'get_job_zip', 'list_jobs', 'list_languages', 'list_options', 'start_localization', 'upload_image',
  ].sort());
});

test('shared UI lists and file validation', () => {
  assert.deepEqual(languageOptions().map((item) => item.code), COUNTRIES);
  assert.deepEqual(options().aspect_ratios, ASPECT_RATIOS.map((ratio) => ratio.value));
  assert.equal(options().default_aspect_ratio, '4:5');
  assert.equal(inspectImage(Buffer.from([137,80,78,71,13,10,26,10,0])).ext, 'png');
  assert.throws(() => inspectImage(Buffer.from('not-an-image')), /only PNG/);
  assert.throws(() => validateUrl('http://127.0.0.1/private', 'url'), /public HTTPS/);
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
