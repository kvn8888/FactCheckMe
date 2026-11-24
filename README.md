# FactCheckMe

A private, browser-based audio fact checker. It streams microphone audio to OpenAI **GPT-Live-Transcribe** over WebRTC, checks factual claims against web evidence, and shows sourced **true / false / misleading / unverifiable** judgments.

## Architecture

- React, TypeScript, Vite, Tailwind and shadcn/ui.
- Same-origin Node API deployable as a Vercel Function.
- A same-origin Vercel session broker exchanges SDP with OpenAI. Microphone audio flows directly from the browser over WebRTC. Transcript deltas appear as captions and completed turns flush in commit order. Local voice activity detection commits after about 600 ms of silence following speech, with a 14-second cap for continuous speech.
- OpenAI **Decisions API**, using `gpt-6-luna` by default, handles claim detection, freshness and four-way verdict classification. At a live turn boundary, the first Decisions call also asks `claim_complete`. An incomplete thought stays open for the next turn without triggering evidence search. Sentence boundaries inside a turn can settle independently.
- Exa **lite** for fast cached evidence. Time-sensitive facts, or uncertain freshness, use **auto** with `maxAgeHours: 0`. Search results are evidence candidates, not ground truth.
- OpenAI **Responses API** writes a structured explanation using only the retrieved sources. Displayed URLs come from Exa, not model-generated links. Refusals, missing evidence, malformed results and low confidence produce `unverifiable`, never `false` by default.
- Browser `localStorage` retains up to 500 fact checks and 100 sessions with full transcripts, original text chunks and position-based claim mappings. No server database, Supabase or Hyperspell. Optional Axiom diagnostics retain server-side transcript text when explicitly enabled; see below. No raw audio is persisted by the application.
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
| `MAI_TRANSCRIBE_ENDPOINT` (or `AZURE_SPEECH_ENDPOINT`) | HTTPS Azure Speech resource origin for the legacy WAV route |
| `MAI_TRANSCRIBE_KEY` (or `AZURE_SPEECH_KEY`) | Key authorized for the legacy WAV route |
| `MAI_TRANSCRIBE_MODEL` (or `MAI_TRANSCRIPTION_MODEL`) | Legacy WAV route model, defaults to `MAI-Transcribe-2` |
| `OPENAI_API_KEY` | OpenAI project key with access to Realtime transcription, Decisions and Responses |
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

Open the Vite address (default port 8080), sign in, then click the microphone button. Microphone permission is requested when recording starts. A complete thought can settle without terminal punctuation. A mid-sentence pause keeps the same span open until more speech arrives. Each check can use up to 6,000 characters of surrounding transcript to interpret references and qualifiers. Exa supplies the evidence for verdicts.

Stop releases the microphone immediately and allows up to eight seconds for committed transcription to finish. A remaining held fragment is submitted for ordinary claim detection, and settled live spans keep their existing results as context grows. Unchanged rate-limited spans stay failed for the session. New queued checks wait for the rate-limit window before being sent. Navigating away or signing out closes the connection and cancels outstanding checks.

Ordinary provider tests are mocked and spend no API credits. They verify request contracts, evidence safeguards, authentication, request limits, local persistence, cancellation and stop/restart behavior. They do not prove that a particular Azure region/resource, OpenAI account/model or Exa key is provisioned. Perform an authorized live smoke test with a nonsensitive sample after deployment and secret configuration.

History groups checks by session. The full transcript, including nonclaims, stays linked to original text chunks by character offsets; selecting a segment shows its check status, evidence and source chunks. Earlier history without transcript mappings remains readable. History stays in this browser and origin. It does not sync between devices and can be lost if site data is cleared. Existing SQLite/server history is not automatically copied into localStorage. Clearing history affects this browser only. Blocked/full browser storage falls back to memory with a visible warning. Clearing/signing out does not delete provider-side logs or data governed by Azure/OpenAI/Exa policies. No credentials belong in browser history storage.

## API surface

