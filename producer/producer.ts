import dotenv from "dotenv";
import path from "path";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { genFacts, genQuizzes } from "./llm";
import { findAndStoreClip } from "./youtubeClips";

// Load environment variables from parent directory's .env.local
dotenv.config({ path: path.resolve(__dirname, "../.env.local") });

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const tts = new OpenAI({ 
  baseURL: process.env.KOKORO_BASE_URL, 
  apiKey: process.env.KOKORO_API_KEY || "x",
  defaultHeaders: {
    "User-Agent": "LearnFeedProducer/1.0"
  }
});

const TOPIC_NAMES = [
  "Space",
  "Programming & Building",
  "AI & Machine Learning",
  "Biology & Nature",
  "Health & Body",
  "Cooking & Food",
  "History",
  "How Things Work",
  "Art & Design",
  "Psychology & Mind",
  "Philosophy",
  "Language & Words",
  "Money & Economics",
  "Physics",
  "Skills & Productivity"
];

const TARGET_FACTS = 200;
const TARGET_QUIZZES = 60;
const TARGET_CLIPS = 30;
const BATCH = 10;

async function count(topic: string, type: string) {
  try {
    const { count, error } = await supabase
      .from("content")
      .select("*", { count: "exact", head: true })
      .eq("topic", topic)
      .eq("type", type);
    
    if (error) throw error;
    return count ?? 0;
  } catch (e) {
    console.error(`Error counting content for topic ${topic} type ${type}:`, e);
    return 0;
  }
}

async function synthAndUpload(id: string, text: string) {
  try {
    const mp3 = await tts.audio.speech.create({
      model: process.env.KOKORO_MODEL || "model_q8f16",
      voice: process.env.KOKORO_VOICE || "af_heart",
      input: text
    } as any);
    
    const buf = Buffer.from(await mp3.arrayBuffer());
    const { data, error } = await supabase.storage
      .from("narration")
      .upload(`${id}.mp3`, buf, { 
        contentType: "audio/mpeg", 
        upsert: true 
      });
      
    if (error) throw error;
    return `${id}.mp3`;
  } catch (e) {
    console.error(`TTS synthesis/upload failed for content ID ${id}:`, e);
    throw e; // Bubble up to fallback
  }
}

async function refillFacts(topic: string) {
  const current = await count(topic, "fact");
  const need = TARGET_FACTS - current;
  if (need <= 0) {
    console.log(`[Facts] Topic "${topic}" is full (${current}/${TARGET_FACTS}).`);
    return;
  }
  
  const targetCount = Math.min(need, BATCH);
  console.log(`[Facts] Refilling ${targetCount} facts for topic "${topic}" (currently ${current})...`);
  
  const facts = await genFacts(topic, targetCount);
  for (const f of facts) {
    const { data, error } = await supabase
      .from("content")
      .insert({ 
        type: "fact", 
        topic, 
        source: "producer", 
        title: f.title, 
        tag: f.tag, 
        body: f.body 
      })
      .select("id")
      .single();
      
    if (error || !data) {
      console.error(`Failed to insert fact "${f.title}":`, error);
      continue;
    }
    
    try {
      const p = await synthAndUpload(data.id, f.body);
      await supabase
        .from("content")
        .update({ audio_path: p })
        .eq("id", data.id);
      console.log(` -> Created narrated fact: "${f.title}"`);
    } catch (e) {
      console.warn(` -> Created fact without narration (web fallback active): "${f.title}"`);
    }
  }
}

async function refillQuizzes(topic: string) {
  const current = await count(topic, "quiz");
  const need = TARGET_QUIZZES - current;
  if (need <= 0) {
    console.log(`[Quizzes] Topic "${topic}" is full (${current}/${TARGET_QUIZZES}).`);
    return;
  }
  
  const targetCount = Math.min(need, BATCH);
  console.log(`[Quizzes] Refilling ${targetCount} quizzes for topic "${topic}" (currently ${current})...`);
  
  const quizzes = await genQuizzes(topic, targetCount);
  for (const q of quizzes) {
    const { error } = await supabase
      .from("content")
      .insert({ 
        type: "quiz", 
        topic, 
        source: "producer", 
        title: q.question, // quiz question stored in both title and payload.question
        payload: { 
          question: q.question, 
          options: q.options, 
          correct: q.correct, 
          explain: q.explain 
        } 
      });
      
    if (error) {
      console.error(`Failed to insert quiz "${q.question}":`, error);
    } else {
      console.log(` -> Created quiz: "${q.question}"`);
    }
  }
}

async function refillClips(topic: string) {
  const current = await count(topic, "video");
  if (current >= TARGET_CLIPS) {
    console.log(`[Clips] Topic "${topic}" is full (${current}/${TARGET_CLIPS}).`);
    return;
  }
  
  console.log(`[Clips] Finding 1 clip for topic "${topic}" (currently ${current})...`);
  try {
    const success = await findAndStoreClip(topic);
    if (success) {
      console.log(` -> Discovered and stored new clip for topic "${topic}"`);
    } else {
      console.log(` -> No suitable clip found for topic "${topic}" on this pass.`);
    }
  } catch (e) {
    console.error(`Clip discovery failed for topic "${topic}":`, e);
  }
}

async function pass() {
  console.log("=== STARTING CONTENT REFILL PASS ===");
  const onlyType = process.argv.find(arg => arg.startsWith("--only="))?.split("=")[1];
  if (onlyType) {
    console.log(`Only running generation for type: "${onlyType}"`);
  }
  for (const topic of TOPIC_NAMES) {
    try {
      console.log(`\nProcessing Topic: [${topic}]`);
      if (!onlyType || onlyType === "fact") {
        await refillFacts(topic);
      }
      if (!onlyType || onlyType === "quiz") {
        await refillQuizzes(topic);
      }
      if (!onlyType || onlyType === "video" || onlyType === "clip") {
        await refillClips(topic);
      }
    } catch (e) {
      console.error(`Error processing topic "${topic}":`, e);
    }
  }
  console.log("\n=== REFILL PASS COMPLETE ===");
}

pass();
