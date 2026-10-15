import type { Config } from '@netlify/functions';
import { env, verifyInternal } from '../lib/core';
import { runJob } from '../lib/jobs';
import { dispatchJob } from '../lib/dispatch';

export default async (request: Request) => {
  if (request.method !== 'POST') return;
  let id = '';
  try {
    id = String((await request.json()).job_id || '');
    if (!/^[a-f0-9-]{32,36}$/i.test(id) || !verifyInternal(id, request.headers.get('x-internal-signature'))) return;
    env('KIE_API_KEY');
    await runJob(id, (next) => dispatchJob(next, request.url));
  } catch (error) {
    console.error('Ad Localizer worker:', id, String(error));
    // The recovery schedule redelivers jobs whose worker expired unexpectedly.
  }
};

export const config: Config = { background: true };
