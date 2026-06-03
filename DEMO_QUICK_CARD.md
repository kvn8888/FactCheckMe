# DEMO QUICK CARD - Print This

## The Flow

### 1. Basic

**Say:** "The unemployment rate is 4.2 percent."

**Show:** Inline transcript highlight, verdict, sources.

**Explain:** "Gemini checks the completed sentence with native Google Search grounding."

### 2. Non-Claim

**Say:** "Thanks everyone for coming today."

**Show:** Plain transcript text, no evidence card.

**Explain:** "Gemini classifies completed sentences first, so non-claims are not searched."

### 3. False Claim

**Say:** "The Moon is made of cheese."

**Show:** Red `FALSE` highlight and evidence card.

### 4. Wrap

**Show:** Stats dashboard.

**Pitch:** "This is a usable live transcript interface, not just a prompt. It transcribes, filters for claims, uses grounded search, and persists an audit trail locally."

## Backup Claims

**True:** "There are 50 states in the US."

**False:** "The Eiffel Tower is in Berlin."

**Misleading:** "Vitamin C always prevents colds."

## Hook Line

> "Most misinformation happens in live speech. FactCheckMe makes the transcript itself the fact-checking surface."

## If It Breaks

1. Show test results: `npm run test:gemini`
2. Show the architecture diagram
3. Use the CLI backup request

## Must Show

- Real source URLs
- Inline transcript highlights
- Gemini Google Search grounding metadata
- Confidence scores
- Session statistics
