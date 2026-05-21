# FactCheckMe

Real-time audio fact-checking application that listens to speech, identifies claims, and verifies them instantly.

## Features

- Live audio transcription using Mistral Voxtral speech-to-text
- Automatic claim detection and extraction
- Real-time fact verification through TrueFoundry AI Gateway
- Read-aloud fact-check summaries using Mistral Voxtral TTS
- Gateway-level governance for model routing, caching, rate limits, budgets, and observability
- History tracking of checked claims
- Statistics dashboard

## Tech Stack

- React + TypeScript
- Vite
- Tailwind CSS
- shadcn/ui
- Node HTTP API
- SQLite
- Mistral Voxtral STT
- TrueFoundry AI Gateway
- Gateway-backed LLM provider with source-aware fact checking
- Mistral Voxtral TTS

## Getting Started

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Create a local `.env` file:

```bash
MISTRAL_API_KEY=your_mistral_api_key
MISTRAL_TRANSCRIPTION_MODEL=voxtral-mini-latest
MISTRAL_TRANSCRIPTION_LANGUAGE=en
MISTRAL_TTS_MODEL=voxtral-mini-tts-2603
MISTRAL_TTS_RESPONSE_FORMAT=mp3
MISTRAL_TTS_REF_AUDIO_PATH=data/mistral-reference.aiff
TRUEFOUNDRY_API_KEY=your_truefoundry_api_key
TRUEFOUNDRY_GATEWAY_BASE_URL=https://gateway.truefoundry.ai
TRUEFOUNDRY_MODEL_ID=google-gemini/gemini-3.5-flash
TRUEFOUNDRY_AGENT_ITERATION_LIMIT=5
VITE_API_URL=http://localhost:8787
```

Pick `TRUEFOUNDRY_MODEL_ID` from the TrueFoundry Playground. SQLite data is stored in `data/factcheckme.sqlite` by default.

To force sourced fact checks through Tavily MCP, configure one of these TrueFoundry Agent options:

```bash
# Option A: use an Agent App already configured with the Tavily MCP server.
TRUEFOUNDRY_AGENT_APP_ID=your_agent_app_id

# Option B: pass the Tavily MCP server directly to the Agent endpoint.
TRUEFOUNDRY_MCP_SERVER_FQN=your_tavily_mcp_integration_fqn
# or:
TRUEFOUNDRY_MCP_SERVER_URL=https://gateway.truefoundry.ai/mcp/your-server

# Optional: restrict tools. Omit this to enable all tools exposed by that MCP server.
TRUEFOUNDRY_MCP_TOOL_NAMES=tavily_search,tavily_extract
```

### 3. What is TrueFoundry doing here?

The Node API sends fact-check prompts through TrueFoundry. By default it uses the OpenAI-compatible Chat Completions endpoint. If `TRUEFOUNDRY_AGENT_APP_ID`, `TRUEFOUNDRY_MCP_SERVER_FQN`, or `TRUEFOUNDRY_MCP_SERVER_URL` is set, it switches to TrueFoundry Agent mode and instructs the model to use Tavily MCP search before producing the verdict. TrueFoundry sits between FactCheckMe, the model provider, and MCP tools so LLM/tool traffic can be governed centrally:

- **Observability** for model requests and token usage
- **Rate limits and budgets** to control spend
- **Gateway caching** where supported by the configured provider/model
- **Model routing and fallbacks** without changing the frontend
- **Guardrails** and access control configured in TrueFoundry
- **MCP tool access** for Tavily-backed search and source retrieval

Microphone audio is recorded in short browser chunks and sent to the local API, which calls Mistral's `audio/transcriptions` endpoint with `MISTRAL_API_KEY`. Expanded fact-check cards can also read results aloud through Mistral's `audio/speech` endpoint. The Mistral key is never exposed to frontend code. Mistral TTS requires either `MISTRAL_TTS_VOICE_ID` or a reference audio file at `MISTRAL_TTS_REF_AUDIO_PATH`.

### 4. Start Development Server

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
- `npm run lint` - Run linter
