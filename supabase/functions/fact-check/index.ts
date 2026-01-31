import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { claim, sessionId } = await req.json();

    if (!claim || typeof claim !== "string" || claim.trim().length === 0) {
      return new Response(
        JSON.stringify({ error: "Claim text is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
    if (!GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY is not configured");
    }

    // Retry logic for rate limits with exponential backoff
    const makeRequest = async (retries = 3, delay = 3000): Promise<Response> => {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{
              parts: [{
                text: `You are a real-time fact-checker. Use Google Search to verify the following claim and respond with ONLY a JSON object (no markdown, no explanation outside JSON).

If the text has no verifiable factual claim, respond exactly: {"hasClaim": false}

If there IS a factual claim, search for it and respond with this exact JSON format:
{"hasClaim": true, "claim": "extracted claim", "verdict": "true", "confidence": 85, "explanation": "brief explanation", "sources": [{"title": "Source", "url": "https://...", "domain": "example.com"}]}

verdict must be one of: "true", "false", "partial", "unverifiable"
confidence must be 0-100
Include real URLs from your search results in sources.

Claim to verify: "${claim}"`
              }]
            }],
            tools: [{
              google_search: {}
            }],
            generationConfig: { temperature: 0.3 }
          }),
        }
      );

      if (response.status === 429 && retries > 0) {
        console.log(`Rate limited, retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        return makeRequest(retries - 1, delay * 2);
      }
      return response;
    };

    const response = await makeRequest();

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(
          JSON.stringify({ error: "Rate limit exceeded. Please try again later." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const errorText = await response.text();
      console.error("Gemini API error:", response.status, errorText);
      throw new Error(`Gemini API error: ${errorText}`);
    }

    const aiResponse = await response.json();
    const content = aiResponse.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!content) {
      throw new Error("No response from AI");
    }

    // Extract grounding metadata (Google Search results)
    const groundingMetadata = aiResponse.candidates?.[0]?.groundingMetadata;
    const groundingSupports = groundingMetadata?.groundingSupports || [];

    console.log("Grounding metadata:", JSON.stringify(groundingMetadata, null, 2));

    // Parse the AI response
    let factCheckResult;
    try {
      const cleanContent = content.replace(/```json\n?|\n?```/g, '').trim();
      factCheckResult = JSON.parse(cleanContent);
    } catch (parseError) {
      console.error("Failed to parse AI response:", content);
      return new Response(
        JSON.stringify({ noClaim: true }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Enhance sources with actual Google Search results from grounding
    if (groundingSupports.length > 0 && factCheckResult.hasClaim) {
      const groundedSources = groundingSupports
        .filter((support: any) => support.segment)
        .map((support: any) => {
          const chunk = support.groundingChunkIndices?.[0];
          const webChunk = groundingMetadata?.webSearchQueries?.[chunk] || groundingMetadata?.retrievalMetadata?.webDynamicRetrievalScore;
          return {
            title: support.segment?.text?.substring(0, 100) || "Search Result",
            url: webChunk?.uri || support.uri || "",
            domain: webChunk?.uri ? new URL(webChunk.uri).hostname : ""
          };
        })
        .filter((source: any) => source.url);

      // Merge AI-provided sources with grounded sources
      if (groundedSources.length > 0) {
        factCheckResult.sources = [...groundedSources, ...(factCheckResult.sources || [])];
      }
    }

    // If no claim found, return early
    if (factCheckResult.hasClaim === false) {
      return new Response(
        JSON.stringify({ noClaim: true }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Validate verdict
    const validVerdicts = ["true", "false", "partial", "unverifiable"];
    if (!validVerdicts.includes(factCheckResult.verdict)) {
      factCheckResult.verdict = "unverifiable";
    }

    // Save to database
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const claimText = factCheckResult.claim || claim.trim();

    const { data: savedResult, error: dbError } = await supabase
      .from("fact_check_results")
      .insert({
        session_id: sessionId || null,
        claim: claimText,
        verdict: factCheckResult.verdict,
        confidence: Math.min(100, Math.max(0, factCheckResult.confidence || 75)),
        explanation: factCheckResult.explanation || "",
        sources: factCheckResult.sources || [],
      })
      .select()
      .single();

    if (dbError) {
      console.error("Database error:", dbError);
    }

    // Update session claims count if session exists
    if (sessionId) {
      const { data: sessionData } = await supabase
        .from("fact_check_sessions")
        .select("claims_checked")
        .eq("id", sessionId)
        .single();

      if (sessionData) {
        await supabase
          .from("fact_check_sessions")
          .update({ claims_checked: (sessionData.claims_checked || 0) + 1 })
          .eq("id", sessionId);
      }
    }

    return new Response(
      JSON.stringify({
        id: savedResult?.id || crypto.randomUUID(),
        claim: claimText,
        verdict: factCheckResult.verdict,
        confidence: factCheckResult.confidence,
        explanation: factCheckResult.explanation,
        sources: factCheckResult.sources || [],
        timestamp: savedResult?.created_at || new Date().toISOString(),
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Fact-check error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