- `GET /api/auth/session`: authentication mode/status; contains no credentials or history.
- `POST /api/auth/login`, `POST /api/auth/logout`: password fallback only.
- `POST /api/realtime/session` accepts an SDP offer as `application/sdp` or JSON `{ "sdp": "..." }` up to 64 KB and returns the SDP answer. It requires owner authentication and the same origin, and allows 20 requests per minute per warm instance.
- `POST /api/transcribe` accepts authenticated WAV bytes as `application/octet-stream` up to 3.5 MB for existing MAI clients.
- `POST /api/fact-check` accepts authenticated JSON with a claim of up to 2,000 characters, optional context of up to 6,000 characters and optional boolean `requireComplete`. A held fragment returns `{ "incomplete": true }`.
- `GET /api/health` reports authenticated service status and the live transcription model.

All provider keys stay server-side. API errors and console logs omit provider response bodies, transcripts and credentials. Explicitly enabled Axiom diagnostics include redacted transcript text and claim context, as described below. There are no history/session database endpoints or wildcard CORS access.

## Transcript diagnostics in Axiom

Transcript logging is **off by default** and requires all three server-only variables:

- `AXIOM_TRANSCRIPT_LOGGING=true`
- `AXIOM_DATASET`: a dedicated private dataset, for example `factcheckme-transcripts`
- `AXIOM_TOKEN`: an ingest-only token restricted to that dataset

Provisioning the dataset/token and installing the token in Vercel are separate approved setup steps. Never put the token in a `VITE_*` variable or reuse an organization-wide management token. Set an appropriate retention policy in Axiom before enabling production logging. Clearing browser history does not clear Axiom records.

Realtime session events record a request ID, timing and status. Live transcript deltas travel over the WebRTC data channel. The legacy WAV route still logs transcribed text, byte counts, duration, request ID, capture-run ID and chunk index. Fact-check outcomes log the exact target, up to 6,000 characters of transcript context, session/span/revision IDs and the outcome, including incomplete, no claim, or verdict and confidence. Provider failures log safe error codes and timings.

No raw audio, SDP, request headers, cookies, provider response bodies or arbitrary exception messages are sent. Known configured secret values and common token/password patterns are redacted before text truncation. Redaction is best effort: ordinary personal or sensitive speech can still be present, so use the private app only for material you intend to retain in Axiom. Transcript text is limited to 16,000 characters per event, targets to 2,000, and context to 6,000; truncation is marked.

Each API request attempts one bounded ingestion after provider completion/failure. Axiom failure cannot change a successful provider result, has a 1.5-second deadline, never retries, and emits only a generic console warning. Ingestion can be lost on process termination or service failure. Disabled logging makes no Axiom calls. Filter the dataset by `service == "factcheckme"`, then `event`, `sessionId`, `segmentId`, `revision` or `transcriptRunId`.

## Coverage and remaining gaps

Run `npm test`, `npm run typecheck`, `npm run lint` and `npm run build` for offline verification. See [scripts/README.md](scripts/README.md) for the separately opt-in synthetic speech/provider smoke test and explicit request/cost bounds. `npm run test:live -- --live --fact-check` uses existing credentials only and can incur provider charges; without `--live`, it performs no network requests.

The deterministic suite covers WebRTC exchange with mocked peers, live deltas, pause and continuous-speech commits, out-of-order completions, stop and disconnect, merging incomplete turns, rate-limit backoff, and browser history. It also covers sentence boundaries and the legacy synthetic WAV capture pipeline. Server tests exercise authenticated routes and provider adapters with fake upstream responses. Axiom tests cover field allowlisting, redaction, authenticated emission, failure isolation and deadlines.

Live testing covers separate concerns including real microphones and browser device compatibility, noisy or multilingual speech, model accuracy, provider throttling and production Axiom ingestion and retention.

## Provider references

- [MAI-Transcribe-2 REST guide](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/mai-transcribe?pivots=programming-language-rest)
- [OpenAI Realtime WebRTC](https://developers.openai.com/api/docs/guides/realtime-webrtc)
- [OpenAI Realtime transcription](https://developers.openai.com/api/docs/guides/realtime-transcription)
- [OpenAI Decisions](https://developers.openai.com/api/docs/guides/decisions)
- [Exa quickstart](https://exa.ai/docs/search/quickstart)
- [Vercel deployment protection](https://vercel.com/docs/deployment-protection)
