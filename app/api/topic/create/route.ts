import { NextResponse } from "next/server";
import { supabaseUser, supabaseAdmin } from "@/lib/supabaseServer";
import OpenAI from "openai";
import { YoutubeTranscript } from "youtube-transcript";

const llm = new OpenAI({ 
  baseURL: process.env.LLM_BASE_URL, 
  apiKey: process.env.LLM_API_KEY || "x",
  defaultHeaders: {
    "User-Agent": "LearnFeedProducer/1.0"
  }
});

const tts = new OpenAI({ 
  baseURL: process.env.KOKORO_BASE_URL, 
  apiKey: process.env.KOKORO_API_KEY || "x",
  defaultHeaders: {
    "User-Agent": "LearnFeedProducer/1.0"
  }
});

const MODEL = process.env.LLM_MODEL || "llama3.1";
const YT = process.env.YOUTUBE_API_KEY!;

const isoToSeconds = (durationStr: string): number => {
  const match = durationStr.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/) || [];
  return (
    Number(match[1] || 0) * 3600 +
    Number(match[2] || 0) * 60 +
    Number(match[3] || 0)
  );
};

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

async function synthAndUpload(admin: any, id: string, text: string) {
  try {
    const mp3 = await tts.audio.speech.create({
      model: process.env.KOKORO_MODEL || "model_q8f16",
      voice: process.env.KOKORO_VOICE || "af_heart",
      input: text
    } as any);
    
    const buf = Buffer.from(await mp3.arrayBuffer());
    const { error } = await admin.storage
      .from("narration")
      .upload(`${id}.mp3`, buf, { 
        contentType: "audio/mpeg", 
        upsert: true 
      });
      
    if (error) throw error;
    return `${id}.mp3`;
  } catch (e) {
    console.error(`TTS synthesis/upload failed for content ID ${id}:`, e);
    return null;
  }
}

async function searchYoutube(q: string, max = 6): Promise<string[]> {
  try {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoEmbeddable=true&maxResults=${max}&q=${encodeURIComponent(
      q
    )}&key=${YT}`;
    const res = await fetch(url);
    const d = await res.json();
    return (d.items ?? []).map((i: any) => i.id.videoId).filter(Boolean);
  } catch (e) {
    console.error("YouTube search error:", e);
    return [];
  }
}

async function detailsYoutube(ids: string[]) {
  try {
    const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&id=${ids.join(
      ","
    )}&key=${YT}`;
    const res = await fetch(url);
    const d = await res.json();
    return (d.items ?? []).map((v: any) => ({
      videoId: v.id,
      title: v.snippet.title,
      channel: v.snippet.channelTitle,
      duration_s: isoToSeconds(v.contentDetails.duration),
      views: Number(v.statistics?.viewCount ?? 0),
    }));
  } catch (e) {
    console.error("YouTube details error:", e);
    return [];
  }
}

async function pickSegment(videoId: string, topic: string) {
  let transcript: any[];
  try {
    transcript = await YoutubeTranscript.fetchTranscript(videoId);
  } catch (e) {
    return null;
  }

  if (!transcript || transcript.length === 0) return null;

  const maxOffset = Math.max(...transcript.map((t) => t.offset));
  const isMs = maxOffset > 1800;
  const divisor = isMs ? 1000 : 1;

  const lines = transcript
    .map((t) => `[${Math.floor(t.offset / divisor)}] ${t.text}`)
    .join("\n")
    .slice(0, 8000);

  try {
    const r = await llm.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: "Output only minified JSON. Do not write markdown fences. No commentary." },
        {
          role: "user",
          content: `Below are transcript lines with [second] timestamps from a video. Pick the single most engaging 20 to 40 second segment that best teaches "${topic}" to a curious beginner.
Return exactly this JSON object: {"start": <start second>, "end": <end second>, "excerpt": "<brief transcript line snippet>", "reason": "<why this segment was chosen>"}.
Ensure that "start" and "end" are integers in seconds.

Transcript:
${lines}`,
        },
      ],
    });

    let txt = r.choices[0]?.message?.content ?? "";
    txt = txt.trim();

    const startBrace = txt.indexOf("{");
    const endBrace = txt.lastIndexOf("}");
    if (startBrace !== -1 && endBrace !== -1 && endBrace > startBrace) {
      txt = txt.slice(startBrace, endBrace + 1);
    }

    const seg = JSON.parse(txt);
    if (
      seg &&
      typeof seg.start === "number" &&
      typeof seg.end === "number" &&
      seg.end > seg.start
    ) {
      return seg;
    }
    return null;
  } catch (e) {
    console.error("Failed to parse LLM chosen segment: ", e);
    return null;
  }
}

