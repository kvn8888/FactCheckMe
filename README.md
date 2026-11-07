# FactCheckMe

A private, browser-based audio fact checker. It records short audio chunks, transcribes them with **MAI-Transcribe-2**, checks factual claims against web evidence, and shows sourced **true / false / misleading / unverifiable** judgments.

## Architecture

- React, TypeScript, Vite, Tailwind and shadcn/ui.
- Same-origin Node API deployable as a Vercel Function.
- Azure Speech **MAI-Transcribe-2** file transcription. The browser submits six-second, 16 kHz mono PCM WAV chunks (about 192 KB each). One upload runs at a time with a bounded backlog. This is near-real-time chunked transcription, **not** the separate MAI-Transcribe-2-Streaming preview. Expect chunk duration plus provider latency; word boundaries can cross chunks.
- OpenAI **Decisions API**, using `gpt-6-luna` by default, for claim detection, freshness assessment and four-way verdict classification. The tentative name `gpt-6.1-luna` is not the documented Decisions model.
- Exa **lite** for fast cached evidence. Time-sensitive facts, or uncertain freshness, use **auto** with `maxAgeHours: 0`. Search results are evidence candidates, not ground truth.
- OpenAI **Responses API** writes a structured explanation using only the retrieved sources. Displayed URLs come from Exa, not model-generated links. Refusals, missing evidence, malformed results and low confidence produce `unverifiable`, never `false` by default.
- Browser `localStorage` retains up to 500 fact checks and 100 sessions. No server database, Supabase, Hyperspell or server-side transcript history. No raw audio is persisted by the application.
- Browser speech synthesis provides optional read-aloud; available voices depend on the browser/OS and may use their own online services.

Confidence percentages are model estimates, not calibrated guarantees. Check the linked sources, especially for consequential decisions. Source excerpts may omit context. `unverifiable` does not mean false.

## Private access

Every paid API route checks authentication on the server. The React sign-in screen alone is not the security boundary. Missing authentication configuration fails closed.

### Recommended Vercel deployment

1. Create/import the repository as a **Vite** project on Vercel, using Node 24. `vercel.json` supplies the static output, API route and 120-second function duration.
2. **Before enabling the app**, set Deployment Protection → **Vercel Authentication → All Deployments**. Verify protection covers the production domain, custom domains, preview deployments and direct deployment URLs. Standard Protection does not protect every production URL. Do not create protection bypass/share links.
3. Verify in a signed-out/private browser that `/`, `/api/auth/session`, `/api/health` and `/api/fact-check` are intercepted by Vercel sign-in. Confirm an authenticated authorized account can reach them.
4. Only after that verification, set server environment variable `VERCEL_AUTH_PROTECTED=true`. The application also requires Vercel's own `VERCEL=1`. **This flag asserts that protection is already configured; it does not enable or verify Vercel protection.** Do not disable platform protection while this flag is true. No separate application password is needed in this mode.
5. Configure the provider environment variables below for the intended deployment environments, then redeploy. Recheck signed-out access on all URL types. Keep protected production and preview scopes aligned.

Changing project access, configuring persistent credentials, connecting a Doppler integration, and deploying are separate setup actions. This code does not provision a Vercel project or automatically sync secrets.

### Local/private password fallback

Leave `VERCEL_AUTH_PROTECTED=false`. Set `APP_PASSWORD_HASH` to a scrypt hash in `scrypt$<32 hex salt>$<128 hex hash>` format and `APP_SESSION_SECRET` to a strong random value of at least 32 characters. `hashPassword()` in `server/auth.mjs` can generate the hash during an explicitly authorized setup. Do not put a real password in shell history, source control, a browser bundle or localStorage.

Sign-in issues a signed, eight-hour HttpOnly, SameSite=Strict cookie; production cookies are Secure. Changing the password hash or session secret invalidates existing cookies. POST routes reject cross-origin requests. In-memory request limits are defense in depth **per warm server instance**, not a distributed quota. Use Vercel protection/platform rate limits and provider spending limits as the primary abuse controls.

