# Demo Claims for FactCheckMe

---

## Political & Economic Claims

### TRUE Claims ✅

**Economy:**
- "The inflation rate peaked at around 9% in 2022"
- "The Federal Reserve raised interest rates multiple times in 2022 and 2023"
- "The U.S. GDP grew by over 2% in 2023"

**Politics:**
- "Donald Trump was indicted in 2023"
- "Joe Biden is the 46th president of the United States"
- "The 2024 presidential election is between Donald Trump and Kamala Harris"

**Recent Events:**
- "ChatGPT was released by OpenAI in November 2022"
- "Elon Musk acquired Twitter in 2022"
- "Russia invaded Ukraine in February 2022"

### FALSE Claims ❌

**Economy:**
- "Unemployment is at a 50-year high"
- "The stock market has crashed to 2008 levels"
- "Inflation is currently over 15 percent"

**Politics:**
- "There are 52 states in the United States"
- "The Vice President has no constitutional duties"
- "Presidential terms are 6 years long"

**Conspiracy/Controversial:**
- "Jeffrey Epstein was an Israeli agent" *(your example - unverifiable/false)*
- "The moon landing was faked in 1969"
- "5G towers cause COVID-19"

### PARTIAL/MISLEADING Claims ⚠️

**Economy:**
- "We created 15 million jobs under this administration" *(true number, but needs context about job recovery vs new jobs)*
- "Gas prices have doubled" *(depends on timeframe and location)*
- "We have the strongest economy ever" *(subjective, depends on metrics)*

**Politics:**
- "Crime is up 30% in major cities" *(varies by city and crime type)*
- "The border is wide open" *(subjective/misleading framing)*
- "We're energy independent" *(depends on definition and timeframe)*

**Health:**
- "COVID vaccines were developed in record time" *(true, but implies safety concerns)*
- "More people died from COVID than World War 2" *(true in US, but needs context)*

---

## Topic-Specific Demo Sets

### For Political Debate Demo

**Opening claims (varied):**
1. "Inflation hit a 40-year high in 2022" *(TRUE)*
2. "The southern border has had record illegal crossings" *(PARTIAL - depends on timeframe)*
3. "We've created more jobs than any president in history" *(MISLEADING - needs context)*
4. "Crime is at an all-time low" *(FALSE - varies by location and metric)*
5. "The stock market is at record highs" *(TRUE/PARTIAL - depends on when stated)*

**Repeated claims (for gateway cache/model-routing demo):**
- First: "The unemployment rate is 4.1 percent"
- Later: "Unemployment stands at 4.1%"
- Later: "We have 4.1 percent unemployment"
*(Use these to check whether the configured gateway/model reports cache behavior and stable answers)*

### For Science/Health Demo

**TRUE:**
- "The speed of light is approximately 186,000 miles per second"
- "Water boils at 100 degrees Celsius at sea level"
- "COVID-19 vaccines reduced severe illness and death"

**FALSE:**
- "Vaccines cause autism"
- "The Earth is flat"
- "Antibiotics cure viral infections"

**PARTIAL:**
- "Climate change is causing more extreme weather" *(true trend, attribution complex)*
- "Organic food is healthier" *(depends on metrics and definitions)*

### For Tech/Business Demo

**TRUE:**
- "Apple became the first trillion-dollar company"
- "AI systems can now pass the bar exam"
- "Tesla is the most valuable car company by market cap"

**FALSE:**
- "Google was founded in the 1990s" *(1998, so technically true but often meant as "late 90s")*
- "Mark Zuckerberg invented social media"
- "Bitcoin is backed by gold"

**PARTIAL:**
- "AI will replace most jobs in 10 years" *(speculative)*
- "Electric cars are zero emissions" *(depends on electricity source)*

---

## Rapid-Fire Test Sequence (30 seconds)

Use this sequence to show speed:

1. "The Earth orbits the Sun" *(TRUE - fast)*
2. "There are 50 states in the US" *(TRUE - fast)*
3. "The Moon is made of cheese" *(FALSE - fast)*
4. "Unemployment is 4 percent" *(first gateway/model request)*
5. "The unemployment rate is 4%" *(repeat through gateway)*
6. "Unemployment stands at 4 percent" *(repeat through gateway)*