export async function POST(req: Request) {
  try {
    // 1) Authenticate user
    const u = await supabaseUser();
    const { data: { user }, error: authErr } = await u.auth.getUser();
    if (authErr || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // 2) Parse and validate body
    const { description } = await req.json().catch(() => ({}));
    if (!description || typeof description !== "string" || description.trim().length === 0) {
      return NextResponse.json({ error: "Description is required" }, { status: 400 });
    }

    // 3) Summarize description to a short topic name
    const summaryResult = await llm.chat.completions.create({
      model: MODEL,
      messages: [
        { 
          role: "system", 
          content: "You are a summary assistant. Output a concise 1 to 3 word title summarizing what the user wants to learn (e.g. 'Quantum Computing', 'Jazz History', 'Baking Bread'). Output ONLY the title text. Do not wrap in quotes or formatting." 
        },
        { role: "user", content: description }
      ],
      temperature: 0.3,
    });
    
    let topic = (summaryResult.choices[0]?.message?.content ?? "Custom Topic").trim();
    // Strip surrounding quotes if any
    topic = topic.replace(/^['"]|['"]$/g, "");

    const admin = supabaseAdmin();

    // 4) Register high weight for this topic in user_interest
    const { error: interestErr } = await admin
      .from("user_interest")
      .upsert({
        user_id: user.id,
        topic: topic,
        weight: 2.0,
        updated_at: new Date().toISOString()
      }, { onConflict: "user_id,topic" });

    if (interestErr) {
      console.error("Failed to insert interest weight:", interestErr);
    }

    // 5) Start generation tasks in parallel/sequence
    const finalShapedItems: any[] = [];

    // Generate Facts
    const factsList = await jsonArray(
      `Generate 4 surprising, specific fact cards about "${topic}" for a curious adult.
Each element in the array must be an object with this exact shape: 
{"title": "<hook title, maximum 9 words>", "tag": "<1 to 3 word kicker category>", "body": "<exactly 2 sentences, written to be read aloud clearly>"}.
Return a JSON array only.`
    ).catch(() => []);

    const validFacts = factsList.filter(item => 
      item && 
      typeof item.title === "string" && item.title.length > 0 &&
      typeof item.tag === "string" && item.tag.length > 0 &&
      typeof item.body === "string" && item.body.length > 0
    );

    for (const f of validFacts) {
      const { data: contentRow, error: insertErr } = await admin
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

      if (insertErr || !contentRow) {
        console.error("Error inserting custom fact:", insertErr);
        continue;
      }

      // Generate TTS
      const audioPath = await synthAndUpload(admin, contentRow.id, f.body);
      if (audioPath) {
        await admin
          .from("content")
          .update({ audio_path: audioPath })
          .eq("id", contentRow.id);
      }

      finalShapedItems.push({
        id: contentRow.id,
        type: "fact",
        topic,
        title: f.title,
        tag: f.tag,
        body: f.body,
        audioUrl: audioPath
          ? admin.storage.from("narration").getPublicUrl(audioPath).data.publicUrl
          : null
      });
    }

    // Generate Quizzes
    const quizzesList = await jsonArray(
      `Generate 2 multiple-choice quiz cards about "${topic}".
Each element in the array must be an object with this exact shape:
{"question": "<clear short question>", "options": ["<option a>", "<option b>", "<option c>", "<option d>"], "correct": <0 to 3 index of correct option>, "explain": "<1 sentence explanation of why the correct option is right>"}.
Return a JSON array only.`
    ).catch(() => []);

    const validQuizzes = quizzesList.filter(item =>
      item &&
      typeof item.question === "string" && item.question.length > 0 &&
      Array.isArray(item.options) && item.options.length === 4 &&
      item.options.every((opt: any) => typeof opt === "string" && opt.length > 0) &&
      typeof item.correct === "number" && item.correct >= 0 && item.correct <= 3 &&
      typeof item.explain === "string" && item.explain.length > 0
    );

    for (const q of validQuizzes) {
      const { data: contentRow, error: insertErr } = await admin
        .from("content")
        .insert({
          type: "quiz",
          topic,
          source: "producer",
          title: q.question,
          body: q.question,
          payload: {
            question: q.question,
            options: q.options,
            correct: q.correct,
            explain: q.explain
          }
        })
        .select("id")
        .single();

      if (insertErr || !contentRow) {
        console.error("Error inserting custom quiz:", insertErr);
        continue;
      }

      finalShapedItems.push({
        id: contentRow.id,
        type: "quiz",
        topic,
        title: q.question,
        question: q.question,
        options: q.options,
        correct: q.correct,
        explain: q.explain
      });
    }

    // Generate Video Clip (optional search discovery)
    try {
      const searchTerms = `${topic} explained`;
      const videoIds = await searchYoutube(searchTerms, 4);
      if (videoIds.length > 0) {
        const candidates = (await detailsYoutube(videoIds)).sort((a: any, b: any) => b.views - a.views);
        let clipFound = false;

        for (const v of candidates) {
          if (v.duration_s < 60 || v.duration_s > 1800) continue;

          const seg = await pickSegment(v.videoId, topic);
          if (seg && typeof seg.start === "number" && typeof seg.end === "number") {
            // Persist source video
            await admin.from("youtube_videos").upsert({
              video_id: v.videoId,
              title: v.title,
              channel: v.channel,
              duration_s: v.duration_s,
              topic,
            });

            // Insert content
            const { data: contentRow, error: cErr } = await admin
              .from("content")
              .insert({
                type: "video",
                topic,
                source: "youtube",
                title: v.title,
                payload: {
                  videoId: v.videoId,
                  start: seg.start,
                  end: seg.end,
                  channel: v.channel,
                },
              })
              .select("id")
              .single();

            if (!cErr && contentRow) {
              // Persist clip record
              await admin.from("youtube_clips").insert({
                video_id: v.videoId,
                topic,
                start_s: seg.start,
                end_s: seg.end,
                transcript_excerpt: seg.excerpt ?? null,
                reason: seg.reason ?? null,
                content_id: contentRow.id,
              });

              finalShapedItems.push({
                id: contentRow.id,
                type: "video",
                topic,
                title: v.title,
                videoId: v.videoId,
                start: seg.start,
                end: seg.end,
                channel: v.channel
              });

              clipFound = true;
              break;
            }
          }
        }
      }
    } catch (e) {
      console.error("YouTube clip discovery failed, continuing:", e);
    }

    // 6) Return details
    return NextResponse.json({
      topic,
      items: finalShapedItems
    });
  } catch (err: any) {
    console.error("Custom topic creation API error:", err);
    return NextResponse.json({ error: err.message || "Internal server error" }, { status: 500 });
  }
}
