/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  BookOpen,
  CheckCircle2,
  Download,
  Edit3,
  FileDown,
  Globe,
  Image as ImageIcon,
  KeyRound,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import {
  applyCanonicalMemory,
  loadGlossary,
  loadTranslationMemory,
  memoryKey,
  saveGlossary,
  saveTranslationMemory,
  upsertApprovedTranslations,
  type FinalSegment,
  type GlossaryStore,
  type TranslationMemoryEntry,
} from './localization';
import { ASPECT_RATIOS, RECOMMENDED_COUNTRIES, CORE_MARKETS, COUNTRIES } from './options';
import {
  buildRenderPrompt,
  createTask,
  fetchResultBlob,
  IMAGE_MODELS,
  imageModelConfig,
  pollTask,
  translateAd,
  uploadImage,
  verifyRenderedText,
  type ImageModelId,
} from './kie';

const API_KEY_STORAGE = 'kie_api_key';

interface AdRef {
  id: string;
  dataUrl: string;
  instruction: string;
}

type StrictStatus = 'off' | 'checking' | 'passed' | 'retried' | 'unavailable';

interface Result {
  id: string;
  market: string;
  referenceIndex: number;
  loading: boolean;
  stageLabel: string;
  image: string | null;
  error: string | null;
  modelId: ImageModelId;
  ratio: string;
  sourceUrl?: string;
  instructions?: string;
  segments?: FinalSegment[];
  translationNote?: string;
  memoryHits?: number;
  strictStatus?: StrictStatus;
}

function ratioClass(ratio: string): string {
  return ASPECT_RATIOS.find((item) => item.value === ratio)?.css || 'aspect-[4/5]';
}

function safeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

