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
- Supabase (Database & Edge Functions)
- ElevenLabs API (Speech-to-Text)
- Google Gemini 2.0 (AI + Search Grounding)
- Hyperspell (Semantic Cache)

## Getting Started

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment Variables

Set up the following secrets in Supabase Dashboard (Project Settings > Edge Functions > Secrets):

- `GEMINI_API_KEY` - Get from [Google AI Studio](https://ai.google.dev)
- `ELEVENLABS_API_KEY` - Get from [ElevenLabs](https://elevenlabs.io)
- `HYPERSPELL_API_KEY` - Get from [Hyperspell](https://app.hyperspell.com)

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
npm run dev
```

## Scripts

- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm run test` - Run tests
- `npm run lint` - Run linter
