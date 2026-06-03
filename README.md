# FactCheckMe

Real-time audio fact-checking application that listens to speech, identifies factual claims, and verifies them with sourced web grounding.

## Features

- Live audio transcription using Mistral Voxtral realtime speech-to-text
- Persistent transcript UI with inline claim highlighting
- Automatic completed-sentence claim detection
- Real-time fact verification through Gemini with native Google Search grounding
- Read-aloud fact-check summaries using Mistral Voxtral TTS
- History tracking of checked claims
- Statistics dashboard

## Tech Stack

- React + TypeScript
- Vite
- Tailwind CSS
- shadcn/ui
- Node HTTP API
- SQLite
- Mistral Voxtral STT and TTS
- Gemini API with native Google Search grounding

## Getting Started

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Create a local `.env` file:

```bash
VITE_API_URL=http://localhost:8787

MISTRAL_API_KEY=your_mistral_api_key
MISTRAL_REALTIME_TRANSCRIPTION_MODEL=voxtral-mini-transcribe-realtime-2602
MISTRAL_REALTIME_DELAY_MS=1000
MISTRAL_TTS_MODEL=voxtral-mini-tts-2603
MISTRAL_TTS_RESPONSE_FORMAT=mp3
MISTRAL_TTS_REF_AUDIO_PATH=data/mistral-reference.aiff

GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-3.5-flash
```

SQLite data is stored in `data/factcheckme.sqlite` by default.

### 3. How Fact Checking Works

Microphone audio is streamed as PCM16 through the local WebSocket proxy to Mistral's realtime transcription endpoint. The frontend displays partial transcription deltas, but only completed sentences are sent to the backend.

For each completed sentence:

1. The frontend normalizes the sentence into a hashmap key so repeated sentences are not checked twice.
2. Gemini classifies whether the sentence is a verifiable factual claim.
3. If it is not a claim, the transcript stays plain text.
4. If it is a claim, the backend calls Gemini `generateContent` with the native `google_search` tool enabled.
5. The backend normalizes the JSON verdict, attaches sources from Gemini grounding metadata, persists the result in SQLite, and returns the standard fact-check response to the frontend.

Expanded fact-check cards can also read results aloud through Mistral's `audio/speech` endpoint. API keys are never exposed to frontend code. Mistral TTS requires either `MISTRAL_TTS_VOICE_ID` or a reference audio file at `MISTRAL_TTS_REF_AUDIO_PATH`.

## Start Development Server

```bash
npm run dev:api
npm run dev
```

Or run both from one shell:

```bash
npm run dev:full
```

## Scripts

- `npm run dev` - Start development server
- `npm run dev:api` - Start the Node API and SQLite backend
- `npm run dev:full` - Start the API and Vite together
- `npm run build` - Build for production
- `npm run test` - Run tests
- `npm run test:gemini` - Run a local Gemini Google Search smoke test against the API
- `npm run lint` - Run linter
