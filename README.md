# Ad Localizer v3.6: browser UI + MCP

The browser UI remains visually unchanged. The optional MCP server runs as Netlify Functions and uses Netlify Blobs for jobs, source images, output images, ZIPs, rate limits and audit logs. The Localizer needs **no Firebase project, service account, or separate storage account**. Its existing browser UI still stores the browser Kie key and Translation Library in browser localStorage; the MCP side uses a distinct server-side `KIE_API_KEY` and its own canonical translation memory.

## Setup without a terminal

1. Unzip the source project. Upload its files **inside the folder**, including `package.json`, `netlify.toml`, `src/`, and `netlify/`, to a GitHub repository. In GitHub, `Add file` → `Upload files` accepts a dragged folder. Do not upload only the ZIP or `dist`.
2. In the existing Netlify Ad Localizer site: `Project configuration` → `Developer settings` → `Continuous deployment` → `Repository` → `Link repository`. Choose that repository. Build command `npm run build`, publish directory `dist` (also in `netlify.toml`). Netlify will deploy the UI and MCP Functions from the repository. The old static drag-and-drop deployment cannot deploy functions.
3. In that Netlify site, `Project configuration` → `Environment variables`, create two values available to Functions in Production: `ADLOCALIZER_MCP_TOKEN` (a random long secret that you also give to your agent) and `KIE_API_KEY` (your Kie API key). Mark both as secret. Do not prefix either with `VITE_` or put them into GitHub.
4. Trigger a production deploy after adding/changing environment variables. Connect the agent to `https://YOUR-SITE.netlify.app/mcp`, Streamable HTTP, header `Authorization: Bearer YOUR_ADLOCALIZER_MCP_TOKEN`.

Netlify sets up Blobs automatically when the functions first use them. The read-only runtime `URL` variable is provided by Netlify. No Firebase variable is needed. For a separate Ad Creator PRO integration, see below.

The project can also be deployed with Netlify CLI if you prefer, but the browser workflow above doesn't require it. For development: `npm install`, `npm run lint`, `npm run test:mcp`, `npm run build`.

## MCP behavior

Every MCP call needs the Bearer token. Only one token is configured, and it is hashed in stored audit records. The server allows 60 tool calls and three job starts per minute for that token; it logs tool name, timestamp and success/error in a site-wide Netlify Blobs store. Jobs are written durably in site-wide Blobs and split across background invocations in groups of three image results, with scheduled recovery. Outputs are never deleted by this app, so keep Netlify Blobs enabled and avoid manually deleting them for at least 30 days. Signed download links last 30 days and serve through `/asset` using a streaming Edge Function. Anyone with a signed URL can download until expiry. Rotating the MCP token revokes all prior links.

The normal path has no extra post-generation image QA, so it does not slow down image generation. Opt in to `strict_text_check: true` if you want the UI's text verification and one render retry. The server imports the very same translation, prompt, market guide, model and rendering helpers from `src/` as the UI. Browser-approved translations remain browser-local; MCP canonical translations are stored in Netlify Blobs.

### Tools

| Tool | Example arguments | Example result |
| --- | --- | --- |
| `list_languages` | `{}` | `{"languages":[{"code":"Greece","name":"Greece"},...]}` (all UI markets) |
| `list_options` | `{}` | `{"models":[{"code":"gemini","name":"Gemini","detail":"Nano Banana Pro"},...],"default_model":"gemini","aspect_ratios":["4:5","1:1",...],"default_aspect_ratio":"4:5","resolution":{"gemini":["2K"],"chatgpt":["provider-default"],"grok":["provider-default"]}}` |
| `upload_image` | `{"url":"https://example.com/ad.png","filename":"ad.png"}` or `{"base64":"data:image/png;base64,...","filename":"ad.png"}` | `{"url":"https://YOUR-SITE.netlify.app/asset?...","filename":"ad.png","expires_in_days":30}` |
| `start_localization` | `{"image_urls":["<upload_image url>"],"target_languages":["Greece","Croatia"],"notes":"Keep product name unchanged","keep_layout":true,"model":"gemini","aspect_ratio":"4:5","resolution":"2K","idempotency_key":"campaign-42"}` | `{"job_id":"...","status":"queued"}` immediately |
| `get_job` | `{"job_id":"..."}` | `{"job_id":"...","status":"running","progress":{"completed":1,"total":2},"error":null,"results":[{"source_url":"...","language":"Greece","url":"...","translated_text":[{"original":"Buy now","final":"Αγοράστε τώρα","role":"CTA"}]}]}` |
| `list_jobs` | `{"status":"done","language":"Greece","limit":10}` | `{"jobs":[{"job_id":"...","status":"done","created_at":"...","progress":{"completed":2,"total":2},"languages":["Greece"]}]}` |
| `get_job_zip` | `{"job_id":"...","language":"Greece"}` (`language` optional) | `{"job_id":"...","language":"Greece","url":"https://YOUR-SITE.netlify.app/asset?...","expires_in_days":30}`; folders per language |

`start_localization` also accepts `strict_text_check: true`. Defaults: Gemini Nano Banana Pro, 4:5, 2K, `keep_layout: true`, strict check off. ChatGPT and Grok use provider-default resolution and the UI's source-ratio fallback for 4:5. Accepted job statuses: `queued`, `running`, `done`, `failed`. At most 20 source URLs and 100 source×market outputs per job. Input errors name the invalid field. `idempotency_key` is token-scoped. ZIPs are created on first request so they do not delay image generation. There are no delete tools.

### Ad Creator PRO by job ID

`start_localization` accepts `{"ad_creator_job_id":"finished-job-id","target_languages":["Poland"]}` **only after an Ad Creator PRO job API is configured**. The provided Ad Localizer project contains no Ad Creator PRO schema or credentials, so this connection cannot be inferred. Configure `AD_CREATOR_JOB_API` as a public HTTPS endpoint base that returns one finished job as JSON at `BASE/<job_id>` and `AD_CREATOR_API_TOKEN` as its server-side Bearer token. Its JSON needs a `status` of `done`, `completed`, `success`, or `succeeded`, plus an image array in `image_urls`, `output_urls`, `images`, `results`, or `outputs`. Until then, pass the finished Ad Creator image URLs using `image_urls`. These two extra variables are **not required** for the rest of the MCP tools.

### Protocol examples

Connection URL: `https://YOUR-SITE.netlify.app/mcp`

```bash
curl -X POST "https://YOUR-SITE.netlify.app/mcp" \
  -H "Authorization: Bearer YOUR_ADLOCALIZER_MCP_TOKEN" \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"my-agent","version":"1.0"}}}'
```

```bash
curl -X POST "https://YOUR-SITE.netlify.app/mcp" \
  -H "Authorization: Bearer YOUR_ADLOCALIZER_MCP_TOKEN" \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_options","arguments":{}}}'
```

### Optional CLI commands for environment variables

The browser setup above is sufficient. If you deploy via CLI, these are the exact variable commands after linking your existing site:

```bash
netlify env:set ADLOCALIZER_MCP_TOKEN "<YOUR_RANDOM_SECRET>" --scope functions --context production --secret
netlify env:set KIE_API_KEY "<YOUR_KIE_KEY>" --scope functions --context production --secret
# Only if Ad Creator PRO exposes the described finished-job API:
netlify env:set AD_CREATOR_JOB_API "https://YOUR-AD-CREATOR/api/jobs/" --scope functions --context production
netlify env:set AD_CREATOR_API_TOKEN "<AD_CREATOR_TOKEN>" --scope functions --context production --secret
netlify deploy --build --prod
```
