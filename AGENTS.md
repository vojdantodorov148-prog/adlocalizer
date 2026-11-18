# Instructions for the next Codex working on Ad Localizer

Read `CODEX_HANDOFF.md` and `README.md` before editing. The handoff ZIP is a v3.7 source snapshot, not proof of the current GitHub branch. Find the repository connected to the existing `adlocalizer.netlify.app` Netlify project and compare its latest commit before applying changes. Never overwrite newer remote work with this snapshot.

Preserve the existing Netlify project/domain and the UI's workflows. Keep image generation fast: avoid extra default AI passes or retries unless a meaningful quality gain has been demonstrated. The text verification pass should remain opt-in unless the user asks otherwise. Reuse `src/kie.ts` and `src/localization.ts` between UI and MCP so prompts and behavior remain aligned.

No Firebase admin credentials belong in this project. The optional Ad Creator PRO connection uses its `/mcp` with a server-side Bearer token. Never put Kie or MCP secrets in frontend bundles, source control, logs, docs or examples. Do not assert live Ad Creator integration works until a real job has been tested.

Before delivering changes: run `npm ci`, `npm run lint`, `npm run test:mcp`, `npm run build`. Keep the complete source, `package-lock.json`, `netlify.toml`, Netlify functions and edge function in the handoff. Distinguish code prepared locally from code actually deployed.

## Verified production identity

Use `https://github.com/vojdantodorov148-prog/adlocalizer`, production branch `main`, and existing Netlify site `de5bfe47-a420-49ab-9dbb-87f7514b088f` (`adlocalizer.netlify.app`). Recheck the remote branch and Netlify linkage before updates; never infer the latest version from this handoff. Publish through this repository's existing Netlify integration.
