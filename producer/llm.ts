import dotenv from "dotenv";
import path from "path";
import OpenAI from "openai";

// Load environment variables from parent directory's .env.local
dotenv.config({ path: path.resolve(__dirname, "../.env.local") });

const llm = new OpenAI({ 
  baseURL: process.env.LLM_BASE_URL, 
  apiKey: process.env.LLM_API_KEY || "x",
  defaultHeaders: {
    "User-Agent": "LearnFeedProducer/1.0"
  }
});

const MODEL = process.env.LLM_MODEL || "llama3.1";

async function jsonArray(prompt: string): Promise<any[]> {
  try {
    const r = await llm.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: "Output only a valid JSON array. Do not wrap in markdown fences. No commentary." },
        { role: "user", content: prompt }
      ],
      temperature: 0.7,
    });
    
    let txt = r.choices[0]?.message?.content ?? "";
    txt = txt.trim();
    
    // Attempt to extract the JSON array bounds to bypass markdown codeblocks or extra text
    const firstBracket = txt.indexOf("[");
    const lastBracket = txt.lastIndexOf("]");
    
    if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
      txt = txt.slice(firstBracket, lastBracket + 1);
    }
    
    const arr = JSON.parse(txt);
    if (Array.isArray(arr)) {
      return arr;
    }
    return [];
  } catch (e) {
    console.error("LLM JSON parsing error: ", e);
    return [];
  }
}

export const genFacts = async (topic: string, n: number) => {
  const list = await jsonArray(
    `Generate ${n} surprising, specific fact cards about "${topic}" for a curious adult.
Each element in the array must be an object with this exact shape: 
{"title": "<hook title, maximum 9 words>", "tag": "<1 to 3 word kicker category>", "body": "<exactly 2 sentences, written to be read aloud clearly>"}.
Return a JSON array only.`
  );
  // Validate schema for each item
  return list.filter(item => 
    item && 
    typeof item.title === "string" && item.title.length > 0 &&
    typeof item.tag === "string" && item.tag.length > 0 &&
    typeof item.body === "string" && item.body.length > 0
  );
};

export const genQuizzes = async (topic: string, n: number) => {
  const list = await jsonArray(
    `Generate ${n} multiple-choice quiz cards about "${topic}".
Each element in the array must be an object with this exact shape:
{"question": "<clear short question>", "options": ["<option a>", "<option b>", "<option c>", "<option d>"], "correct": <0 to 3 index of correct option>, "explain": "<1 sentence explanation of why the correct option is right>"}.
Return a JSON array only.`
  );
  // Validate schema for each item
  return list.filter(item =>
    item &&
    typeof item.question === "string" && item.question.length > 0 &&
    Array.isArray(item.options) && item.options.length === 4 &&
    item.options.every((opt: any) => typeof opt === "string" && opt.length > 0) &&
    typeof item.correct === "number" && item.correct >= 0 && item.correct <= 3 &&
    typeof item.explain === "string" && item.explain.length > 0
  );
};

export { llm };