async function runWithConcurrency(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
  let index = 0;
  async function worker() {
    while (index < tasks.length) {
      const taskIndex = index++;
      await tasks[taskIndex]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
}

export default function App() {
  const [apiKey, setApiKey] = useState('');
  const [keyInput, setKeyInput] = useState('');
  const [showKeyDialog, setShowKeyDialog] = useState(false);
  const [selectedMarkets, setSelectedMarkets] = useState<string[]>([]);
  const [results, setResults] = useState<Result[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [uploadedReferences, setUploadedReferences] = useState<AdRef[]>([]);
  const [imageModel, setImageModel] = useState<ImageModelId>('gemini');
  const [aspectRatio, setAspectRatio] = useState('4:5');
  const [additionalInstructions, setAdditionalInstructions] = useState('');
  const [countrySearch, setCountrySearch] = useState('');
  const [showCountryDropdown, setShowCountryDropdown] = useState(false);
  const [activeCountryIndex, setActiveCountryIndex] = useState(-1);
  const [zipStatus, setZipStatus] = useState<string | null>(null);
  const [strictTextCheck, setStrictTextCheck] = useState(false);
  const [translationMemory, setTranslationMemory] = useState<TranslationMemoryEntry[]>([]);
  const [glossary, setGlossary] = useState<GlossaryStore>({});
  const [showLibrary, setShowLibrary] = useState(false);
  const [librarySearch, setLibrarySearch] = useState('');
  const [libraryMarket, setLibraryMarket] = useState('All');
  const [glossaryMarket, setGlossaryMarket] = useState('Global');
  const [editingResultId, setEditingResultId] = useState<string | null>(null);
  const [draftSegments, setDraftSegments] = useState<FinalSegment[]>([]);

  const memoryRef = useRef<TranslationMemoryEntry[]>([]);
  const sessionCanonicalRef = useRef(new Map<string, string>());

  useEffect(() => {
    const storedKey = localStorage.getItem(API_KEY_STORAGE) || '';
    setApiKey(storedKey);
    const storedMemory = loadTranslationMemory();
    setTranslationMemory(storedMemory);
    memoryRef.current = storedMemory;
    setGlossary(loadGlossary());
  }, []);

  const persistMemory = (entries: TranslationMemoryEntry[]) => {
    memoryRef.current = entries;
    setTranslationMemory(entries);
    saveTranslationMemory(entries);
  };

  const patchResult = (id: string, fields: Partial<Result>) => {
    setResults((current) => current.map((result) => result.id === id ? { ...result, ...fields } : result));
  };

  const filteredCountries = useMemo(() => {
    const search = countrySearch.toLowerCase();
    return COUNTRIES
      .filter((country) => !selectedMarkets.includes(country) && country.toLowerCase().includes(search))
      .sort((a, b) => {
        const recommendedDifference = Number(RECOMMENDED_COUNTRIES.includes(b)) - Number(RECOMMENDED_COUNTRIES.includes(a));
        return recommendedDifference || a.localeCompare(b);
      });
  }, [countrySearch, selectedMarkets]);

  const groupedMarkets = useMemo(() => Array.from(new Set(results.map((result) => result.market))), [results]);
  const editingResult = results.find((result) => result.id === editingResultId) || null;

  const saveKey = () => {
    const trimmed = keyInput.trim();
    if (!trimmed) return;
    localStorage.setItem(API_KEY_STORAGE, trimmed);
    setApiKey(trimmed);
    setKeyInput('');
    setShowKeyDialog(false);
  };

  const clearKey = () => {
    localStorage.removeItem(API_KEY_STORAGE);
    setApiKey('');
    setKeyInput('');
  };

  const handleImageUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    files.forEach((file) => {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
        window.alert(`Unsupported format: ${file.name}. Please upload PNG, JPEG or WebP.`);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result !== 'string') return;
        const dataUrl = reader.result;
        setUploadedReferences((current) => [...current, {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          dataUrl,
          instruction: '',
        }]);
      };
      reader.readAsDataURL(file);
    });
    event.target.value = '';
  };

  const renderLocalizedImage = async (result: Result, segments: FinalSegment[]): Promise<{ image: string; strictStatus: StrictStatus }> => {
    if (!result.sourceUrl) throw new Error('Original upload URL is no longer available. Start a new campaign.');
    const prompt = buildRenderPrompt(result.market, segments, result.instructions || '');
    const taskId = await createTask(result.sourceUrl, result.ratio, prompt, apiKey, result.modelId);
    let image = await pollTask(taskId, apiKey);
    let strictStatus: StrictStatus = 'off';

    if (strictTextCheck) {
      strictStatus = 'checking';
      patchResult(result.id, { stageLabel: 'Checking exact text…', strictStatus });
      try {
        const verification = await verifyRenderedText(image, result.market, segments, apiKey);
        if (verification.matches) {
          strictStatus = 'passed';
        } else {
          patchResult(result.id, { stageLabel: 'Fixing text mismatch…' });
          const correction = `STRICT CORRECTION REQUIRED: the previous render contained these text mismatches: ${verification.issues.join('; ') || 'rendered copy differed from the locked copy'}. Re-render from the supplied source image and reproduce every EXACT REPLACEMENT character-for-character.`;
          const retryTask = await createTask(result.sourceUrl, result.ratio, buildRenderPrompt(result.market, segments, result.instructions || '', correction), apiKey, result.modelId);
          image = await pollTask(retryTask, apiKey);
          strictStatus = 'retried';
        }
      } catch (error) {
        console.warn('Strict text verification unavailable:', error);
        strictStatus = 'unavailable';
      }
    }
    return { image, strictStatus };
  };

  const handleGenerate = async () => {
    if (!apiKey) {
      setKeyInput('');
      setShowKeyDialog(true);
      return;
    }
    if (!uploadedReferences.length || !selectedMarkets.length) return;

    setIsGenerating(true);
    sessionCanonicalRef.current = new Map(memoryRef.current.map((entry) => [memoryKey(entry.market, entry.source), entry.target]));

    const batchId = Date.now();
    const initialResults: Result[] = selectedMarkets.flatMap((market) =>
      uploadedReferences.map((_, referenceIndex) => ({
        id: `${batchId}-${market}-${referenceIndex}`,
        market,
        referenceIndex,
        loading: true,
        stageLabel: 'Queued…',
        image: null,
        error: null,
        modelId: imageModel,
        ratio: aspectRatio,
        strictStatus: strictTextCheck ? 'checking' : 'off',
      })),
    );
    setResults(initialResults);

    try {
      const uploads = await Promise.all(uploadedReferences.map(async (reference) => {
        try { return { url: await uploadImage(reference.dataUrl, apiKey), error: '' }; }
        catch (error: any) { return { url: '', error: String(error?.message || error) }; }
      }));

      const tasks: Array<() => Promise<void>> = [];
      initialResults.forEach((seed) => {
        const upload = uploads[seed.referenceIndex];
        if (!upload?.url) {
          patchResult(seed.id, { loading: false, error: upload?.error || 'Upload failed.' });
          return;
        }
        const reference = uploadedReferences[seed.referenceIndex];
        const instructions = [additionalInstructions.trim(), reference?.instruction.trim()].filter(Boolean).join('\n');

        tasks.push(async () => {
          try {
            patchResult(seed.id, { stageLabel: 'Native translation…', sourceUrl: upload.url, instructions });
            const translated = await translateAd(upload.url, seed.market, instructions, apiKey, memoryRef.current, glossary);
            const canonicalized = applyCanonicalMemory(seed.market, translated.segments, memoryRef.current, sessionCanonicalRef.current);
            persistMemory(canonicalized.entries);
            patchResult(seed.id, {
              stageLabel: 'Generating image…',
              segments: canonicalized.segments,
              translationNote: translated.summary,
              memoryHits: canonicalized.memoryHits,
            });

            const liveResult: Result = {
              ...seed,
              sourceUrl: upload.url,
              instructions,
              segments: canonicalized.segments,
            };
            const rendered = await renderLocalizedImage(liveResult, canonicalized.segments);
            patchResult(seed.id, {
              loading: false,
              image: rendered.image,
              error: null,
              strictStatus: rendered.strictStatus,
            });
          } catch (error: any) {
            const message = String(error?.message || 'Unknown error');
            if (/401|unauthorized/i.test(message)) setShowKeyDialog(true);
            patchResult(seed.id, { loading: false, error: message.slice(0, 180) });
          }
        });
      });

      await runWithConcurrency(tasks, 8);
    } finally {
      setIsGenerating(false);
    }
  };

  const fileNameFor = (result: Result) => `${safeName(result.market)}_ad_${String(result.referenceIndex + 1).padStart(2, '0')}.png`;

  const downloadSingle = async (result: Result) => {
    if (!result.image) return;
    setZipStatus(`Downloading ${result.market}…`);
    try {
      const blob = await fetchResultBlob(result.image, apiKey);
      saveAs(blob, fileNameFor(result));
      setZipStatus('Downloaded');
    } catch {
      window.open(result.image, '_blank', 'noopener,noreferrer');
      setZipStatus('Opened image — use Save Image if needed');
    }
    window.setTimeout(() => setZipStatus(null), 3000);
  };

  const downloadZip = async (ready: Result[], name: string, folders: boolean) => {
    if (!ready.length) {
      setZipStatus('Nothing ready to download');
      window.setTimeout(() => setZipStatus(null), 2500);
      return;
    }
    if (ready.length === 1 && ready[0].image) {
      await downloadSingle(ready[0]);
      return;
    }

    const zip = new JSZip();
    let completed = 0;
    let saved = 0;
    for (const result of ready) {
      setZipStatus(`Preparing ${completed}/${ready.length}…`);
      try {
        const blob = await fetchResultBlob(result.image!, apiKey);
        const path = folders ? `${safeName(result.market)}/${fileNameFor(result)}` : fileNameFor(result);
        zip.file(path, blob);
        saved += 1;
      } catch (error) {
        console.error('Download failed:', result.market, error);
      }
      completed += 1;
    }
    if (!saved) {
      setZipStatus('Download failed');
    } else {
      setZipStatus('Creating ZIP…');
      saveAs(await zip.generateAsync({ type: 'blob' }), name);
      setZipStatus(saved === ready.length ? `Downloaded ${saved} images` : `Downloaded ${saved}/${ready.length}`);
    }
    window.setTimeout(() => setZipStatus(null), 3500);
  };

  const openTranslationEditor = (result: Result) => {
    setEditingResultId(result.id);
    setDraftSegments((result.segments || []).map((segment) => ({ ...segment })));
  };

  const approveDraft = (rerender: boolean) => {
    if (!editingResult) return;
    const cleaned = draftSegments.map((segment) => ({ ...segment, final: segment.final.trim() })).filter((segment) => segment.final);
    const nextMemory = upsertApprovedTranslations(memoryRef.current, editingResult.market, cleaned);
    persistMemory(nextMemory);
    patchResult(editingResult.id, { segments: cleaned, translationNote: 'Approved and locked by you.', memoryHits: cleaned.length });
    setEditingResultId(null);
    if (rerender) {
      const nextResult = { ...editingResult, segments: cleaned, loading: true, image: null, error: null, stageLabel: 'Re-rendering approved copy…' };
      patchResult(editingResult.id, nextResult);
      void renderLocalizedImage(nextResult, cleaned)
        .then((rendered) => patchResult(editingResult.id, { loading: false, image: rendered.image, strictStatus: rendered.strictStatus }))
        .catch((error: any) => patchResult(editingResult.id, { loading: false, error: String(error?.message || error).slice(0, 180) }));
    }
  };

  const updateMemoryEntry = (id: string, changes: Partial<TranslationMemoryEntry>) => {
    persistMemory(memoryRef.current.map((entry) => entry.id === id ? { ...entry, ...changes, updatedAt: new Date().toISOString() } : entry));
  };

  const removeMemoryEntry = (id: string) => persistMemory(memoryRef.current.filter((entry) => entry.id !== id));

  const updateGlossary = (value: string) => {
    const next = { ...glossary, [glossaryMarket]: value };
    setGlossary(next);
    saveGlossary(next);
  };

  const exportLanguageData = () => {
    const blob = new Blob([JSON.stringify({ version: 1, translationMemory: memoryRef.current, glossary }, null, 2)], { type: 'application/json' });
    saveAs(blob, 'ad-localizer-language-library.json');
  };

  const importLanguageData = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result || '{}'));
        if (Array.isArray(parsed.translationMemory)) persistMemory(parsed.translationMemory);
        if (parsed.glossary && typeof parsed.glossary === 'object') {
          setGlossary(parsed.glossary);
          saveGlossary(parsed.glossary);
        }
      } catch {
        window.alert('This is not a valid Ad Localizer language-library file.');
      }
    };
    reader.readAsText(file);
    event.target.value = '';
  };

  const resetCampaign = () => {
    setSelectedMarkets([]);
    setResults([]);
    setUploadedReferences([]);
  };

  const visibleMemory = translationMemory.filter((entry) => {
    const marketMatch = libraryMarket === 'All' || entry.market === libraryMarket;
    const query = librarySearch.toLowerCase().trim();
    return marketMatch && (!query || entry.source.toLowerCase().includes(query) || entry.target.toLowerCase().includes(query));
  });

  return (
    <main className="grid grid-cols-1 lg:grid-cols-2 min-h-screen bg-[#f5f5f4] text-[#0a0a0a] font-sans">
      <section className="p-8 lg:p-14 xl:p-16 pt-8 border-r border-black/10">
        <div className="flex items-start justify-between gap-4 mb-8">
          <div>
            <h1 className="text-[46px] xl:text-[62px] font-semibold tracking-tight leading-[0.88]">Ad Localizer</h1>
            <span className="text-[10px] text-gray-400 font-semibold tracking-wide">v3.4</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <a href="/bot.html" className="px-3 py-2 rounded-full border border-black/20 text-[10px] font-bold uppercase tracking-widest">Bot API</a>
            <button onClick={() => setShowLibrary(true)} className="flex items-center gap-2 px-3 py-2 rounded-full border border-black/20 text-[10px] font-bold uppercase tracking-widest hover:bg-white" title="Translation Library">
              <BookOpen className="w-3.5 h-3.5" />
              {translationMemory.length}
            </button>
            <button onClick={() => { setKeyInput(apiKey); setShowKeyDialog(true); }} className={`flex items-center gap-2 px-3 py-2 rounded-full border text-[10px] font-bold uppercase tracking-widest ${apiKey ? 'border-green-600 text-green-700 hover:bg-green-50' : 'border-red-500 text-red-600 hover:bg-red-50'}`}>
              <KeyRound className="w-3.5 h-3.5" /> {apiKey ? 'Key Set' : 'Set Key'}
            </button>
          </div>
        </div>

        <div className="space-y-6 max-w-lg">
          <div>
            <label className="block text-xs font-bold uppercase tracking-widest mb-4">1. Upload Your Ads</label>
            {uploadedReferences.length ? (
              <div className="space-y-3">
                {uploadedReferences.map((reference, index) => (
                  <div key={reference.id} className="flex gap-3 items-start p-2 rounded-lg border border-gray-200 bg-white/70">
                    <img src={reference.dataUrl} alt={`Ad ${index + 1}`} className="w-16 h-16 shrink-0 object-cover rounded-md border border-gray-200" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[10px] font-bold uppercase tracking-widest text-gray-500">Ad {index + 1}</span>
                        <button onClick={() => setUploadedReferences((current) => current.filter((item) => item.id !== reference.id))} className="text-gray-400 hover:text-black"><X className="w-3.5 h-3.5" /></button>
                      </div>
                      <textarea value={reference.instruction} onChange={(event) => setUploadedReferences((current) => current.map((item) => item.id === reference.id ? { ...item, instruction: event.target.value } : item))} placeholder="Instructions for this ad (optional)…" className="w-full bg-transparent border border-gray-300 rounded-md p-2 text-xs focus:border-black focus:outline-none resize-none h-14" />
                    </div>
                  </div>
                ))}
                <label htmlFor="ad-upload-more" className="flex items-center justify-center gap-2 w-full py-3 border-2 border-dashed border-gray-300 rounded-lg cursor-pointer hover:border-black hover:bg-white">
                  <Upload className="w-4 h-4 text-gray-400" /><span className="text-[10px] text-gray-500 font-bold uppercase tracking-widest">Add More</span>
                  <input id="ad-upload-more" type="file" multiple accept="image/png,image/jpeg,image/webp" onChange={handleImageUpload} className="hidden" />
                </label>
              </div>
            ) : (
              <label htmlFor="ad-upload" className="flex flex-col items-center justify-center w-full h-32 border-2 border-dashed border-gray-300 rounded-lg cursor-pointer hover:border-black hover:bg-white">
                <Upload className="w-8 h-8 text-gray-400 mb-2" /><span className="text-sm text-gray-500">Click to upload ad images</span>
                <input id="ad-upload" type="file" multiple accept="image/png,image/jpeg,image/webp" onChange={handleImageUpload} className="hidden" />
              </label>
            )}
          </div>

          <div className="relative">
            <div className="flex justify-between items-center mb-4">
              <label className="text-xs font-bold uppercase tracking-widest">2. Target Market</label>
              <button onClick={() => setSelectedMarkets((current) => Array.from(new Set([...current, ...CORE_MARKETS])))} className="text-[10px] uppercase font-bold tracking-widest px-2 py-1 bg-blue-50 text-blue-700 hover:bg-blue-100 rounded">+ Select CEE Markets</button>
            </div>
            {!!selectedMarkets.length && <div className="flex flex-wrap gap-2 mb-3">{selectedMarkets.map((market) => <span key={market} className="inline-flex items-center gap-1 px-3 py-1.5 bg-black text-white text-sm rounded-full">{market}<button onClick={() => setSelectedMarkets((current) => current.filter((item) => item !== market))} className="ml-1 hover:bg-white/20 rounded-full p-0.5"><X className="w-3 h-3" /></button></span>)}</div>}
            <div className="relative" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setShowCountryDropdown(false); }}>
              <input className="w-full bg-transparent border-b-2 border-black pb-2 focus:outline-none text-lg placeholder:text-gray-400" placeholder="Type to search countries…" value={countrySearch} onChange={(event) => { setCountrySearch(event.target.value); setShowCountryDropdown(true); setActiveCountryIndex(-1); }} onFocus={() => setShowCountryDropdown(true)} onKeyDown={(event) => {
                const shown = filteredCountries.slice(0, 15);
                if (event.key === 'ArrowDown') { event.preventDefault(); setActiveCountryIndex((current) => Math.min(current + 1, shown.length - 1)); }
                if (event.key === 'ArrowUp') { event.preventDefault(); setActiveCountryIndex((current) => Math.max(current - 1, 0)); }
                if (event.key === 'Enter' && activeCountryIndex >= 0 && shown[activeCountryIndex]) { event.preventDefault(); setSelectedMarkets((current) => [...current, shown[activeCountryIndex]]); setCountrySearch(''); setShowCountryDropdown(false); setActiveCountryIndex(-1); }
                if (event.key === 'Escape') setShowCountryDropdown(false);
              }} />
              {showCountryDropdown && <div className="absolute z-50 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-xl max-h-64 overflow-y-auto">
                {filteredCountries.slice(0, 15).map((country, index) => <button key={country} onMouseDown={(event) => event.preventDefault()} onClick={() => { setSelectedMarkets((current) => [...current, country]); setCountrySearch(''); setShowCountryDropdown(false); }} className={`w-full px-4 py-2.5 text-left text-sm flex justify-between hover:bg-gray-100 ${activeCountryIndex === index ? 'bg-gray-100' : ''}`}><span>{country}</span>{RECOMMENDED_COUNTRIES.includes(country) && !countrySearch && <span className="text-[9px] bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded font-bold uppercase">Recommended</span>}</button>)}
                {!filteredCountries.length && <div className="px-4 py-3 text-sm text-gray-500">No matching countries</div>}
              </div>}
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold uppercase tracking-widest mb-3">3. Image Model</label>
            <div className="grid grid-cols-3 gap-2">
              {IMAGE_MODELS.map((model) => <button key={model.id} onClick={() => setImageModel(model.id)} className={`p-3 rounded-lg border text-left transition-colors ${imageModel === model.id ? 'bg-black text-white border-black' : 'bg-white/50 border-gray-300 hover:border-black'}`}><span className="block text-sm font-bold">{model.label}</span><span className={`block text-[10px] mt-0.5 ${imageModel === model.id ? 'text-white/60' : 'text-gray-400'}`}>{model.detail}</span></button>)}
            </div>
            {imageModel !== 'gemini' && aspectRatio === '4:5' && <p className="text-[10px] text-amber-700 mt-2">4:5 uses source-ratio mode for this provider to prevent ratio errors.</p>}
          </div>

          <div>
            <label className="block text-xs font-bold uppercase tracking-widest mb-3">4. Aspect Ratio</label>
            <div className="flex flex-wrap gap-2">{ASPECT_RATIOS.map((ratio) => <button key={ratio.value} onClick={() => setAspectRatio(ratio.value)} className={`px-4 py-2 rounded-full border border-black text-sm ${aspectRatio === ratio.value ? 'bg-black text-white' : 'hover:bg-black/5'}`}>{ratio.label}</button>)}</div>
          </div>

          <div>
            <label className="block text-xs font-bold uppercase tracking-widest mb-1">5. Global Instructions (Optional)</label>
            <textarea className="w-full bg-transparent border-2 border-gray-300 rounded-lg p-3 focus:border-black focus:outline-none text-sm resize-none h-20" placeholder="e.g. Keep product package text unchanged…" value={additionalInstructions} onChange={(event) => setAdditionalInstructions(event.target.value)} />
          </div>

          <div className="rounded-xl border border-green-200 bg-green-50 p-3 flex items-start gap-3">
            <ShieldCheck className="w-5 h-5 text-green-700 shrink-0 mt-0.5" />
            <div><span className="block text-xs font-bold uppercase tracking-widest text-green-900">Consistency Engine On</span><span className="block text-[11px] text-green-800 mt-1">One deterministic native pass, glossary rules and saved canonical translations. No extra language pass.</span></div>
          </div>

          <button type="button" onClick={() => setStrictTextCheck((current) => !current)} className="w-full flex items-center justify-between gap-3 p-3 rounded-lg border border-gray-300 hover:border-black text-left">
            <span><span className="block text-xs font-bold uppercase tracking-widest">Strict Image Text Check</span><span className="block text-[10px] text-gray-400 mt-0.5">Optional. Checks the rendered image and retries once on mismatch. Slower only when enabled.</span></span>
            <span className={`shrink-0 w-11 h-6 rounded-full relative ${strictTextCheck ? 'bg-black' : 'bg-gray-300'}`}><span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full transition-all ${strictTextCheck ? 'left-[22px]' : 'left-0.5'}`} /></span>
          </button>

          <button onClick={handleGenerate} disabled={isGenerating || !uploadedReferences.length || !selectedMarkets.length} className="w-full py-5 bg-black text-white font-bold text-sm uppercase tracking-widest flex items-center justify-center gap-3 disabled:opacity-30 hover:bg-black/80">
            {isGenerating ? <Loader2 className="animate-spin w-5 h-5" /> : <Globe className="w-5 h-5" />}{isGenerating ? 'Generating…' : 'Localize'}
          </button>
        </div>
      </section>

      <section className="bg-white relative h-screen overflow-hidden flex flex-col">
        {results.length ? <>
          <div className="absolute top-6 right-6 flex items-center gap-3 z-30">
            {zipStatus && <span className="px-3 py-2 bg-black text-white text-[10px] font-bold uppercase tracking-widest rounded-full shadow-lg">{zipStatus}</span>}
            <button onClick={() => void downloadZip(results.filter((result) => result.image), 'localized_ads_all_markets.zip', true)} className="w-12 h-12 rounded-full border border-black flex items-center justify-center hover:bg-black/5 bg-white" title="Download all markets"><Archive className="w-5 h-5" /></button>
            <button onClick={resetCampaign} className="w-12 h-12 rounded-full border border-black flex items-center justify-center hover:bg-black/5 bg-white" title="New campaign"><RefreshCw className="w-5 h-5" /></button>
          </div>
          <div className="flex-1 overflow-y-auto p-8 lg:p-12 pt-24 space-y-12">
            {groupedMarkets.map((market) => {
              const marketResults = results.filter((result) => result.market === market);
              const ready = marketResults.filter((result) => result.image);
              return <div key={market}>
                <div className="flex items-end justify-between gap-4 pb-4 mb-5 border-b border-gray-200">
                  <div><h2 className="text-2xl font-bold tracking-tight">{market}</h2><p className="text-[10px] uppercase font-bold tracking-widest text-gray-400 mt-1">{ready.length}/{marketResults.length} ready</p></div>
                  <button disabled={!ready.length} onClick={() => void downloadZip(ready, `${safeName(market)}_localized_ads.zip`, false)} className="flex items-center gap-2 px-4 py-2 rounded-full border border-black text-[10px] font-bold uppercase tracking-widest disabled:opacity-30 hover:bg-black hover:text-white"><Archive className="w-3.5 h-3.5" />Download {market}</button>
                </div>
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
                  {marketResults.map((result) => <div key={result.id} className="rounded-xl overflow-hidden border border-gray-200 bg-gray-50">
                    <div className="flex items-center justify-between gap-3 px-4 py-3 bg-white border-b border-gray-200">
                      <div><span className="block text-xs font-bold uppercase tracking-widest">{result.market} <span className="text-gray-400">Ad {result.referenceIndex + 1}</span></span><span className="block text-[10px] text-gray-400 mt-1">{imageModelConfig(result.modelId).label} · {result.ratio}{result.memoryHits ? ` · ${result.memoryHits} memory match${result.memoryHits === 1 ? '' : 'es'}` : ''}</span></div>
                      <div className="flex items-center gap-2">
                        {!!result.segments?.length && <button onClick={() => openTranslationEditor(result)} className="w-9 h-9 rounded-full border border-gray-300 flex items-center justify-center bg-white hover:border-black" title="View or edit translation"><Edit3 className="w-3.5 h-3.5" /></button>}
                        {result.image && <button onClick={() => void downloadSingle(result)} className="w-9 h-9 rounded-full border border-black flex items-center justify-center bg-white hover:bg-black/5" title="Download image"><Download className="w-4 h-4" /></button>}
                      </div>
                    </div>
                    {result.loading ? <div className={`${ratioClass(result.ratio)} flex flex-col items-center justify-center text-gray-400 gap-4`}><Loader2 className="w-8 h-8 animate-spin" /><span className="text-xs uppercase tracking-widest font-bold text-center px-4">{result.stageLabel}</span></div>
                      : result.image ? <><img src={result.image} alt={`${result.market} Ad ${result.referenceIndex + 1}`} className="w-full object-contain" /><div className="flex flex-wrap items-center gap-2 px-4 py-3 bg-white border-t border-gray-200 text-[10px] font-bold uppercase tracking-widest"><span className="inline-flex items-center gap-1 text-green-700"><CheckCircle2 className="w-3.5 h-3.5" />Copy locked</span>{result.strictStatus === 'passed' && <span className="text-blue-700">· Exact text verified</span>}{result.strictStatus === 'retried' && <span className="text-amber-700">· Text corrected once</span>}{result.strictStatus === 'unavailable' && <span className="text-gray-400">· Check unavailable</span>}</div></>
                      : <div className={`${ratioClass(result.ratio)} flex flex-col items-center justify-center text-red-500 text-xs gap-2 px-6 text-center`}><span className="font-bold uppercase tracking-widest">Failed — {result.market} / Ad {result.referenceIndex + 1}</span><span className="text-[10px] text-red-400 normal-case">{result.error}</span></div>}
                  </div>)}
                </div>
              </div>;
            })}
          </div>
        </> : <div className="flex-1 flex items-center justify-center p-12 relative"><div className="absolute inset-0 opacity-5 pointer-events-none" style={{ backgroundImage: 'radial-gradient(#0a0a0a 1px, transparent 1px)', backgroundSize: '24px 24px' }} /><div className="text-center max-w-sm relative"><div className="w-24 h-24 mx-auto border border-black rounded-full flex items-center justify-center mb-8"><ImageIcon className="w-8 h-8" /></div><h3 className="text-xl font-semibold mb-2">Ready to Localize</h3><p className="text-gray-500 text-sm">Upload a master creative, choose markets and generate consistent native-language versions.</p></div></div>}
      </section>

      {showKeyDialog && <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"><div className="max-w-md w-full bg-white rounded-2xl shadow-2xl p-8"><button onClick={() => setShowKeyDialog(false)} className="float-right text-gray-400 hover:text-black"><X /></button><div className="w-16 h-16 mx-auto border-2 border-black rounded-full flex items-center justify-center mb-6"><KeyRound className="w-6 h-6" /></div><h2 className="text-2xl font-bold mb-3 text-center">kie.ai API Key</h2><p className="text-gray-600 mb-4 text-sm text-center">Stored only in this browser.</p><input type="password" value={keyInput} onChange={(event) => setKeyInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') saveKey(); }} placeholder="sk-…" className="w-full border-2 border-gray-300 rounded-lg p-3 focus:border-black focus:outline-none text-sm mb-4" /><button onClick={saveKey} disabled={!keyInput.trim()} className="w-full py-4 bg-black text-white font-bold text-sm uppercase tracking-widest rounded-lg disabled:opacity-30">Save Key</button>{apiKey && <button onClick={clearKey} className="w-full py-3 text-red-500 text-xs uppercase tracking-widest font-bold">Remove stored key</button>}</div></div>}

      {editingResult && <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"><div className="max-w-3xl w-full max-h-[90vh] overflow-y-auto bg-white rounded-2xl shadow-2xl p-7"><div className="flex items-start justify-between gap-4 mb-5"><div><h2 className="text-2xl font-bold">Locked Translation</h2><p className="text-sm text-gray-500 mt-1">{editingResult.market} · Ad {editingResult.referenceIndex + 1}</p></div><button onClick={() => setEditingResultId(null)} className="text-gray-400 hover:text-black"><X /></button></div><div className="space-y-3">{draftSegments.map((segment, index) => <div key={`${segment.original}-${index}`} className="grid grid-cols-1 md:grid-cols-2 gap-3 p-3 border border-gray-200 rounded-xl"><div><span className="block text-[9px] font-bold uppercase tracking-widest text-gray-400 mb-1">Original · {segment.role || 'text'}</span><p className="text-sm leading-relaxed">{segment.original}</p></div><div><span className="block text-[9px] font-bold uppercase tracking-widest text-gray-400 mb-1">Final exact copy</span><textarea value={segment.final} onChange={(event) => setDraftSegments((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, final: event.target.value } : item))} className="w-full min-h-20 border border-gray-300 rounded-lg p-2 text-sm focus:border-black focus:outline-none" /></div></div>)}</div><div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-6"><button onClick={() => approveDraft(false)} className="py-3 border border-black rounded-lg font-bold text-xs uppercase tracking-widest hover:bg-black/5"><ShieldCheck className="inline w-4 h-4 mr-2" />Approve &amp; Lock</button><button onClick={() => approveDraft(true)} className="py-3 bg-black text-white rounded-lg font-bold text-xs uppercase tracking-widest hover:bg-black/80"><RefreshCw className="inline w-4 h-4 mr-2" />Save &amp; Re-render</button></div></div></div>}

      {showLibrary && <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"><div className="max-w-5xl w-full max-h-[92vh] overflow-hidden bg-white rounded-2xl shadow-2xl flex flex-col"><div className="flex items-start justify-between gap-4 p-6 border-b border-gray-200"><div><h2 className="text-2xl font-bold">Translation Library</h2><p className="text-sm text-gray-500 mt-1">Saved phrases are reused exactly. Approved phrases always stay locked.</p></div><button onClick={() => setShowLibrary(false)} className="text-gray-400 hover:text-black"><X /></button></div><div className="grid grid-cols-1 lg:grid-cols-[1.4fr_1fr] min-h-0 flex-1 overflow-hidden">
        <div className="p-5 border-r border-gray-200 overflow-y-auto"><div className="flex flex-col sm:flex-row gap-2 mb-4"><input value={librarySearch} onChange={(event) => setLibrarySearch(event.target.value)} placeholder="Search source or translation…" className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-black focus:outline-none" /><select value={libraryMarket} onChange={(event) => setLibraryMarket(event.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm"><option>All</option>{COUNTRIES.filter((country) => translationMemory.some((entry) => entry.market === country)).map((country) => <option key={country}>{country}</option>)}</select></div><div className="space-y-3">{visibleMemory.map((entry) => <div key={entry.id} className="border border-gray-200 rounded-xl p-3"><div className="flex justify-between gap-3 mb-2"><span className="text-[10px] font-bold uppercase tracking-widest text-gray-500">{entry.market} · {entry.status}</span><button onClick={() => removeMemoryEntry(entry.id)} className="text-gray-400 hover:text-red-500"><Trash2 className="w-3.5 h-3.5" /></button></div><p className="text-xs text-gray-500 mb-2">{entry.source}</p><textarea value={entry.target} onChange={(event) => updateMemoryEntry(entry.id, { target: event.target.value })} className="w-full border border-gray-300 rounded-lg p-2 text-sm focus:border-black focus:outline-none" /><button onClick={() => updateMemoryEntry(entry.id, { status: 'approved' })} className={`mt-2 text-[10px] font-bold uppercase tracking-widest ${entry.status === 'approved' ? 'text-green-700' : 'text-blue-700 hover:underline'}`}>{entry.status === 'approved' ? '✓ Approved & locked' : 'Approve & lock'}</button></div>)}{!visibleMemory.length && <p className="text-sm text-gray-400 text-center py-12">No saved translations yet.</p>}</div></div>
        <div className="p-5 overflow-y-auto bg-gray-50"><h3 className="text-xs font-bold uppercase tracking-widest mb-2">Custom Glossary</h3><p className="text-xs text-gray-500 mb-4">One rule per line. Use <strong>source = target</strong>, <strong>source = KEEP</strong>, or plain-language rules.</p><select value={glossaryMarket} onChange={(event) => setGlossaryMarket(event.target.value)} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-3"><option>Global</option>{COUNTRIES.map((country) => <option key={country}>{country}</option>)}</select><textarea value={glossary[glossaryMarket] || ''} onChange={(event) => updateGlossary(event.target.value)} placeholder={'Alpine Sleep = KEEP\npatch = flaster\nBuy 2, Get 1 Free = Kupi 2, treći dobivaš GRATIS'} className="w-full h-64 border border-gray-300 rounded-xl p-3 text-sm focus:border-black focus:outline-none resize-y" /><p className="text-[10px] text-gray-400 mt-2">Saved instantly in this browser and applied before every image generation.</p><div className="grid grid-cols-2 gap-2 mt-5"><button onClick={exportLanguageData} className="py-3 border border-black rounded-lg text-[10px] font-bold uppercase tracking-widest hover:bg-white"><FileDown className="inline w-4 h-4 mr-1" />Export</button><label className="py-3 border border-black rounded-lg text-[10px] font-bold uppercase tracking-widest hover:bg-white text-center cursor-pointer"><Upload className="inline w-4 h-4 mr-1" />Import<input type="file" accept="application/json" onChange={importLanguageData} className="hidden" /></label></div></div>
      </div></div></div>}
    </main>
  );
}
