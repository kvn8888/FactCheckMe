# Hyperspell Testing Guide

## Pre-Test Checklist

- [ ] `HYPERSPELL_API_KEY` is set in Supabase Dashboard (Settings > Edge Functions > Secrets)
- [ ] Edge function is deployed with latest code
- [ ] You can access Supabase logs (Dashboard > Edge Functions > fact-check > Logs)

## Test Case 1: First-Time Claim (Cache Miss)

### Input
Say or type: **"The unemployment rate is 4.2 percent"**

### Expected Results
- ⏱️ **Response time**: 2-3 seconds (full Gemini + Google Search)
- 📝 **Response has**: `"fromCache": false`
- 📊 **Logs show**:
  - No "Cache hit" message
  - Gemini API call happening
  - "Hyperspell add" success (or error if API key invalid)

### How to Verify
```bash
# Check the response in your browser DevTools Network tab
# Look for the fact-check API call response:
{
  "claim": "The unemployment rate is 4.2 percent",
  "verdict": "true",
  "confidence": 85,
  "fromCache": false,  // ← Should be false
  "sources": [...]
}
```

---

## Test Case 2: Exact Same Claim (Cache Hit)

### Input
Say or type the EXACT same claim: **"The unemployment rate is 4.2 percent"**

### Expected Results
- ⚡ **Response time**: < 200ms (instant from cache)
- 📝 **Response has**: `"fromCache": true`
- 📊 **Logs show**: `"Cache hit for claim: The unemployment rate is 4.2 percent"`
- 🚫 **No Gemini API call**

### How to Verify
```bash
# Response should be instant and show:
{
  "claim": "The unemployment rate is 4.2 percent",
  "verdict": "true",
  "confidence": 85,
  "fromCache": true,  // ← Should be true now!
  "sources": [...]
}
```

---

## Test Case 3: Semantically Similar Claim (Semantic Matching)

### Input
Say or type a DIFFERENT phrasing: **"Unemployment is at 4.2%"**

### Expected Results
- ⚡ **Response time**: < 200ms (instant from cache)
- 📝 **Response has**: `"fromCache": true`
- 📊 **Logs show**: `"Cache hit for claim: Unemployment is at 4.2%"`
- 🧠 **Semantic matching works** (different words, same meaning)

### Variations to Try
All of these should hit the cache:
- "The unemployment rate stands at 4.2 percent"
- "Currently, unemployment is 4.2%"
- "4.2 percent unemployment rate"
- "Unemployment has reached 4.2%"

---

## Test Case 4: Different Claim (Cache Miss)

### Input
Say or type a completely different claim: **"Inflation is at 9 percent"**

### Expected Results
- ⏱️ **Response time**: 2-3 seconds (new Gemini call)
- 📝 **Response has**: `"fromCache": false`
- 📊 **Logs show**: No cache hit, new Gemini call
- 💾 **Result saved to cache** for future use

---

## Test Case 5: Repeated Different Claim (Cache Hit)

### Input
Repeat the inflation claim: **"Inflation is at 9 percent"**

### Expected Results
- ⚡ **Response time**: < 200ms
- 📝 **Response has**: `"fromCache": true`
- 📊 **Logs show**: `"Cache hit for claim: Inflation is at 9 percent"`

---

## Test Case 6: No API Key (Graceful Fallback)

### Setup
Temporarily remove `HYPERSPELL_API_KEY` from Supabase secrets

### Input
Any claim: **"The sky is blue"**

### Expected Results
- ⏱️ **Response time**: 2-3 seconds (always calls Gemini)
- 📝 **Response has**: `"fromCache": false`
- 📊 **Logs show**: No Hyperspell-related messages
- ✅ **System still works** (graceful fallback)

---

## How to Check Results

### 1. Check Response in Browser DevTools

**Chrome/Edge:**
1. Open DevTools (F12)
2. Go to Network tab
3. Say a claim and watch for `fact-check` API call
4. Click on the call → Response tab
5. Look for `"fromCache": true/false`

**Response Time:**
- Look at the "Time" column in Network tab
- Cache hits should be < 200ms
- Cache misses will be 2000-3000ms

### 2. Check Supabase Logs

**Go to:** Supabase Dashboard → Edge Functions → fact-check → Logs

