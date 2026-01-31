# Quick Hyperspell Testing Guide

## TL;DR - 30 Second Test

1. **Say any claim twice** in your app
2. **First time**: Should take 2-3 seconds (`fromCache: false`)
3. **Second time**: Should be instant < 200ms (`fromCache: true`)
4. **Check logs**: Should see `"Cache hit for claim: ..."`

---

## Option 1: Manual Test in Your App

### Steps:
1. Start your app: `npm run dev`
2. Go to Monitor page
3. Click "Start Monitoring"
4. **Say**: "The unemployment rate is 4.2 percent"
   - Wait for result (2-3 seconds)
5. **Say again**: "The unemployment rate is 4.2 percent"
   - Should appear instantly!

### What to Look For:
- **First claim**: Slow, shows full Gemini processing
- **Second claim**: Instant, shows same result
- **DevTools Network tab**: Check response has `fromCache: true`

---

## Option 2: Automated Test Script

### Run the test:
```bash
npm run test:hyperspell
```

Or directly:
```bash
node test-hyperspell.js
```

Or with bash:
```bash
./test-hyperspell.sh
```

### Expected Output:
```
Test: Cache Miss - First Time Claim
Response time: 2847ms
fromCache: false
✅ PASS

Test: Cache Hit - Exact Same Claim
Response time: 156ms
fromCache: true
✅ PASS

Test: Cache Hit - Semantic Match
Response time: 143ms
fromCache: true
✅ PASS
```

---

## How to Check Logs

**Go to:** [Supabase Dashboard](https://app.supabase.com) → Your Project → Edge Functions → fact-check → Logs

**Look for:**
```
✅ "Cache hit for claim: The unemployment rate is 4.2 percent"
```

**If you see:**
```
❌ "Hyperspell search failed: 401"
```
→ Your API key is invalid or not set

**If you see nothing:**
→ API key not configured (system falls back to normal mode)

---

## Quick Troubleshooting

### Problem: Always slow, never cached

**Fix:**
1. Set `HYPERSPELL_API_KEY` in Supabase Dashboard
2. Get key from: https://app.hyperspell.com
3. Go to: Supabase Dashboard → Settings → Edge Functions → Secrets
4. Add: `HYPERSPELL_API_KEY` = `your-key-here`
5. Redeploy function (save the edge function file again)

### Problem: "401" errors in logs

**Fix:** Your API key is wrong
1. Get new key from https://app.hyperspell.com
2. Update in Supabase secrets
3. Redeploy

### Problem: Cache hit but still slow

**Fix:** Network issue or Hyperspell API slow
- Check your internet connection
- Try again in a few minutes

---

## Success Checklist

- [ ] First claim takes 2-3 seconds
- [ ] Second identical claim takes < 200ms
- [ ] Similar phrasing also cached (e.g., "4.2%" vs "4.2 percent")
- [ ] Logs show "Cache hit" messages
- [ ] Response includes `fromCache: true`

**All checked?** ✅ Hyperspell is working perfectly!

---

## Performance Expectations

| Scenario | Time | fromCache |
|----------|------|-----------|
| First time claim | 2-3s | `false` |
| Exact repeat | < 200ms | `true` |
| Similar phrasing | < 200ms | `true` |
| Different claim | 2-3s | `false` |

---

## Test Claims to Use

**Unemployment:**
- "The unemployment rate is 4.2 percent"
- "Unemployment is at 4.2%"
- "Currently unemployment stands at 4.2 percent"

**Inflation:**
- "Inflation is at 9 percent"
- "The inflation rate is 9%"
- "We're seeing 9 percent inflation"

**GDP:**
- "GDP grew 3.1 percent"
- "The GDP growth is 3.1%"
- "Economic growth reached 3.1 percent"

All variations of each topic should hit the same cache entry!

---

## Files Created

- [HYPERSPELL_TEST_CASES.md](HYPERSPELL_TEST_CASES.md) - Detailed test cases
- [test-hyperspell.js](test-hyperspell.js) - Automated Node.js test script
- [test-hyperspell.sh](test-hyperspell.sh) - Automated bash test script
- This file - Quick reference guide
