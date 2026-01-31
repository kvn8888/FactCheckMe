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

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      throw new Error("LOVABLE_API_KEY is not configured");
    }

    // Call AI to fact-check the claim
    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [
          {
            role: "system",
            content: `You are a fact-checker. Analyze claims and determine their truthfulness.
            
You must respond with a valid JSON object (no markdown, no code blocks) with these fields:
- verdict: one of "true", "false", "partial", or "unverifiable"
- confidence: a number from 0 to 100
- explanation: a brief explanation (1-2 sentences)
- sources: an array of objects with title, url, and domain fields (provide 1-3 relevant sources)

Example response:
{"verdict":"false","confidence":95,"explanation":"This is a common misconception. Scientific studies have shown...","sources":[{"title":"Scientific American","url":"https://scientificamerican.com","domain":"scientificamerican.com"}]}`
          },
          {
            role: "user",
            content: `Fact-check this claim: "${claim}"`
          }
        ],
        temperature: 0.3,
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(
          JSON.stringify({ error: "Rate limit exceeded. Please try again later." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (response.status === 402) {
        return new Response(
          JSON.stringify({ error: "AI credits exhausted. Please add funds." }),
          { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const errorText = await response.text();
      console.error("AI gateway error:", response.status, errorText);
      throw new Error("AI gateway error");
    }

    const aiResponse = await response.json();
    const content = aiResponse.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error("No response from AI");
    }

    // Parse the AI response
    let factCheckResult;
    try {
      // Clean potential markdown code blocks
      const cleanContent = content.replace(/```json\n?|\n?```/g, '').trim();
      factCheckResult = JSON.parse(cleanContent);
    } catch (parseError) {
      console.error("Failed to parse AI response:", content);
      // Fallback if parsing fails
      factCheckResult = {
        verdict: "unverifiable",
        confidence: 50,
        explanation: "Unable to verify this claim at this time.",
        sources: []
      };
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

    const { data: savedResult, error: dbError } = await supabase
      .from("fact_check_results")
      .insert({
        session_id: sessionId || null,
        claim: claim.trim(),
        verdict: factCheckResult.verdict,
        confidence: Math.min(100, Math.max(0, factCheckResult.confidence || 75)),
        explanation: factCheckResult.explanation || "",
        sources: factCheckResult.sources || [],
      })
      .select()
      .single();

    if (dbError) {
      console.error("Database error:", dbError);
      // Still return the result even if saving fails
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
        claim: claim.trim(),
        verdict: factCheckResult.verdict,
        confidence: factCheckResult.confidence,
        explanation: factCheckResult.explanation,
        sources: factCheckResult.sources,
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
