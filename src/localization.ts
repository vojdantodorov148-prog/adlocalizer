export interface MarketGuide {
  language: string;
  note: string;
}

export interface FinalSegment {
  original: string;
  final: string;
  role?: string;
}

export type TranslationStatus = 'generated' | 'approved';

export interface TranslationMemoryEntry {
  id: string;
  market: string;
  source: string;
  sourceNormalized: string;
  target: string;
  status: TranslationStatus;
  updatedAt: string;
}

export type GlossaryStore = Record<string, string>;

export const TRANSLATION_MEMORY_KEY = 'ad_localizer_translation_memory_v1';
export const GLOSSARY_KEY = 'ad_localizer_glossary_v1';

export const MARKET_COPY_GUIDE: Record<string, MarketGuide> = {
  'North Macedonia': { language: 'Macedonian (standard Cyrillic)', note: 'Use natural standard Macedonian, never Serbian or Bulgarian constructions. Prefer „слабеење“, „природни состојки“ and „фластер“ where accurate. Use a warm, conversational direct-response tone and the form of address requested by the source or instructions.' },
  'Bulgaria': { language: 'Bulgarian (Cyrillic)', note: 'Natural Bulgarian DTC copy. Avoid Russianisms and word-for-word English structures. Use correct Bulgarian terminology and punctuation.' },
  'Serbia': { language: 'Serbian (Latin script unless explicitly requested otherwise)', note: 'Natural Serbian, not Croatian. Friendly and direct; preserve the source form of address.' },
  'Croatia': { language: 'Croatian (Latin script with č ć š ž đ)', note: 'Use native Croatian, never Serbian/Bosnian variants. Prefer „tijekom“, „učinak“, „mršavljenje“, „flaster“ and „prirodni sastojci“ where accurate. Keep it concise and natural for a Croatian ecommerce ad.' },
  'Slovenia': { language: 'Slovenian (Latin script with č š ž)', note: 'Natural Slovenian with correct dual/declension where relevant. Avoid Croatianisms and literal English word order.' },
  'Slovakia': { language: 'Slovak (with full diacritics)', note: 'Natural Slovak advertising copy. Avoid Czechisms; use correct Slovak diacritics and idioms.' },
  'Czech Republic': { language: 'Czech (with full diacritics)', note: 'Natural Czech advertising copy. Avoid Slovakisms and literal English structures.' },
  'Poland': { language: 'Polish (with ą ć ę ł ń ó ś ź ż)', note: 'Natural modern Polish DTC copy. Preserve meaning and use idiomatic, benefit-led phrasing with correct diacritics.' },
  'Hungary': { language: 'Hungarian (with á é í ó ö ő ú ü ű)', note: 'Rebuild sentences using natural Hungarian syntax rather than English word order. Use correct accents and concise native ecommerce language.' },
  'Romania': { language: 'Romanian (with ă â î ș ț)', note: 'Natural Romanian ecommerce language with correct diacritics. Avoid stiff or literal phrasing.' },
  'Greece': { language: 'Greek (Greek script)', note: 'Natural contemporary Greek ecommerce copy, not a literal calque. Match the source formality and use correct Greek punctuation and accents.' },
  'France': { language: 'French (with full accents)', note: 'Idiomatic European French. Use vous by default unless the source or instructions clearly call for tu.' },
  'Germany': { language: 'German (with ä ö ü and ß)', note: 'Clear idiomatic German. Use Sie by default unless the source or instructions clearly call for du.' },
  'Italy': { language: 'Italian (with correct accents)', note: 'Warm, concise, idiomatic Italian advertising copy; never translate English syntax literally.' },
  'Spain': { language: 'European Spanish (Castilian)', note: 'Natural Castilian Spanish with correct accents and idiomatic ecommerce phrasing.' },
  'Portugal': { language: 'European Portuguese', note: 'Use European Portuguese vocabulary and grammar, not Brazilian Portuguese.' },
  'English': { language: 'natural English', note: 'Tight, conversational, benefit-led DTC copy. Preserve exact facts, offers and claims.' },
};

