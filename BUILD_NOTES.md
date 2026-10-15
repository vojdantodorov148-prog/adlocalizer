# Ad Localizer v3 — implementation notes

## Speed-first decisions

- Translation and native-language QA run in one deterministic Gemini 2.5 Pro
  request instead of two sequential language requests.
- Translation Memory and glossary matching are local operations and add no API
  latency.
- Strict Image Text Check is optional and off by default. When enabled it adds
  one vision check after rendering and one image retry only on a mismatch.
- Up to eight complete localization jobs run concurrently. This avoids request
  bursts that can trigger rate limits while keeping normal batches fast.

## Consistency

- Memory key: normalized source text + target market.
- Normalization handles case, Unicode variants, smart quotes, dash variants,
  whitespace, punctuation spacing and `3 AM` / `3AM` differences.
- Existing memory always overrides a newly proposed translation.
- New phrases are saved automatically as `generated` canonical entries.
- User-edited entries can be marked `approved` and remain locked.
- Translation Library can be exported/imported as JSON.

## Image providers

- Gemini: `nano-banana-pro`
- ChatGPT: `gpt-image-2-image-to-image`
- Grok: `grok-imagine-image-2-0/image-edit`

For ChatGPT and Grok, 4:5 uses `auto` so the source image ratio is preserved.
Other unsupported provider ratios automatically retry task creation with
`auto`; this retry happens before an image job is accepted and therefore does
not spend a second image generation.

## Validation completed

- `npm run lint`
- `npm run build`
- local Vite preview served the page and production JS successfully

Live paid API generation still requires a valid kie.ai API key and credits.
