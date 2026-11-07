# Private demo checklist

1. Configure the authorized provider environment and private sign-in as described in README.md.
2. Verify a signed-out browser cannot call the paid API routes.
3. Sign in, start listening and speak a short nonsensitive factual sentence.
4. Allow six seconds plus transcription/search latency. Show the transcript, verdict, evidence and source links. Treat confidence as a model estimate, not a guarantee.
5. Try an opinion or greeting. It should not trigger an evidence search when the classifier recognizes it as a non-claim.
6. Stop mid-sentence. The app flushes pending audio and the remaining transcript before ending the session.
7. Show browser-only history and stats; reload to check persistence. Explain that history is private to this browser and does not sync.
8. Optional: read a result aloud with the browser's speech synthesis.
9. Sign out (password mode) or use the Vercel session controls (native mode). Clear browser history before sharing the device.

Architecture: browser WAV chunks → authenticated Node API → MAI-Transcribe-2 → completed sentence → OpenAI Decisions → Exa evidence → Decisions verdict → Responses explanation → localStorage. No server database or semantic cache. Regular MAI file transcription is used, not the separate streaming preview.

Use `npm test`, `npm run typecheck`, `npm run lint` and `npm run build` for offline checks. Provider integration tests use mocks; real credentials and account access require a separate authorized smoke test.
