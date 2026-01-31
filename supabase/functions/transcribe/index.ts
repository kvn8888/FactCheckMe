import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

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
    const { audioData } = await req.json();

    if (!audioData) {
      return new Response(
        JSON.stringify({ error: "Audio data is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
    if (!GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY is not configured");
    }

    // Retry logic for rate limits with exponential backoff
    const makeRequest = async (retries = 3, delay = 2000): Promise<Response> => {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{
              parts: [{
                text: `You are a claim extraction system.

Given transcribed text, extract any factual claims that can be verified.
Focus on statements that make assertions about facts, statistics, history, science, or current events.
Ignore opinions, greetings, and filler words.

Respond with a JSON array of claim strings (no markdown, no code blocks).
If no verifiable claims are found, return an empty array: []

Example output:
["The Earth is flat","Humans only use 10% of their brain"]

Extract verifiable factual claims from this transcribed speech: "${audioData}"`
              }]
            }],
            generationConfig: { temperature: 0.2, responseMimeType: "application/json" }
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
      throw new Error("Gemini API error");
    }

    const aiResponse = await response.json();
    const content = aiResponse.candidates?.[0]?.content?.parts?.[0]?.text;

    let claims: string[] = [];
    if (content) {
      try {
        const cleanContent = content.replace(/```json\n?|\n?```/g, '').trim();
        claims = JSON.parse(cleanContent);
        if (!Array.isArray(claims)) {
          claims = [];
        }
      } catch {
        claims = [];
      }
    }

    return new Response(
      JSON.stringify({ claims }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Transcribe error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
