import dotenv from "dotenv";
import path from "path";
import { YoutubeTranscript } from "youtube-transcript";
import { createClient } from "@supabase/supabase-js";
import { llm } from "./llm";

// Load environment variables from parent directory's .env.local
dotenv.config({ path: path.resolve(__dirname, "../.env.local") });

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const YT = process.env.YOUTUBE_API_KEY!;
const MODEL = process.env.LLM_MODEL || "llama3.1";

const isoToSeconds = (durationStr: string): number => {
  const match = durationStr.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/) || [];
  return (
    Number(match[1] || 0) * 3600 +
    Number(match[2] || 0) * 60 +
    Number(match[3] || 0)
  );
};

async function search(q: string, max = 6): Promise<string[]> {
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

async function details(ids: string[]) {
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
    // No captions available or fetch failed
    return null;
  }

  if (!transcript || transcript.length === 0) return null;

  // Gotcha: check if offset units are in milliseconds (default) or seconds
  const maxOffset = Math.max(...transcript.map((t) => t.offset));
  const isMs = maxOffset > 1800; // If offset exceeds 1800, it is likely in milliseconds
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

export async function findAndStoreClip(topic: string): Promise<boolean> {
  const ids = await search(`${topic} explained`);
  if (!ids.length) return false;

  const candidates = (await details(ids)).sort((a: any, b: any) => b.views - a.views);

  for (const v of candidates) {
    // Skip videos that are too short (< 60s) or too long (> 30 min)
    if (v.duration_s < 60 || v.duration_s > 1800) continue;

    const seg = await pickSegment(v.videoId, topic);
    if (!seg || typeof seg.start !== "number" || typeof seg.end !== "number") continue;

    try {
      // Upsert the source video
      await supabase.from("youtube_videos").upsert({
        video_id: v.videoId,
        title: v.title,
        channel: v.channel,
        duration_s: v.duration_s,
        topic,
      });

      // Insert into content pool
      const { data: c, error: cErr } = await supabase
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

      if (cErr || !c) {
        console.error("Error inserting video into content table:", cErr);
        continue;
      }

      // Insert clip details
      await supabase.from("youtube_clips").insert({
        video_id: v.videoId,
        topic,
        start_s: seg.start,
        end_s: seg.end,
        transcript_excerpt: seg.excerpt ?? null,
        reason: seg.reason ?? null,
        content_id: c.id,
      });

      return true;
    } catch (dbErr) {
      console.error("Database insert failed during clip persistence:", dbErr);
      continue;
    }
  }

  return false;
}
