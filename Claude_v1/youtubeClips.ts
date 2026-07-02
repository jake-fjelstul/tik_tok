// lib/youtubeClips.ts — the "find a cool video, pick the most relevant clip" pipeline.
//
//   npm i youtube-transcript @anthropic-ai/sdk pg
//   env: YOUTUBE_API_KEY, ANTHROPIC_API_KEY, DATABASE_URL
//
// Flow:  search YouTube -> rank candidates -> fetch transcript ->
//        Claude picks the best ~20-40s segment -> store video + clip -> return.
//
// NOTE: untested against the live APIs here (the build sandbox can't reach
// googleapis/youtube). Two things to verify when you run it:
//   1) `youtube-transcript` returns offset/duration in MILLISECONDS in most
//      versions — confirm and adjust the /1000 below if yours differs.
//   2) some videos disable embedding or have no captions; the loop skips those.

import { YoutubeTranscript } from "youtube-transcript";
import Anthropic from "@anthropic-ai/sdk";
import { query } from "./db";

const YT = process.env.YOUTUBE_API_KEY!;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

export type Clip = {
  videoId: string; start: number; end: number;
  title: string; channel: string; reason: string;
};

function isoToSeconds(d: string): number {
  const m = d.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/) || [];
  return (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0));
}

async function searchVideos(q: string, max = 6): Promise<string[]> {
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video`
    + `&videoEmbeddable=true&maxResults=${max}&q=${encodeURIComponent(q)}&key=${YT}`;
  const d = await (await fetch(url)).json();
  return (d.items ?? []).map((i: any) => i.id.videoId).filter(Boolean);
}

async function videoDetails(ids: string[]) {
  const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics`
    + `&id=${ids.join(",")}&key=${YT}`;
  const d = await (await fetch(url)).json();
  return (d.items ?? []).map((v: any) => ({
    videoId: v.id,
    title: v.snippet.title,
    channel: v.snippet.channelTitle,
    duration_s: isoToSeconds(v.contentDetails.duration),
    views: Number(v.statistics?.viewCount ?? 0),
  }));
}

async function pickBestSegment(videoId: string, topic: string) {
  let transcript: any[];
  try { transcript = await YoutubeTranscript.fetchTranscript(videoId); }
  catch { return null; } // no captions -> skip this video

  const lines = transcript
    .map((t) => `[${Math.floor(t.offset / 1000)}] ${t.text}`)
    .join("\n")
    .slice(0, 8000);

  const msg = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 300,
    system: "You output only valid minified JSON.",
    messages: [{
      role: "user",
      content: `Below are transcript lines with [second] timestamps from one video. `
        + `Pick the single most engaging 20-40 second segment that best teaches "${topic}" `
        + `to a curious beginner. Return {"start":<sec>,"end":<sec>,"excerpt":"<the lines>","reason":"<short>"}.\n\n${lines}`,
    }],
  });
  const txt = msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
  try { return JSON.parse(txt.replace(/```json|```/g, "").trim()); }
  catch { return null; }
}

async function persist(v: any, seg: any, topic: string): Promise<Clip> {
  await query(
    `insert into youtube_videos (video_id,title,channel,duration_s,topic)
     values ($1,$2,$3,$4,$5) on conflict (video_id) do nothing`,
    [v.videoId, v.title, v.channel, v.duration_s, topic],
  );
  const c = await query(
    `insert into content (type,topic,source,title,payload)
     values ('video',$1,'youtube',$2,$3) returning id`,
    [topic, v.title, JSON.stringify({ videoId: v.videoId, start: seg.start, end: seg.end, channel: v.channel })],
  );
  await query(
    `insert into youtube_clips (video_id,topic,start_s,end_s,transcript_excerpt,reason,content_id)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [v.videoId, topic, seg.start, seg.end, seg.excerpt ?? null, seg.reason ?? null, c.rows[0].id],
  );
  return { videoId: v.videoId, start: seg.start, end: seg.end, title: v.title, channel: v.channel, reason: seg.reason };
}

/** Main entry: given a search query + topic, return a stored, playable clip. */
export async function findClipForTopic(searchQuery: string, topic: string): Promise<Clip | null> {
  const ids = await searchVideos(searchQuery);
  if (!ids.length) return null;

  const details = await videoDetails(ids);
  details.sort((a, b) => b.views - a.views); // popular first; swap in your own ranking

  for (const v of details) {
    if (v.duration_s < 60 || v.duration_s > 1800) continue; // skip shorts + very long
    const seg = await pickBestSegment(v.videoId, topic);
    if (seg && typeof seg.start === "number" && typeof seg.end === "number") {
      return persist(v, seg, topic);
    }
  }
  return null;
}