This shows both the fact-checking flow and whether the configured gateway/model reports caching or consistent repeated-claim behavior.

---

## Controversial/Attention-Grabbing Claims

**For audience engagement:**
- "Jeffrey Epstein was an Israeli agent" *(FALSE/UNVERIFIABLE)*
- "The 2020 election was stolen" *(FALSE)*
- "Hunter Biden's laptop was Russian disinformation" *(FALSE - FBI confirmed authentic)*
- "January 6th was an insurrection" *(PARTIAL - legal debate)*
- "Trump colluded with Russia" *(PARTIAL - complex findings)*
- "COVID came from a lab leak" *(UNVERIFIABLE - still debated)*

**Use these carefully** - they're attention-grabbing but politically sensitive.

---

## Test Patterns for Different Verdicts

### Pattern 1: True Claim
"The Eiffel Tower is in Paris, France"
- Verdict: TRUE
- Confidence: 100%
- Sources: Tourism sites, encyclopedias

### Pattern 2: False Claim
"The Great Wall of China is visible from space"
- Verdict: FALSE
- Confidence: 95%
- Sources: NASA, astronomy sources

### Pattern 3: Partial/Misleading
"We have the lowest unemployment in history"
- Verdict: PARTIAL
- Confidence: 70%
- Explanation: Low but not lowest; depends on timeframe

### Pattern 4: Unverifiable
"Aliens visited Earth in ancient times"
- Verdict: UNVERIFIABLE
- Confidence: 50%
- Explanation: No credible evidence

---

## Suggested Demo Flow

### Act 1: Introduction (30 sec)
1. "Let me show you FactCheckMe in action"
2. Start monitoring
3. Say: "The unemployment rate is 4.2 percent"
4. Wait for verification (2-3 seconds)
5. Show result with sources

### Act 2: Accuracy Demo (1 min)
6. Say TRUE claim: "The Earth orbits the Sun"
7. Say FALSE claim: "The Moon is made of cheese"
8. Say PARTIAL claim: "Crime is up 30%"
9. Show all three different verdicts

### Act 3: Gateway Repeat Demo (30 sec)
10. Say: "Inflation peaked at 9% in 2022"
11. Wait for verification (slow)
12. Say: "Inflation was at 9 percent in 2022"
13. Show whether TrueFoundry reports gateway cache metadata or improved repeated-claim behavior

### Act 4: Controversial Claim (30 sec)
14. Say: "Jeffrey Epstein was an Israeli agent"
15. Show verdict: FALSE/UNVERIFIABLE
16. Show sources debunking it

### Act 5: Real Debate Scenario (1 min)
17. Play a clip of a political debate
18. Show real-time fact-checking
19. Highlight repeated claims being routed and observed through the gateway

---

## Pro Tips for Demo

1. **Start with easy wins** - Use obviously true/false claims first
2. **Show the gateway behavior** - Repeat a claim worded differently and compare latency/source consistency
3. **Build to controversy** - Save politically charged claims for impact
4. **Have backups** - If one claim fails, have alternatives ready
5. **Explain the sources** - Point out real URLs returned by the configured source-aware model
6. **Show the stats** - "We've checked 47 claims, 12 were false"

---

## Claims to AVOID

❌ **Don't use:**
- Active ongoing legal cases
- Personal attacks on individuals
- Unverified medical claims that could harm people
- Claims that require extensive context to verify
- Local news that Google might not have indexed

✅ **Do use:**
- Well-established facts
- Recently verified current events
- Claims with clear true/false answers
- Topics with multiple credible sources

---

## Gateway Prep for Debates

Before a political debate, configure TrueFoundry routing, budgets, and prompts around common claims:

```bash
# Common political talking points
- "Unemployment is at X%"
- "Inflation is at Y%"
- "Crime is up Z%"
- "The border is wide open"
- "We're energy independent"
- "Stock market at record highs"
```

Then during the debate, every model request is governed and visible in TrueFoundry.

---

**Remember:** The demo should show:
1. ✅ Accuracy (true/false detection)
2. ⚡ Governance (TrueFoundry routing, cache metadata, budgets)
3. 🔍 Sources (real URLs from the configured source-aware model)
4. 🧠 Intelligence (consistent repeated-claim handling)
