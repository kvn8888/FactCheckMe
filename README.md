# FactCheckMe

Real-time audio fact-checking application that listens to speech, identifies claims, and verifies them instantly.

FactCheckMe is a real-time fact-checking tool that helps voters cut through misinformation while watching debates and speeches. As claims are made, we identify them, flag misleading techniques like cherry-picked statistics or missing context, and show the truth instantly. We don't tell you what to believe. We help you think clearly. Powered by Hyperspell, FactCheckMe remembers every fact-check, getting smarter over time. No more waiting for tomorrow's news cycle. Know what's true before you vote.

## Features

- Live audio transcription using ElevenLabs speech-to-text
- Automatic claim detection and extraction
- Real-time fact verification with Google Search grounding
- Semantic caching with Hyperspell for instant repeated claim verification
- History tracking of checked claims
- Statistics dashboard

## Tech Stack

- React + TypeScript
- Vite
- Tailwind CSS
- shadcn/ui
- Supabase or Azure-backed DB provider (via env configuration)
- ElevenLabs or Azure real-time transcription provider (via env configuration)
- Google Gemini 2.0 (AI + Search Grounding)
- Hyperspell (Semantic Cache)

## Getting Started

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment Variables

Copy `.env.example` to `.env` and set providers explicitly:

- `VITE_DB_PROVIDER` (`supabase` or `azure`)
- `VITE_TRANSCRIPTION_PROVIDER` (`elevenlabs` or `azure`)
- `VITE_BACKEND_DB_URL`
- `VITE_BACKEND_DB_PUBLISHABLE_KEY`

Server-side secrets (in your persistent Node.js backend environment):

- `GEMINI_API_KEY` - Get from [Google AI Studio](https://ai.google.dev)
- `ELEVENLABS_API_KEY` - Get from [ElevenLabs](https://elevenlabs.io)
- `HYPERSPELL_API_KEY` - Get from [Hyperspell](https://app.hyperspell.com)
- `AZURE_SPEECH_KEY` / `AZURE_SPEECH_REGION` (for Azure speech)
- `AZURE_DB_CONNECTION_STRING` (for Azure DB)

### 3. What is Hyperspell?

Hyperspell provides semantic caching for fact-checks. When enabled:

- **Instant responses** for repeated claims (under 100ms vs 2-3 seconds)
- **Cost savings** by avoiding redundant API calls to Gemini
- **Semantic matching** recognizes similar claims worded differently
  - "Unemployment is 4.2%" and "The unemployment rate is at 4.2%" match
- **Perfect for debates** where politicians repeat the same talking points

Without Hyperspell, every claim gets verified fresh. With Hyperspell, the second mention of "inflation is 9%" returns instantly from cache.

### 4. Start Development Server
```bash
npm run dev:backend
npm run dev
```

## Scripts

- `npm run dev` - Start development server
- `npm run dev:backend` - Start persistent Node.js backend
- `npm run build` - Build for production
- `npm run test` - Run tests
- `npm run lint` - Run linter

## Real-time transcript UX

During monitoring, live transcript lines are shown in the Monitor view:

- **Red squiggly underline** = fact-check verdict is misinformation (`false`)
- **Yellow highlight** = claim needs clarification (`partial`/`unverifiable`)

## Project structure

Core app code lives in:

- `src/pages` - Route-level pages
- `src/components` - Shared UI
- `src/hooks` - Streaming and fact-check behavior
- `src/lib` - Reusable helpers (including transcript highlighting)
- `src/integrations` - Provider clients (Supabase/DB integrations)

## Claude skill

A Claude skill for frontend design and project structure guidance is available at:

- `.claude/skills/frontend-design-and-structure/SKILL.md`

## Technical retrospective

- `TECHNICAL_RETROSPECTIVE.md` documents the edge-function-to-node migration with implementation guidance for interns/new grads.

## Deploying on Render

1. Create a new **Static Site** in Render and connect this repository.
2. Create a new **Web Service** in Render from this repository for the backend:
   - Start command: `npm run dev:backend`
   - Add backend env vars (`GEMINI_API_KEY`, `ELEVENLABS_API_KEY`, optional `HYPERSPELL_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`)
3. For the static site set:
   - Build command: `npm ci && npm run build`
   - Publish directory: `dist`
4. Set `VITE_API_BASE_URL` in the static site environment to the backend Web Service URL.
5. Trigger deploy and verify:
   - Monitor page loads
   - Microphone permission prompt appears
   - Transcript and fact-check cards render in real time
