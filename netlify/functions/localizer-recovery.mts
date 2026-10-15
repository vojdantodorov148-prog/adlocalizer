import type { Config } from '@netlify/functions';
import { recoverJobs } from '../lib/jobs';
import { dispatchJob } from '../lib/dispatch';

export default async () => {
  const base = process.env.URL;
  if (!base) return;
  await recoverJobs(async (id) => {
    try { await dispatchJob(id, base); }
    catch (error) { console.error('Recovery dispatch:', id, String(error)); }
  });
};

export const config: Config = { schedule: '*/10 * * * *' };