## Server environment variables

Copy `.env.example` only for local setup. Never put a provider credential in a `VITE_*` variable.

| Variable | Purpose |
| --- | --- |
| `MAI_TRANSCRIBE_ENDPOINT` (or `AZURE_SPEECH_ENDPOINT`) | HTTPS Azure Speech resource origin, e.g. `https://RESOURCE.cognitiveservices.azure.com` |
| `MAI_TRANSCRIBE_KEY` (or `AZURE_SPEECH_KEY`) | Key authorized for that resource and MAI transcription |
| `MAI_TRANSCRIBE_MODEL` (or `MAI_TRANSCRIPTION_MODEL`) | Defaults to `MAI-Transcribe-2` |
| `OPENAI_API_KEY` | OpenAI project key with access to Decisions and Responses |
| `OPENAI_DECISIONS_MODEL` | Defaults to `gpt-6-luna`; use a model supported by Decisions |
| `OPENAI_MODEL` | Defaults to `gpt-6-luna`; Responses explanation model |
| `EXA_API_KEY` | Exa search key |
| `EXA_SEARCH_TYPE` | `lite` (default) or `auto`; freshness detection can override lite |
| `VERCEL_AUTH_PROTECTED` | Explicit native-protection assertion, default false; see security steps above |
| `APP_PASSWORD_HASH`, `APP_SESSION_SECRET` | Password-mode fallback only |
| `APP_ORIGIN` | Optional exact canonical origin without trailing slash; otherwise derived from request host |
| `HOST`, `PORT` | Local API bind address/port; defaults `127.0.0.1:8787` |

Keep credentials in Doppler. Use its official Vercel integration after approving the target project, environments and credential scope; or use `doppler run --project <project> --config <config> -- npm run dev:api` locally. This repo does not select a Doppler config, download secrets, create keys or configure a persistent integration. Existing differently named Doppler keys need explicit mapping to the names above.

## Development and verification

```sh
npm ci
npm run dev:api
# In another terminal; Vite proxies /api to port 8787:
npm run dev

npm test
npm run typecheck
npm run lint
npm run build
```

Open the Vite address (default port 8080), sign in, then click the microphone button. Microphone permission is requested only when recording starts. Stopping flushes pending audio and the final incomplete sentence before closing the local session. Navigating away/signing out aborts capture and discards unsent audio. Recording stops safely if transcription falls behind.

Provider tests are mocked and spend no API credits. They verify request contracts, evidence safeguards, authentication, request limits, local persistence, cancellation and stop/restart behavior. They do not prove that a particular Azure region/resource, OpenAI account/model or Exa key is provisioned. Perform an authorized live smoke test with a nonsensitive sample after deployment and secret configuration.

History stays in this browser and origin. It does not sync between devices and can be lost if site data is cleared. Existing SQLite/server history is not automatically copied into localStorage. Clearing history affects this browser only. Blocked/full browser storage falls back to memory with a visible warning. Clearing/signing out does not delete provider-side logs or data governed by Azure/OpenAI/Exa policies. No credentials belong in browser history storage.

## API surface

- `GET /api/auth/session`: authentication mode/status; contains no credentials or history.
- `POST /api/auth/login`, `POST /api/auth/logout`: password fallback only.
- `POST /api/transcribe`: authenticated WAV bytes sent as `application/octet-stream` (Vercel binary-body compatibility), maximum 3.5 MB.
- `POST /api/fact-check`: authenticated JSON `{ "claim": "..." }`, maximum 2,000 characters.
- `GET /api/health`: authenticated service status.

All provider keys stay server-side. API errors and server logs omit provider response bodies, transcripts and credentials. There are no history/session database endpoints or wildcard CORS access.

## Provider references

- [MAI-Transcribe-2 REST guide](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/mai-transcribe?pivots=programming-language-rest)
- [OpenAI Decisions](https://developers.openai.com/api/docs/guides/decisions)
- [Exa quickstart](https://exa.ai/docs/search/quickstart)
- [Vercel deployment protection](https://vercel.com/docs/deployment-protection)