export function normalizeSource(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en')
    .replace(/[“”„‟]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[‐‑‒–—]/g, '-')
    .replace(/(\d)\s+(a\.?m\.?|p\.?m\.?)\b/gi, '$1$2')
    .replace(/\s+([?!.,:;])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function memoryKey(market: string, source: string): string {
  return `${market}::${normalizeSource(source)}`;
}

export function loadTranslationMemory(): TranslationMemoryEntry[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(TRANSLATION_MEMORY_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((item) => item?.market && item?.source && item?.target) : [];
  } catch {
    return [];
  }
}

export function saveTranslationMemory(entries: TranslationMemoryEntry[]): void {
  localStorage.setItem(TRANSLATION_MEMORY_KEY, JSON.stringify(entries));
}

export function loadGlossary(): GlossaryStore {
  try {
    const parsed = JSON.parse(localStorage.getItem(GLOSSARY_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function saveGlossary(glossary: GlossaryStore): void {
  localStorage.setItem(GLOSSARY_KEY, JSON.stringify(glossary));
}

export function guideForMarket(market: string): MarketGuide {
  return MARKET_COPY_GUIDE[market] || {
    language: `the primary language of ${market}`,
    note: `Write as an expert native ${market} ecommerce copywriter. Use the correct local script, accents and idioms. Never use literal English sentence structure.`,
  };
}

export function glossaryPrompt(market: string, glossary: GlossaryStore): string {
  const globalRules = glossary.Global?.trim();
  const marketRules = glossary[market]?.trim();
  const rules = [globalRules, marketRules].filter(Boolean).join('\n');
  return rules || 'No custom glossary entries.';
}

export function memoryPrompt(market: string, entries: TranslationMemoryEntry[]): string {
  const relevant = entries
    .filter((entry) => entry.market === market)
    .sort((a, b) => (a.status === b.status ? b.updatedAt.localeCompare(a.updatedAt) : a.status === 'approved' ? -1 : 1))
    .slice(0, 120);
  if (!relevant.length) return 'No previous canonical translations.';
  return relevant.map((entry) => `- ${JSON.stringify(entry.source)} => ${JSON.stringify(entry.target)}${entry.status === 'approved' ? ' [APPROVED]' : ''}`).join('\n');
}

export function applyCanonicalMemory(
  market: string,
  segments: FinalSegment[],
  entries: TranslationMemoryEntry[],
  sessionCanonical: Map<string, string>,
): { segments: FinalSegment[]; entries: TranslationMemoryEntry[]; memoryHits: number } {
  const nextEntries = [...entries];
  let memoryHits = 0;
  const canonical = new Map(nextEntries.map((entry) => [memoryKey(entry.market, entry.source), entry.target]));

  const finalSegments = segments.map((segment) => {
    const key = memoryKey(market, segment.original);
    const remembered = canonical.get(key) || sessionCanonical.get(key);
    if (remembered) {
      memoryHits += 1;
      sessionCanonical.set(key, remembered);
      return { ...segment, final: remembered };
    }

    const target = segment.final.trim();
    sessionCanonical.set(key, target);
    const now = new Date().toISOString();
    nextEntries.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      market,
      source: segment.original.trim(),
      sourceNormalized: normalizeSource(segment.original),
      target,
      status: 'generated',
      updatedAt: now,
    });
    canonical.set(key, target);
    return { ...segment, final: target };
  });

  return { segments: finalSegments, entries: nextEntries, memoryHits };
}

export function upsertApprovedTranslations(
  entries: TranslationMemoryEntry[],
  market: string,
  segments: FinalSegment[],
): TranslationMemoryEntry[] {
  const now = new Date().toISOString();
  const byKey = new Map(entries.map((entry) => [memoryKey(entry.market, entry.source), entry]));
  for (const segment of segments) {
    const key = memoryKey(market, segment.original);
    const existing = byKey.get(key);
    byKey.set(key, {
      id: existing?.id || `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      market,
      source: segment.original.trim(),
      sourceNormalized: normalizeSource(segment.original),
      target: segment.final.trim(),
      status: 'approved',
      updatedAt: now,
    });
  }
  return Array.from(byKey.values());
}
