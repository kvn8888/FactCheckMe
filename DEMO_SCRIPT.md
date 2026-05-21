# FactCheckMe Demo Script - Quick Reference

## 30-Second Elevator Pitch

> "FactCheckMe uses AI through TrueFoundry's gateway to verify claims as they're spoken. Every model request is governed, observable, and routed centrally, which is exactly what you want for debate-scale fact-checking."

---

## 2-Minute Live Demo

### Setup (5 seconds)
- Open app → Monitor page
- Click "Start Monitoring"

### Part 1: Basic Fact-Check (30 seconds)

**Say:** "The unemployment rate is 4.2 percent"

**Wait 2-3 seconds...**

**Point out:**
- ✅ Verdict appears (TRUE/FALSE/PARTIAL)
- 📊 Confidence score shown
- 🔗 Real source URLs from the configured source-aware model
- ⏱️ Took 2-3 seconds (first time)

---

### Part 2: The Gateway - Repeat Demo (30 seconds)

**Say (same claim, different words):** "Unemployment is at 4.2%"

**Compare the repeat request latency and source consistency.**

**Explain:**
> "This request goes through TrueFoundry too, so we can observe repeated claims, token usage, routing, and any gateway cache metadata from one place."

**Try one more:**

**Say:** "Currently, the unemployment rate stands at 4.2 percent"

**Compare the gateway behavior again.**

---

### Part 3: Controversy (30 seconds)

**Say:** "Jeffrey Epstein was an Israeli agent"

**Wait for verdict...**

**Point out:**
- Verdict: FALSE/UNVERIFIABLE
- Sources debunking the claim
- Shows real source URLs when the configured model/provider supports source-aware answers

**Explain:**
> "For controversial claims like this, the configured gateway model returns a verdict, confidence, and source URLs so you can verify yourself."

---

### Part 4: Show Stats (10 seconds)

**Point to dashboard:**
- "X claims checked"
- "Y true, Z false"
- "Session duration"

---

## Key Talking Points

### Problem
"Politicians repeat the same claims in debates. Fact-checkers can't keep up manually, and existing tools are slow and don't remember what they've already verified."

### Solution
"FactCheckMe combines:
1. **TrueFoundry AI Gateway** - Centralized model governance and observability
2. **Source-aware fact-checking** - Returns verdicts with source URLs when the configured model supports it
3. **Live transcription** - Works with spoken audio in real-time"

### The Hook
"In a 90-minute debate, you'll hear the same 10-15 claims repeated. With TrueFoundry in the middle, every model request is observable, governed, and can be routed or cached without changing the app."

---

## Demo Claims Cheat Sheet

### Quick True Claims ✅
- "The Earth orbits the Sun"
- "There are 50 states in the US"
- "Joe Biden is the 46th president"

### Quick False Claims ❌
- "The Moon is made of cheese"
- "There are 52 states in the US"
- "Unemployment is at a 50-year high"

### Gateway Repeat Claims ⚡
**First:** "The unemployment rate is 4.2 percent"
**Second:** "Unemployment is at 4.2%"
**Third:** "We have 4.2% unemployment"

### Controversial (Attention-Grabbing) 🔥
- "Jeffrey Epstein was an Israeli agent"
- "The 2020 election was stolen"
- "COVID came from a lab leak"

---

## Common Questions & Answers

**Q: "What if it's wrong?"**
A: "We show sources so you can verify. The system is as good as Google Search results - if credible sources exist, we find them."

**Q: "How fast is it?"**
A: "Latency depends on the configured gateway model, but TrueFoundry gives us one place to observe latency, token usage, rate limits, budgets, and cache metadata."

**Q: "What about bias?"**
A: "We configure a source-aware model through TrueFoundry and show source URLs when they are returned. You can click through to verify yourself."

**Q: "Does it work in real debates?"**
A: "Yes! It transcribes audio live, detects claims, and fact-checks in real-time. We've optimized it for political debates where claims repeat frequently."

**Q: "What makes this different from other fact-checkers?"**
A: "Three things: (1) Real-time audio transcription, (2) TrueFoundry gateway governance and observability, (3) source-aware fact-checking for current events."

---

## If Demo Fails

### Backup Plan A: Show Pre-Recorded Results
Have screenshots of successful fact-checks ready.

### Backup Plan B: Explain the Tech
"While we wait, let me explain the architecture..."
- Mistral Voxtral for speech-to-text and read-aloud audio
- TrueFoundry AI Gateway for model routing, governance, and observability
- Source-aware model provider configured in TrueFoundry

### Backup Plan C: Show Test Results
```bash
npm run test:truefoundry
```
Show the automated gateway validation script.

---

## Closing

**End with impact:**
> "Imagine watching a presidential debate where every false claim is flagged with sources and every model request is governed through one gateway. That's what we've built."

**Call to Action:**
- "Try it yourself at [your-demo-url]"
- "Check out the code at github.com/[your-repo]"
- "Questions?"

---

## Demo Checklist

**Before Demo:**
- [ ] API is running (`npm run dev:api`)
- [ ] App is running (`npm run dev`)
- [ ] Monitor page is loaded
- [ ] Microphone permissions granted
- [ ] Network connection stable
- [ ] Local SQLite API is reachable (`http://localhost:8787/api/health`)
- [ ] TrueFoundry gateway env vars are set
- [ ] Have backup claims written down

**During Demo:**
- [ ] Speak clearly and slowly
- [ ] Wait for results before continuing
- [ ] Point out specific features (confidence, sources, speed)
- [ ] Show TrueFoundry gateway behavior explicitly
- [ ] Have backup claims ready if one fails

**After Demo:**
- [ ] Stop monitoring
- [ ] Show session stats
- [ ] Answer questions
- [ ] Share links/contact info
