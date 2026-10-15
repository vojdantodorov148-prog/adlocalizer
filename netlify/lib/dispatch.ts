import { internalSignature } from './core';

export async function dispatchJob(jobId: string, origin: string) {
  const base = new URL(origin).origin;
  const response = await fetch(`${base}/.netlify/functions/localizer-worker`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-signature': internalSignature(jobId) },
    body: JSON.stringify({ job_id: jobId }), signal: AbortSignal.timeout(12000),
  });
  if (response.status !== 202) throw new Error(`Worker scheduling failed: HTTP ${response.status}`);
}
