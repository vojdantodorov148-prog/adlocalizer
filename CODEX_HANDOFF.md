# Ad Localizer — Codex handoff

## Read this first

This archive is the **complete source snapshot of the last version prepared in the ChatGPT conversation, v3.7.0 (15 October 2026)**. It is not a verified export of the currently deployed GitHub branch. Before editing or deploying, locate the GitHub repository already connected to the **existing** Netlify project serving `https://adlocalizer.netlify.app`, inspect its current branch and latest commit, and compare it with this snapshot. If GitHub has newer work, keep that work and use this archive only as a reference. The original handoff session did not verify the repository; see the verified continuation below.

**Preserve the same Netlify project and domain.** Commit updates to its existing production GitHub branch so Netlify builds that same site. Do not create a new Netlify site, attach a different domain, or replace a newer repository checkout with this older snapshot. The project is not a Firebase app. It uses Netlify Blobs for the MCP backend; Ad Creator PRO is a separate optional MCP integration.

## Product

Ad Localizer turns uploaded static ad creatives into native-language images for selected markets. The browser app accepts multiple source images, per-image and global instructions, target markets, image model and aspect ratio. Results are grouped by market; each image, each market, or all markets can be downloaded. A Translation Library allows editing/approving canonical copy and glossary rules. Existing approved copy is reused for identical normalized source text. Maintain native-sounding copy, consistency, and the original design. **Keep image generation fast:** do not add extra vision checks, model passes, or retries to the default path unless they bring a clear benefit. `strict_text_check` is intentionally opt-in.

## Runtime and source map

- React 19 + Vite + TypeScript + Tailwind CSS 4 frontend; Node 22 Netlify Functions and an Edge Function.
- `src/App.tsx`: browser UI, upload, model/market selection, generation concurrency, results, downloads, Translation Library.
- `src/options.ts`: exact market list and ratios shared by UI and MCP. Default ratio `4:5`, then `1:1`.
- `src/localization.ts`: market language guidance, normalization, canonical translation memory and glossary.
- `src/kie.ts`: kie.ai upload, text translation, image model payloads, image rendering, polling, optional rendered-text verification, download. Image models: Gemini Nano Banana Pro, ChatGPT GPT Image 2, Grok Imagine Image 2.0. The text translator first tries Gemini 3 Pro and falls back to GPT 5.2 / Gemini Flash only on outage or unreadable output.
- `netlify/functions/mcp.mts`: authenticated Streamable HTTP MCP endpoint at `/mcp`; tool schemas, rate limiting and audit wrappers.
- `netlify/lib/jobs.ts`: durable job state, background steps, localized outputs, ZIP assembly. It imports the same translation and image helpers as the UI.
- `netlify/lib/core.ts`: Netlify Blobs, signed asset URLs, server auth, image validation, safe server downloads, rate limiting and audit storage.
- `netlify/lib/ad-creator.ts`: optional Ad Creator PRO MCP client for `get_job(job_id)` with optional `image_ids`; accepts only `done`; takes result URLs for the worker to download and store. This integration was tested against a mocked MCP server, not a real Ad Creator PRO deployment.
- `netlify/lib/dispatch.ts`, `netlify/functions/localizer-worker.mts`, `netlify/functions/localizer-recovery.mts`: background dispatch and recovery. Worker handles up to three source/market outputs per invocation, then dispatches the next batch. Recovery runs every ten minutes.
- `netlify/edge-functions/asset.ts`: `/asset` route for signed downloads. Asset URLs expire after 30 days.
- `tests/mcp.test.ts`: auth, protocol, shared options, image validation, Ad Creator response selection and mocked MCP call.
- `README.md`: full MCP tool examples and setup notes.

## Browser flow

1. User enters a kie.ai key using Set Key (saved in browser localStorage as `kie_api_key`), uploads PNG/JPEG/WebP creatives, selects markets/model/ratio and clicks Localize.
2. Source image is uploaded to kie.ai once per browser campaign, then translation is generated for each source × market using image understanding, market guide, glossary and canonical memory. Each translation is locked before rendering.
3. Selected image model edits the source with exact copy replacements, preserving layout/product/visual hierarchy. Provider-specific ratio fallback uses `auto` for non-Gemini 4:5. Optional strict text verification can trigger a render retry.
4. Results and downloads use the kie.ai download helper. Browser translation memory and glossary live in localStorage; there is an import/export UI. The browser campaign itself is not stored server-side.

## MCP flow

URL: `https://adlocalizer.netlify.app/mcp` (Streamable HTTP, POST). Header: `Authorization: Bearer <ADLOCALIZER_MCP_TOKEN>`. The agent receives **this token**, not the Kie key or the Ad Creator token.

