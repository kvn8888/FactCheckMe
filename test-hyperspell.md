# Testing Hyperspell Cache

## Quick Test Steps

1. **First claim** - Say: "The unemployment rate is 4.2 percent"
   - Response should have `fromCache: false`
   - Response time: ~2-3 seconds (Gemini + Search)
   - Check logs for: No cache message

2. **Same claim again** - Say: "Unemployment is at 4.2%"
   - Response should have `fromCache: true`
   - Response time: < 200ms ✨
   - Check logs for: `"Cache hit for claim: ..."`

3. **Similar phrasing** - Say: "The unemployment rate is currently 4.2 percent"
   - Should ALSO hit cache due to semantic matching
   - Response should have `fromCache: true`

## Checking Logs

Go to: Supabase Dashboard → Project → Edge Functions → fact-check → Logs

Look for:
- ✅ `Cache hit for claim: ...` = Hyperspell is working
- ❌ No cache messages = Either no API key set, or first time seeing this claim

## Visual Indicator (Optional)

You can display cache status in your UI using the `fromCache` field:

```typescript
{result.fromCache && (
  <Badge variant="secondary" className="ml-2">
    ⚡ Cached
  </Badge>
)}
```

This shows users when a result came instantly from cache vs fresh verification.
