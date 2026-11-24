# Synthetic transcript/provider verification

`npm test` runs mocked HTTP/provider integration coverage and PCM integrity checks without provider credits. The HTTP tests run a real ephemeral loopback server and use real authentication/routing/provider adapters, replacing only upstream fetch. They verify orchestration, not model classification quality. The short PCM fixtures contain silence or sample patterns.

## Sustained TTS streaming diagnostic

Run `npm run test:tts-stream` for the text report or `npm run test:tts-stream -- --json` for structured output. The associated Vitest suite runs with `npm test`. macOS synthesizes about 100 seconds of 48 kHz mono speech with Samantha via `say` and `afconvert`. Other platforms exercise the same runtime with generated PCM. Utterance times come from the actual sample counts. Word times are proportional estimates inside each utterance.

The diagnostic feeds the production hooks through a 48 kHz audio context and real loopback routes. It drains each chunk before accelerating to the next and compares raw word cuts with file-STT-style periods. It uses the production per-minute limiter, so the accelerated run places all requests in one rate-limit window. This measures application behavior with deterministic transcription and fact-check fixtures. It makes zero external requests by default.

`npm run test:tts-stream -- --live` explicitly opts into paid MAI transcription of the fixture with configured Azure Speech credentials. It allows at most 20 upstream requests and 180 seconds of provider time. Fact checks remain local fixtures. The merge and split comparison is available in the default run, where transcript offsets map to known fixture words.

## Optional live speech positive control

Only after authorizing provider usage, supply existing credentials through your normal secret manager and run on macOS:

```sh
node scripts/live-provider-smoke.mjs --live
# Also exercise OpenAI Decisions, Exa, and Responses on the resulting transcript:
node scripts/live-provider-smoke.mjs --live --fact-check
```

Without `--live`, the script prints instructions and makes no network calls. It is never invoked by the ordinary test suite. Existing environment variables match the application README. No keys are created, saved, or printed. The script uses local `/usr/bin/say` and `/usr/bin/afconvert`, writes temporary AIFF/WAV files, and removes them on success or failure. The voice is the installed macOS default; exact audio bytes can vary by OS/voice. The fixed text is: “Earth orbits the Sun. The Moon orbits Earth. Thank you for listening.” No microphone, personal data, or arbitrary audio file is accepted.

The run splits 16 kHz mono PCM speech into independent WAV files of at most six seconds and submits them sequentially, with no overlap or retry. Maximum: five MAI calls (30 seconds audio), optionally one fact-check chain (up to three OpenAI calls and one Exa search), and a 180-second network deadline. Provider plan prices determine dollar cost; this is a request/audio bound, not a monetary cap. Apply provider spending limits separately.

This is an accelerated file-chunked near-live smoke test, **not MAI Streaming preview**, a websocket test, paced microphone capture, or a browser end-to-end test. Its synthetic text is reassembled only after all uploads complete. Chunk boundaries can split words, so keyword loss fails the test. The optional fact-check positive control requires a sourced true result; unverifiable is reported as a smoke failure, not evidence that the astronomy claim is false. Model/provider behavior is nondeterministic. Logs include chunk byte counts, latency, character counts and final result metadata, not credentials or full transcripts.

## Live STT, sentence splitting, and claim gating

```sh
npm run test:live-stt
doppler --no-check-version run --project personal --config dev_personal --no-fallback -- node scripts/live-stt-benchmark.mjs --live --json > /tmp/factcheck-live-stt-v2.json
node scripts/live-stt-benchmark.mjs --report /tmp/factcheck-live-stt-v2.json
```

The usage command and saved-report renderer run offline. Omit `--json` for the human-readable report from a live run. The benchmark is independent of `npm test` and `npm run check`.

`--resume <failed-json>` reuses a generated script when a prior run stopped at script validation before TTS or any other provider call. Keep the saved input and the new output in separate files. The resumed invocation carries forward the first text request and subtracts the elapsed time in the failed report from its remaining deadline. Script validation records any local punctuation fixes in the report.

`--decisions-only <saved-json>` scores any additional aligned tail pairs from a successful saved run without replaying audio or reloading the ONNX model. It reuses previous answers and applies the remaining request and time budgets from the report. It requires `--live` and the same Doppler invocation.

The live run needs Doppler, Node 22.15+ or the repo’s Node 24, and `ffmpeg` on `PATH`. It uses at most one OpenAI Responses request, one TTS request, 20 sequential Azure MAI-Transcribe-2 requests, one OpenAI Realtime WebSocket, and 30 Decisions requests. The overall deadline is 240 seconds. Azure receives 6-second WAV chunks; OpenAI receives the same audio as paced 24 kHz PCM frames with client-side silence and EOF commits. The report shows which OpenAI deltas arrived before the corresponding client commit and during a voiced frame.

For WtP, install `uv` and Python 3.12 locally. The benchmark uses `uv run` with pinned NumPy and ONNX Runtime packages in a temporary directory and fetches the pinned `benjamin/wtp-bert-mini` FP16 graph from Hugging Face. The CPU runner hashes Unicode code points, feeds an FP16 attention mask, averages overlapping 512-character windows, and calibrates the newline threshold on independent sample text. The report contains the threshold sweep and distinguishes download, session load, warmup, full-transcript inference, and rolling inference timings. Temporary audio, dependencies, model files, and caches are removed at exit. If the runner is unavailable, the JSON includes its failure stage and retains the STT and production splitter results.

Both rolling replays process real provider updates in arrival order and require a finalized prefix and 28 characters of right-hand context before locking a split. They flush the remainder at EOF. Span quality, word errors, and cut artifacts are estimates from alignment to the generated script. The Decisions run scores stabilized WtP spans and sampled pre-commit tails with their completed counterparts. Estimated fact-check dispatches count span occurrences that pass both the completion and checkability thresholds. The 67–94-call comparison uses the historical count supplied for the benchmark.