Tools: `list_languages`, `list_options`, `upload_image`, `start_localization`, `get_job`, `list_jobs`, `get_job_zip`. `start_localization` accepts either `image_urls` or `ad_creator_job_id`, optionally `image_ids` with the latter. It validates that an Ad Creator job is `done` before queuing, then the background worker downloads its signed source URLs into the Localizer's own Netlify Blobs. Accepted job states are `queued`, `running`, `done`, `failed`. Max 20 source images and 100 source × market outputs; 60 tool calls/minute and 3 job starts/minute for the configured token. ZIPs are built only when requested. No delete tools.

The MCP canonical translation memory is stored in Netlify Blobs and is separate from the browser's localStorage Translation Library. The MCP uses a server-side `KIE_API_KEY`. Outputs and source copies live in the same Netlify project's Blobs; signed `/asset` links are valid for 30 days. A token rotation invalidates previously signed asset URLs.

## Secrets and settings on the existing Netlify project

| Variable | Use |
| --- | --- |
| `ADLOCALIZER_MCP_TOKEN` | Authenticates agents calling Ad Localizer `/mcp`; also signs asset URLs and worker requests. Secret. |
| `KIE_API_KEY` | kie.ai calls from background jobs. Secret. The browser Set Key is separate. |
| `ADCREATOR_MCP_URL` | Optional: `https://adcreatorpro.netlify.app/mcp`, Ad Creator PRO's own MCP endpoint. |
| `ADCREATOR_MCP_TOKEN` | Optional: Bearer token **accepted by Ad Creator PRO's MCP server**. Secret. It must actually be configured on that server; inventing a value only on Ad Localizer does not enable access. |
| `URL` | Runtime URL provided by Netlify; do not hardcode a new site. |

No actual credentials are included in this archive. Check environment variable **names** in the existing Netlify project; never copy their values into GitHub, logs, a prompt, or a source ZIP. Keep the same site so its settings, URL and Blobs persist.

## Local verification and deploy

From the repository root: `npm ci`, `npm run lint`, `npm run test:mcp`, `npm run build`. `netlify.toml` sets build command `npm run build`, publish directory `dist`, functions in `netlify/functions`, Node 22. The GitHub branch connected to the existing Netlify project triggers production deploys. After a change, check Netlify Deploys → Published, then smoke-test the UI and `list_languages`/`list_options` through `/mcp`; for Ad Creator, test one finished job × one market before a large paid job. Do not paste secrets into a test transcript.

This archive does **not** include `node_modules`, a `.git` history, production environment variables, Netlify Blobs, browser localStorage, or a live deployment. Those cannot be reconstructed from the source archive. Browser localStorage remains under the same browser/domain after a normal deploy; MCP Blobs remain only if the same Netlify project continues to serve the domain.

## Known limits to verify before changing production

- The real Ad Creator PRO MCP `get_job` schema, token configuration and signed image download were not verified live. The adapter supports `status: done` and a `results`/`images` array with URLs and optional image IDs. Match actual responses before relying on it.
- There was no live paid generation test for all three image models or the full background chain in the prior build. TypeScript, six MCP tests, Vite build and function bundling passed on the v3.7 source in October 2026.
- Default text verification is off to protect image throughput. For a strict copy use case enable it explicitly and account for a potential paid retry.
- Changing the MCP token revokes existing signed links; changes to Netlify Blobs/site identity affect stored jobs/results. Preserve the existing site when deploying.

## Verified continuation — 18 November 2026

- Repository: https://github.com/vojdantodorov148-prog/adlocalizer
- Production branch: `main`.
- Existing Netlify site ID: `de5bfe47-a420-49ab-9dbb-87f7514b088f`.
- Domain: https://adlocalizer.netlify.app
- Verified GitHub HEAD and published Netlify commit before this documentation update: `058fabfd728b5f8dcd8c0db32d34e17e1e4d8b45`.
- Published deploy: `6ad0d14c2fa54b5c99e2913e`, state `ready`.
- All 26 files already tracked in GitHub are byte-identical to the supplied v3.7 source. Only `.gitignore`, `AGENTS.md`, `CODEX_HANDOFF.md`, and `SOURCE_MANIFEST.sha256` were absent from GitHub. No newer application changes were found.
- Continue from this repository's latest remote branch, checking for concurrent updates before pushing. Use GitHub-triggered deployments on this same site; do not create or relink a site.
- Preserve environment variables, tokens and Blobs. No storage migration or token rotation is required.
- Preserve the default fast generation path: strict verification off, no additional AI calls/retries, existing browser and worker concurrency intact.
- `SOURCE_MANIFEST.sha256` covers tracked source and documentation except itself; refresh it when included files change. The original ZIP manifest was verified separately (29/29 files).
