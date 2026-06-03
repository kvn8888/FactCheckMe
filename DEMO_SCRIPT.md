# FactCheckMe Demo Script

## One-Liner

> "FactCheckMe listens to live speech, transcribes it with Mistral, and checks factual claims with Gemini's native Google Search grounding."

## 3-Minute Live Demo

### 0. Setup

Open two terminals:

```bash
npm run dev:api
npm run dev
```

Open the app at `http://localhost:8080` or the Vite URL shown in the terminal.

Confirm:

```bash
curl http://127.0.0.1:8787/api/health
```

Expected: `geminiConfigured`, `geminiGoogleSearchConfigured`, `mistralTtsConfigured`, and `mistralRealtimeTranscriptionConfigured` are all `true`.

### 1. Start With The Product

**Say while showing the Monitor page:**

> "This is FactCheckMe. It turns live speech into a transcript and highlights factual claims inline. The important part is that it does not check partial speech. It waits for complete sentences, asks Gemini whether the sentence is a claim, then uses Gemini's native Google Search grounding for the verdict."

Click the microphone.

If asked for mic permission, allow it.

### 2. Easy False Claim

**Say into the mic:**

> "The Eiffel Tower is in Berlin."

**Point out when the transcript highlights:**

- Red `FALSE` inline highlight
- Evidence card on the right
- Source URLs from Gemini grounding metadata
- Confidence and explanation

**Say:**

> "The app transcribed my speech with Mistral, classified the completed sentence with Gemini, then used Gemini Google Search grounding for the sourced verdict."

### 3. Explain The Architecture

Use this quick sequence:

1. Browser streams PCM16 audio through the local WebSocket proxy to Mistral Realtime.
2. React displays partial transcription but emits only completed sentences.
3. A sentence hashmap prevents repeated completed sentences from being checked twice.
4. Gemini decides whether each completed sentence is a factual claim.
5. Gemini fact-checks claims with native Google Search grounding enabled.
6. Node normalizes JSON, attaches grounding sources, and persists the result in SQLite.
7. React highlights the sentence inline and renders the evidence card.

**Say:**

> "The backend is intentionally simple: React frontend, Node API, SQLite database, Mistral for audio, and Gemini for claim classification plus grounded fact-checking."

### 4. Show A True Claim

**Say:**

> "There are 50 states in the United States."

**Point out:**

- Green `TRUE` inline highlight
- Same `/api/fact-check` contract
- Count increments in the dashboard cards

### 5. Show A Non-Claim

**Say:**

> "Thanks everyone for coming today."

**Point out:**

- It appears in the transcript as plain text.
- No evidence card is created.

**Say:**

> "Gemini classifies this as not a factual claim, so the app does not waste a grounded search request."

### 6. Show History And Stats

Click **History**.

**Say:**

> "Every checked claim is stored in SQLite with verdict, confidence, explanation, sources, and timestamp."

Click **Stats**.

**Say:**

> "The stats page proves the app is more than a prompt demo. It has durable sessions, counts, and a local audit trail."

### 7. Show Read-Aloud

Go back to **Monitor** or **History**, expand a fact card, and click the read-aloud control.

**Say:**

> "Mistral also powers the read-aloud path. The API key stays server-side, and the browser only receives generated audio data."

## Backup CLI Demo

If the microphone or browser misbehaves:

```bash
curl -s -X POST http://127.0.0.1:8787/api/fact-check \
  -H 'Content-Type: application/json' \
  -d '{"claim":"The Eiffel Tower is in Berlin."}'
```

Expected signs of success:

- `verdict` is `false`
- `sources` contains real URLs
- `gemini.mode` is `gemini-google-search`
- `gemini.grounding.sourceCount` is greater than `0`

Then run:

```bash
npm run test:gemini
```

Use that output to show multiple claims, source counts, search query counts, latency, and Gemini model metadata.

## Best Claims

### Reliable

- "The Eiffel Tower is in Berlin."
- "There are 50 states in the United States."
- "The Moon is made of cheese."
- "ChatGPT was released by OpenAI in November 2022."

### More Interesting

- "The Great Wall of China is visible from space."
- "The inflation rate peaked around 9 percent in 2022."
- "Lightning never strikes the same place twice."

### Avoid Live

- Highly personal claims
- Medical advice claims
- Active legal allegations
- Claims that require long historical context

## Q&A

**Q: Are we using a separate search service?**

No. The app uses Gemini's native Google Search grounding.

**Q: Where do secrets live?**

Only in server-side `.env`. The frontend never receives Mistral or Gemini keys.

**Q: What database is used?**

SQLite via Node's built-in SQLite module. No Supabase.

**Q: Why wait for completed sentences?**

Partial transcripts change constantly. Fact-checking only completed sentences avoids duplicate checks and bad verdicts on incomplete thoughts.

## Demo Checklist

- [ ] `.env` includes Mistral and Gemini values
- [ ] `npm run dev:api` is running
- [ ] `npm run dev` is running
- [ ] `/api/health` returns Gemini and Mistral configured flags as `true`
- [ ] Browser has microphone permission
- [ ] First CLI smoke test returns `gemini.mode: "gemini-google-search"`
- [ ] Keep `DEMO_CLAIMS.md` open as backup
- [ ] Stop listening before switching tabs for a long explanation
