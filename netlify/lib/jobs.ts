import { createHash, randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { assetStore, getAsset, imageFromUrl, jobsStore, ownedPath, saveAsset, signedUrl, stateStore, storeImage, updateJSON, validateUrl } from './core';
import { COUNTRIES, ASPECT_RATIOS } from '../../src/options';
import { IMAGE_MODELS, uploadImage, translateAd, createTask, pollTask, buildRenderPrompt, fetchResultBlob, verifyRenderedText } from '../../src/kie';
import { applyCanonicalMemory, type FinalSegment, type TranslationMemoryEntry, type GlossaryStore } from '../../src/localization';

export type JobState = 'queued'|'running'|'done'|'failed';
export type Source = { url: string; path?: string; kieUrl?: string };
export type Item = { sourceIndex: number; language: string; path: string; translated_text: FinalSegment[] };
export type Job = {
  owner: string; status: JobState; createdAt: string; updatedAt: string; leaseUntil?: number;
  sources: Source[]; languages: string[]; notes: string; model: string; resolution: string;
  aspectRatio: string; keepLayout: true; strictTextCheck: boolean;
  total: number; completed: number; results: Item[]; failures: Array<{sourceIndex:number;language:string;error:string}>;
  fingerprint: string;
};
const key = (id: string) => `jobs/${id}`;
const now = () => new Date().toISOString();
const read = async (id: string) => jobsStore().get(key(id), { type: 'json' }) as Promise<Job|null>;
const update = (id: string, fn: (job: Job) => Job) => updateJSON<Job>(jobsStore(), key(id), (job) => {
  if (!job) throw new Error('job_id: not found');
  return fn(job);
});
export const languageOptions = () => COUNTRIES.map((name) => ({code:name,name}));
export const options = () => ({
  models: IMAGE_MODELS.map(({id,label,detail}) => ({code:id,name:label,detail})),
  default_model:'gemini', aspect_ratios:ASPECT_RATIOS.map(({value}) => value), default_aspect_ratio:'4:5',
  resolution:{gemini:['2K'],chatgpt:['provider-default'],grok:['provider-default']}, default_resolution:'2K',
  keep_layout:{supported:[true],default:true}, strict_text_check:{default:false}, image_formats:['png','jpg','webp'],
  ad_creator_job_id:{requires_adapter:true},
});
export function sourceUrls(value: unknown, field = 'image_urls'): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 20 || value.some((u) => typeof u !== 'string' || !u.trim())) throw new Error(`${field}: expected 1 to 20 nonempty URL strings`);
  return value.map(String);
}
export async function adCreatorSources(jobId: string): Promise<string[]> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(jobId)) throw new Error('ad_creator_job_id: invalid ID');
  // The Ad Creator PRO job schema and API were not supplied. Require an explicit
  // adapter endpoint instead of guessing Firestore fields or silently failing.
  const endpoint = process.env.AD_CREATOR_JOB_API;
  const token = process.env.AD_CREATOR_API_TOKEN;
  if (!endpoint || !token) throw new Error('ad_creator_job_id: Ad Creator PRO connection is not configured; pass image_urls instead');
  const base = validateUrl(endpoint, 'AD_CREATOR_JOB_API');
  const response = await fetch(new URL(encodeURIComponent(jobId), base.toString().replace(/\/?$/, '/')), {
    headers:{Authorization:`Bearer ${token}`}, signal:AbortSignal.timeout(15000), redirect:'error',
  });
  if (!response.ok) throw new Error(`ad_creator_job_id: Ad Creator PRO returned HTTP ${response.status}`);
  const data = await response.json();
  if (!['done','completed','success','succeeded'].includes(String(data.status || data.state).toLowerCase())) throw new Error('ad_creator_job_id: job is not finished');
  const images = data.image_urls || data.output_urls || data.images || data.results || data.outputs;
  return sourceUrls(Array.isArray(images) ? images.map((x) => typeof x === 'string' ? x : x?.url || x?.image_url || x?.imageUrl || x?.output_url) : [], 'ad_creator_job_id.images');
}
export async function createJob(owner:string,args:Record<string,unknown>,startWorker:(id:string)=>Promise<void>):Promise<string> {
  const hasUrls = args.image_urls !== undefined, hasCreator = args.ad_creator_job_id !== undefined;
  if (hasUrls === hasCreator) throw new Error('image_urls/ad_creator_job_id: provide exactly one source');
  const urls = hasUrls ? sourceUrls(args.image_urls) : await adCreatorSources(String(args.ad_creator_job_id));
  urls.forEach((url,index) => validateUrl(url,`image_urls[${index}]`));
  const languages = args.target_languages;
  if (!Array.isArray(languages) || !languages.length || languages.some((v) => typeof v !== 'string' || !COUNTRIES.includes(v))) throw new Error('target_languages: use market codes returned by list_languages');
  if (new Set(languages).size !== languages.length) throw new Error('target_languages: duplicate market codes');
  if (urls.length * languages.length > 100) throw new Error('target_languages: maximum 100 source × market results per job');
  const model = String(args.model || 'gemini');
  if (!IMAGE_MODELS.some(({id}) => id === model)) throw new Error('model: use gemini, chatgpt or grok');
  const resolution = String(args.resolution || (model === 'gemini' ? '2K' : 'provider-default'));
  if (resolution !== (model === 'gemini' ? '2K' : 'provider-default')) throw new Error('resolution: unsupported for this model; see list_options');
  const aspectRatio = String(args.aspect_ratio || '4:5');
  if (!ASPECT_RATIOS.some(({value}) => value === aspectRatio)) throw new Error('aspect_ratio: unsupported; see list_options');
  if (args.keep_layout === false) throw new Error('keep_layout: the current UI pipeline only supports true');
  const notes = String(args.notes || ''); if (notes.length > 4000) throw new Error('notes: maximum 4000 characters');
  const idempotency = args.idempotency_key === undefined ? '' : String(args.idempotency_key);
  if (idempotency && (idempotency.length > 128 || !/^[\w.:-]+$/.test(idempotency))) throw new Error('idempotency_key: use 1–128 letters, digits, _, ., : or -');
  const id = idempotency ? createHash('sha256').update(`${owner}:${idempotency}`).digest('hex').slice(0,32) : randomUUID();
  const sources = urls.map((url) => ({url,...(ownedPath(url,owner) ? {path:ownedPath(url,owner)!} : {})}));
  const strictTextCheck = args.strict_text_check === true;
  const fingerprint = createHash('sha256').update(JSON.stringify({sources,languages,notes,model,resolution,aspectRatio,strictTextCheck})).digest('hex');
  const existing = await read(id);
  if (existing) {
    if (existing.owner !== owner || existing.fingerprint !== fingerprint) throw new Error('idempotency_key: already used for a different request');
    return id;
  }
  const stamp = now();
  const job:Job = { owner,status:'queued',createdAt:stamp,updatedAt:stamp,sources,languages,notes,model,resolution,aspectRatio,keepLayout:true,strictTextCheck,total:sources.length*languages.length,completed:0,results:[],failures:[],fingerprint };
  const created = await jobsStore().setJSON(key(id), job, {onlyIfNew:true});
  if (!created.modified) {
    const current = await read(id);
    if (current?.owner !== owner || current?.fingerprint !== fingerprint) throw new Error('idempotency_key: already used for a different request');
    return id;
  }
  try { await startWorker(id); }
  catch (error) { await update(id,(job) => ({...job,status:'failed',updatedAt:now(),failures:[{sourceIndex:0,language:'',error:'Worker could not be scheduled'}]})); throw error; }
  return id;
}
export async function getOwnedJob(owner:string,id:string):Promise<Job> {
  if (!/^[a-f0-9-]{32,36}$/i.test(id)) throw new Error('job_id: invalid ID');
  const job = await read(id);
  if (!job || job.owner !== owner) throw new Error('job_id: not found');
  return job;
}
export async function publicJob(owner:string,id:string) {
  const job = await getOwnedJob(owner,id);
  return { job_id:id,status:job.status,progress:{completed:job.completed,total:job.total},error:job.failures.length ? job.failures : null,
    results:job.results.map((r) => ({source_url:job.sources[r.sourceIndex].path ? signedUrl(job.sources[r.sourceIndex].path!) : job.sources[r.sourceIndex].url,language:r.language,url:signedUrl(r.path),translated_text:r.translated_text})) };
}
export async function listJobs(owner:string,status?:string,language?:string,limit=20) {
  if (status && !['queued','running','done','failed'].includes(status)) throw new Error('status: expected queued|running|done|failed');
  if (language && !COUNTRIES.includes(language)) throw new Error('language: unknown market code');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit: expected integer 1–100');
  const {blobs} = await jobsStore().list({prefix:'jobs/'});
  const jobs = await Promise.all(blobs.map(async ({key}) => ({job_id:key.slice(5),job:await jobsStore().get(key,{type:'json'}) as Job|null})));
  return jobs.filter(({job}) => job && job.owner === owner && (!status || job.status === status) && (!language || job.languages.includes(language)))
    .sort((a,b) => b.job!.createdAt.localeCompare(a.job!.createdAt)).slice(0,limit)
    .map(({job_id,job}) => ({job_id,status:job!.status,created_at:job!.createdAt,progress:{completed:job!.completed,total:job!.total},languages:job!.languages}));
}
export async function zipJob(owner:string,id:string,language?:string) {
  const job = await getOwnedJob(owner,id);
  if (!['done','failed'].includes(job.status)) throw new Error('job_id: results are not ready');
  if (language && !job.languages.includes(language)) throw new Error('language: not part of this job');
  const results = job.results.filter((r) => !language || r.language === language);
  if (!results.length) throw new Error('language: no completed images to ZIP');
  const path = `${owner}/zips/${id}/${language || 'all'}.zip`;
  if (!await assetStore().getWithMetadata(path)) {
    const zip = new JSZip();
    for (const result of results) zip.file(`${result.language}/ad_${String(result.sourceIndex+1).padStart(2,'0')}.${result.path.split('.').pop() || 'png'}`,await getAsset(result.path));
    await saveAsset(path,await zip.generateAsync({type:'nodebuffer',compression:'STORE'}),'application/zip');
  }
  return {job_id:id,language:language || 'all',url:signedUrl(path),expires_in_days:30};
}
async function transientRetry<T>(work:()=>Promise<T>):Promise<T> {
  for (let attempt=0;;attempt++) {
    try { return await work(); }
    catch(error) {
      const msg=String(error instanceof Error?error.message:error);
      if (attempt>=2 || !/network error|fetch failed|timeout|timed out|HTTP (?:429|50[0-4])|temporarily unavailable/i.test(msg)) throw error;
      await new Promise((resolve) => setTimeout(resolve,800*(2**attempt)));
    }
  }
}
async function processOne(jobId:string,job:Job,sourceIndex:number,language:string):Promise<Item> {
  const memoryKey = `memory/${job.owner}`;
  const memoryData = await stateStore().get(memoryKey,{type:'json'}) as {translationMemory:TranslationMemoryEntry[];glossary:GlossaryStore}|null;
  const memory = memoryData?.translationMemory || [], glossary = memoryData?.glossary || {};
  const translated = await transientRetry(() => translateAd(job.sources[sourceIndex].kieUrl!,language,job.notes,process.env.KIE_API_KEY!,memory,glossary));
  let canonical!:ReturnType<typeof applyCanonicalMemory>;
  await updateJSON<{translationMemory:TranslationMemoryEntry[];glossary:GlossaryStore}>(stateStore(),memoryKey,(current) => {
    canonical=applyCanonicalMemory(language,translated.segments,current?.translationMemory || [],new Map());
    return {translationMemory:canonical.entries,glossary:current?.glossary || glossary};
  });
  const prompt = buildRenderPrompt(language,canonical.segments,job.notes);
  const taskId = await createTask(job.sources[sourceIndex].kieUrl!,job.aspectRatio,prompt,process.env.KIE_API_KEY!,job.model as 'gemini'|'chatgpt'|'grok');
  let imageUrl = await pollTask(taskId,process.env.KIE_API_KEY!);
  if (job.strictTextCheck) {
    try {
      const check = await verifyRenderedText(imageUrl,language,canonical.segments,process.env.KIE_API_KEY!);
      if (!check.matches) {
        const correction = `STRICT CORRECTION REQUIRED: ${check.issues.join('; ') || 'rendered copy differed from locked copy'}. Reproduce every EXACT REPLACEMENT character-for-character.`;
        const retryId = await createTask(job.sources[sourceIndex].kieUrl!,job.aspectRatio,buildRenderPrompt(language,canonical.segments,job.notes,correction),process.env.KIE_API_KEY!,job.model as 'gemini'|'chatgpt'|'grok');
        imageUrl=await pollTask(retryId,process.env.KIE_API_KEY!);
      }
    } catch(error) { console.warn('Text verification unavailable:',String(error)); }
  }
  const blob=await fetchResultBlob(imageUrl,process.env.KIE_API_KEY!);
  const mime=blob.type === 'image/jpeg' ? 'image/jpeg' : blob.type === 'image/webp' ? 'image/webp' : 'image/png';
  const ext=mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
  const path=`${job.owner}/results/${jobId}/${language}/ad_${sourceIndex+1}.${ext}`;
  await saveAsset(path,Buffer.from(await blob.arrayBuffer()),mime);
  return {sourceIndex,language,path,translated_text:canonical.segments};
}
export async function runJob(jobId:string,dispatch:(id:string)=>Promise<void>) {
  let claimed=false;
  try {
    await update(jobId,(job) => {
      if (['done','failed'].includes(job.status) || (job.status==='running' && (job.leaseUntil || 0)>Date.now())) throw new Error('job: already claimed');
      claimed=true; return {...job,status:'running',leaseUntil:Date.now()+14*60_000,updatedAt:now()};
    });
  } catch(error) { if (String(error).includes('already claimed')) return; throw error; }
  if (!claimed) return;
  const job=(await read(jobId))!;
  const completedKeys=new Set([...job.results.map((r)=>`${r.sourceIndex}:${r.language}`),...job.failures.map((r)=>`${r.sourceIndex}:${r.language}`)]);
  const todo=job.sources.flatMap((_,sourceIndex)=>job.languages.map((language)=>({sourceIndex,language})))
    .filter(({sourceIndex,language})=>!completedKeys.has(`${sourceIndex}:${language}`)).slice(0,3);
  const sourceErrors=new Map<number,string>();
  for (const sourceIndex of new Set(todo.map((item)=>item.sourceIndex))) {
    const source=job.sources[sourceIndex];
    try {
      if (!source.path) Object.assign(source,await storeImage(job.owner,await imageFromUrl(source.url)));
      if (!source.kieUrl) {
        const bytes=await getAsset(source.path!);
        const mime=source.path!.endsWith('.png')?'image/png':source.path!.endsWith('.webp')?'image/webp':'image/jpeg';
        source.kieUrl=await uploadImage(`data:${mime};base64,${bytes.toString('base64')}`,process.env.KIE_API_KEY!);
      }
    } catch(error) { sourceErrors.set(sourceIndex,`image_urls[${sourceIndex}]: ${String(error instanceof Error?error.message:error)}`); }
  }
  await update(jobId,(state)=>({...state,sources:job.sources,updatedAt:now()}));
  await Promise.all(todo.map(async ({sourceIndex,language})=>{
    let result:Item|null=null, failure='';
    try { if (sourceErrors.has(sourceIndex)) throw new Error(sourceErrors.get(sourceIndex)); result=await processOne(jobId,job,sourceIndex,language); }
    catch(error) { failure=String(error instanceof Error?error.message:error).slice(0,500); }
    await update(jobId,(state)=>{
      if (state.results.some((r)=>r.sourceIndex===sourceIndex&&r.language===language)||state.failures.some((r)=>r.sourceIndex===sourceIndex&&r.language===language)) return state;
      return {...state,results:result?[...state.results,result]:state.results,failures:failure?[...state.failures,{sourceIndex,language,error:failure}]:state.failures,completed:state.completed+1,updatedAt:now()};
    });
  }));
  const latest=(await read(jobId))!;
  if (latest.completed>=latest.total) await update(jobId,(state)=>({...state,status:state.failures.length?'failed':'done',leaseUntil:0,updatedAt:now()}));
  else { await update(jobId,(state)=>({...state,leaseUntil:0,updatedAt:now()})); await dispatch(jobId); }
}
export async function recoverJobs(dispatch:(id:string)=>Promise<void>) {
  const {blobs}=await jobsStore().list({prefix:'jobs/'});
  await Promise.all(blobs.slice(-50).map(async ({key})=>{
    const job=await jobsStore().get(key,{type:'json'}) as Job|null;
    if (job && ['queued','running'].includes(job.status) && (job.leaseUntil || 0)<Date.now()) await dispatch(key.slice(5));
  }));
}
