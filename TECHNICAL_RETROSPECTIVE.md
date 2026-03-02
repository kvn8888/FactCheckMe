# From Edge Functions to a Persistent Node Backend: A Practical Retrospective

This write-up explains what changed, why it changed, and how you can reproduce it yourself if you're an intern, new grad, or just curious.

## TL;DR

We replaced client calls to Supabase Edge Functions with calls to a long-running Node.js service:

- `POST /api/elevenlabs-scribe-token`
- `POST /api/fact-check`
- `GET /api/health`

The frontend still uses Supabase for data access/history, but sensitive API orchestration now lives in a persistent backend process.

---

## Why migrate away from Edge Functions for this flow?

For a real-time app, we wanted:

1. **A single long-lived runtime** we can observe and tune.
2. **Consistent API surface** (`/api/*`) across environments.
3. **Cleaner ownership boundaries**:
   - Frontend = UI/transcript stream handling.
   - Backend = token minting + fact-check orchestration + secret handling.

In practice, this simplifies local debugging and deployment to hosts like Render.

---

## Architecture before vs after

### Before

Frontend hooks called:
- `supabase.functions.invoke('elevenlabs-scribe-token')`
- `supabase.functions.invoke('fact-check')`

### After

Frontend hooks call:
- `backendPost('/api/elevenlabs-scribe-token')`
- `backendPost('/api/fact-check', { claim, sessionId })`

Node backend (`server/index.mjs`) now:
- Holds secret-bearing integrations (ElevenLabs, Gemini, Hyperspell)
- Optionally writes to Supabase DB using service role credentials

---

## What we changed (implementation notes)

### 1) Added a persistent backend process

File: `server/index.mjs`

Key points:
- Node HTTP server (no extra framework dependency)
- CORS enabled for browser app
- Endpoint for ElevenLabs single-use scribe token
- Endpoint for Gemini fact checking + optional Hyperspell cache + optional Supabase write
- Health endpoint for basic uptime checks

### 2) Added a frontend backend client helper

File: `src/services/backendApi.ts`

- Reads `VITE_API_BASE_URL` (defaults to `http://localhost:8787`)
- Provides `backendPost(path, body)` with consistent error handling

### 3) Rewired hooks away from edge functions

Files:
- `src/hooks/useElevenLabsSTT.ts`
- `src/hooks/useFactChecker.ts`

Both now use `backendPost(...)` instead of `supabase.functions.invoke(...)`.

### 4) Updated environment model and docs

Files:
- `.env.example`
- `README.md`

Added explicit backend URL and runtime guidance for two Render services:
- Static Site (frontend)
- Web Service (backend)

---

## Rebuild-it-yourself checklist (for interns/new grads)

If you're implementing your own version from scratch, do this order:

1. Create a backend with:
   - `POST /api/elevenlabs-scribe-token`
   - `POST /api/fact-check`
   - `GET /api/health`
2. Put all secret API calls in backend only.
3. Add frontend `backendPost()` helper and use `VITE_API_BASE_URL`.
4. Swap out all edge/function RPC calls in frontend hooks for HTTP calls.
5. Keep DB reads/writes where they make sense:
   - frontend with publishable key for public data
   - backend with service key for privileged writes
6. Add a simple regression test around backend client error handling.
7. Deploy frontend + backend as separate services.

---

## Lessons learned

1. **Decoupling starts at call sites**  
   The highest leverage edits were in two hooks, not everywhere.

2. **Runtime ownership matters more than vendor choice**  
   "Persistent Node process" is an operational decision, not a framework trend.

3. **Environment naming is architecture documentation**  
   `VITE_API_BASE_URL` made the boundary obvious for every contributor.

4. **Small changes can still be architectural**  
   We kept edits surgical while still moving execution responsibility to backend.

---

## Things you can improve next

- Add request-level logging + correlation IDs in backend.
- Add backend integration tests with mocked upstream APIs.
- Introduce queueing/retry policy for bursty real-time loads.
- Add auth middleware for multi-tenant production deployments.

---

If this helped, you can treat it like a template: replace the model/token providers and keep the same boundary pattern.
