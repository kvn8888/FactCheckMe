# Deploying Edge Functions with Hyperspell

## The Issue

Your edge function code has been updated with Hyperspell integration, but it's not deployed yet. That's why tests show `fromCache: null` instead of `true/false`.

## How to Deploy

### Option 1: Using Supabase CLI (Recommended)

1. **Install Supabase CLI** (if not already installed):
```bash
npm install -g supabase
```

2. **Login to Supabase**:
```bash
supabase login
```

3. **Link your project**:
```bash
supabase link --project-ref iqbodvlitggtxbdjfonx
```

4. **Set the environment secrets**:
```bash
# Set your Gemini API key
supabase secrets set GEMINI_API_KEY=your_gemini_key_here

# Set your Hyperspell API key (optional)
supabase secrets set HYPERSPELL_API_KEY=your_hyperspell_key_here
```

5. **Deploy the function**:
```bash
supabase functions deploy fact-check
```

### Option 2: Using Supabase Dashboard

1. Go to [Supabase Dashboard](https://app.supabase.com/project/iqbodvlitggtxbdjfonx/functions)
2. Click on the `fact-check` function
3. Click "Edit function"
4. Copy the entire contents of `supabase/functions/fact-check/index.ts`
5. Paste it into the editor
6. Click "Deploy" or "Save"

## Verify Deployment

After deploying, test again:

```bash
npm run test:hyperspell
```

You should now see:
- First test: `fromCache: false` (new claim)
- Subsequent tests: `fromCache: true` (cached claims)

## Check Your Secrets

Make sure you've set these in Supabase Dashboard → Settings → Edge Functions → Secrets:

- ✅ `GEMINI_API_KEY` - Required
- ✅ `HYPERSPELL_API_KEY` - Optional (for caching)
- ✅ `SUPABASE_URL` - Auto-set by Supabase
- ✅ `SUPABASE_SERVICE_ROLE_KEY` - Auto-set by Supabase

## Quick Test

After deployment, run this command to verify:

```bash
curl -s -X POST \
  "https://iqbodvlitggtxbdjfonx.supabase.co/functions/v1/fact-check" \
  -H "apikey: YOUR_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"claim": "The unemployment rate is 4.2%"}' | jq '.fromCache'
```

First time: Should return `false`
Second time: Should return `true` (if Hyperspell is configured)

## Troubleshooting

### "fromCache" is still null
- Edge function not deployed yet
- Copy/paste the code manually via Dashboard

### "401" errors in logs
- Hyperspell API key is invalid
- Get new key from app.hyperspell.com
- Update in Supabase secrets

### Function won't deploy
- Check syntax errors in the code
- View deployment logs in Supabase Dashboard

## Next Steps

Once deployed:
1. Run `npm run test:hyperspell` to verify
2. Check Supabase logs for "Cache hit" messages
3. Test in your app with real voice input
