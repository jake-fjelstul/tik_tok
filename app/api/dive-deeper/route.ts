import { NextResponse } from "next/server";
import { supabaseUser } from "@/lib/supabaseServer";
import OpenAI from "openai";

const llm = new OpenAI({ 
  baseURL: process.env.LLM_BASE_URL, 
  apiKey: process.env.LLM_API_KEY || "x",
  defaultHeaders: {
    "User-Agent": "LearnFeedProducer/1.0"
  }
});

const MODEL = process.env.LLM_MODEL || "llama3.1";

export async function POST(req: Request) {
  try {
    // 1) Authenticate user
    const u = await supabaseUser();
    const { data: { user }, error: authErr } = await u.auth.getUser();
    if (authErr || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // 2) Parse parameters
    const { topic, title, text, type } = await req.json().catch(() => ({}));
    if (!topic || !text) {
      return NextResponse.json({ error: "Topic and text context are required" }, { status: 400 });
    }

    // 3) Query LLM for detailed research
    const r = await llm.chat.completions.create({
      model: MODEL,
      messages: [
        { 
          role: "system", 
          content: "You are an expert researcher. Output only minified, valid JSON. Do not wrap in markdown code blocks or code fences. No commentary." 
        },
        {
          role: "user",
          content: `Conduct deep, fascinating research on the following concept to provide more context and educational value for a curious adult:
Topic: "${topic}"
Concept Title: "${title || ""}"
Type: "${type || "concept"}"
Context Description: "${text}"

Explain the underlying mechanisms, historical background, and real-world implications.
You MUST format your output as a single JSON object with this exact shape:
{
  "title": "<descriptive research title>",
  "summary": "<1-2 sentence high-level overview>",
  "sections": [
    {
      "heading": "<section heading (max 5 words)>",
      "content": "<2-3 detailed sentences explaining the mechanism, history, or context>"
    },
    {
      "heading": "<section heading (max 5 words)>",
      "content": "<2-3 detailed sentences explaining another angle or implication>"
    },
    {
      "heading": "<section heading (max 5 words)>",
      "content": "<2-3 detailed sentences explaining a final dimension of the topic>"
    }
  ],
  "takeaway": "<key takeaway or Did You Know fact>"
}`
        }
      ],
      temperature: 0.7
    });

    let txt = r.choices[0]?.message?.content ?? "";
    txt = txt.trim();

    // Clean up code block backticks if the model ignores the instruction
    const startBrace = txt.indexOf("{");
    const endBrace = txt.lastIndexOf("}");
    if (startBrace !== -1 && endBrace !== -1 && endBrace > startBrace) {
      txt = txt.slice(startBrace, endBrace + 1);
    }

    const researchData = JSON.parse(txt);

    // Validate structure
    if (
      !researchData ||
      typeof researchData.title !== "string" ||
      typeof researchData.summary !== "string" ||
      !Array.isArray(researchData.sections) ||
      researchData.sections.length < 3 ||
      typeof researchData.takeaway !== "string"
    ) {
      throw new Error("Invalid response format received from LLM");
    }

    return NextResponse.json(researchData);

  } catch (err: any) {
    console.error("Dive Deeper API error:", err);
    return NextResponse.json({ error: err.message || "Failed to generate deeper research" }, { status: 500 });
  }
}
