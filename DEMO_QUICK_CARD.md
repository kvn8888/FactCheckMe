# DEMO QUICK CARD - Print This!

## THE FLOW (2 minutes total)

### 1. BASIC (30s)
**Say:** "The unemployment rate is 4.2 percent"
**Show:** Verdict + Sources (2-3s wait)
**Explain:** "Source-aware model request through TrueFoundry"

### 2. GATEWAY REPEAT (30s)
**Say:** "Unemployment is at 4.2%"
**Show:** Repeat request latency + sources
**Explain:** "Same claim through the gateway, with central observability and cache metadata if available"

### 3. CONTROVERSY (30s)
**Say:** "Jeffrey Epstein was an Israeli agent"
**Show:** FALSE with debunking sources
**Explain:** "Even controversial claims get verified"

### 4. WRAP (30s)
**Show:** Stats dashboard
**Pitch:** "Every claim goes through one governed gateway, so routing, spend, and logs are centralized"

---

## BACKUP CLAIMS (if main ones fail)

**True:** "There are 50 states in the US"
**False:** "The Moon is made of cheese"
**Repeat Test:** "50 states" → "The US has 50 states" → "America has fifty states"

---

## THE HOOK LINE
> "Politicians repeat the same 15 claims in every debate. With TrueFoundry in the middle, every verification is observable, governed, and easy to route or cache centrally."

---

## IF IT BREAKS
1. Show test results: `npm run test:truefoundry`
2. Show the architecture diagram
3. Demo the caching concept manually

---

## KEY STATS TO MENTION
- First verification: 2-3 seconds
- Gateway request logs and token usage in TrueFoundry
- Cache metadata if the configured gateway/model reports it
- Works with: Live audio transcription

---

## MUST SHOW
✅ Real source URLs
✅ Gateway behavior (first vs repeated claim)
✅ TrueFoundry model/routing visibility
✅ Confidence scores
✅ Session statistics