**Look for:**
```
✅ Cache hit for claim: [your claim]  ← Hyperspell working!
❌ Hyperspell search failed: 401      ← Bad API key
❌ Hyperspell add failed: 401         ← Bad API key
```

**No Hyperspell messages at all?**
- API key not set, or
- First time seeing this claim (no cache hit expected)

### 3. Check Frontend UI (Optional Enhancement)

Add a visual indicator in your UI to show cache hits:

```typescript
// In your FactCheckResult component
{result.fromCache && (
  <Badge variant="secondary" className="ml-2 text-xs">
    ⚡ Cached ({result.timestamp.toLocaleTimeString()})
  </Badge>
)}
```

---

## Automated Test Script (Optional)

Create a quick test using curl:

```bash
#!/bin/bash
# test-hyperspell.sh

SUPABASE_URL="your-project.supabase.co"
ANON_KEY="your-anon-key"

echo "Test 1: First claim (should be slow, fromCache: false)"
time curl -X POST \
  "https://$SUPABASE_URL/functions/v1/fact-check" \
  -H "apikey: $ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"claim": "The unemployment rate is 4.2 percent"}' | jq '.fromCache'

echo "\n\nTest 2: Same claim (should be fast, fromCache: true)"
time curl -X POST \
  "https://$SUPABASE_URL/functions/v1/fact-check" \
  -H "apikey: $ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"claim": "The unemployment rate is 4.2 percent"}' | jq '.fromCache'

echo "\n\nTest 3: Similar claim (should be fast, fromCache: true)"
time curl -X POST \
  "https://$SUPABASE_URL/functions/v1/fact-check" \
  -H "apikey: $ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"claim": "Unemployment is at 4.2%"}' | jq '.fromCache'
```

**Expected Output:**
```
Test 1: First claim
false
real    0m2.847s  ← Slow (Gemini call)

Test 2: Same claim
true
real    0m0.156s  ← Fast! (Cache hit)

Test 3: Similar claim
true
real    0m0.143s  ← Fast! (Semantic match)
```

---

## Troubleshooting

### Problem: Always `fromCache: false`

**Possible Causes:**
1. `HYPERSPELL_API_KEY` not set in Supabase
   - **Fix:** Add it in Dashboard → Settings → Edge Functions → Secrets
2. Invalid API key
   - **Fix:** Check logs for `"Hyperspell search failed: 401"`
   - Get new key from app.hyperspell.com
3. Edge function not redeployed
   - **Fix:** Redeploy the function after adding the key

### Problem: Logs show "Hyperspell search failed: 401"

**Cause:** Invalid API key

**Fix:**
1. Verify key at app.hyperspell.com
2. Update in Supabase Dashboard
3. Redeploy edge function

### Problem: Cache hit but wrong verdict

**Cause:** Old cached result from previous test

**Fix:**
- Cached results are intentional (that's the feature!)
- To clear: Use Hyperspell dashboard to delete memories
- Or: Test with completely new claims

### Problem: No logs appear

**Cause:** Edge function not deployed or logs not refreshing

**Fix:**
1. Refresh the logs page
2. Redeploy edge function
3. Check you're looking at the right project/function

---

## Success Criteria

✅ **Hyperspell is working if:**
- First claim: `fromCache: false`, slow (2-3s)
- Second identical claim: `fromCache: true`, fast (<200ms)
- Similar phrasing: `fromCache: true`, fast (<200ms)
- Logs show: `"Cache hit for claim: ..."`

❌ **Hyperspell is NOT working if:**
- All claims show `fromCache: false`
- No cache hit messages in logs
- Response times always 2-3 seconds

---

## Performance Benchmarks

| Scenario | Without Hyperspell | With Hyperspell (Cache Hit) | Savings |
|----------|-------------------|----------------------------|---------|
| First claim | 2.5s | 2.5s | 0% |
| Repeated claim | 2.5s | 0.15s | **94%** ⚡ |
| 10 repeated claims | 25s | 2.5s (first) + 1.5s (9 cached) = 4s | **84%** ⚡ |
| Political debate (50 claims, 30% repeats) | 125s | ~87.5s | **30%** ⚡ |

---

## Next Steps

1. Run Test Cases 1-5 in order
2. Verify logs show "Cache hit" messages
3. Check response times drop from 2-3s to <200ms
4. (Optional) Add visual cache indicators in UI
5. (Optional) Pre-populate cache with common political facts before a debate

Happy testing! 🎉
