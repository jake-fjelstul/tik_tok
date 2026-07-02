import { NextResponse } from "next/server";
import { supabaseUser, supabaseAdmin } from "@/lib/supabaseServer";
import { chooseBatchTopics } from "@/lib/recommender";

export async function POST(req: Request) {
  try {
    const { limit = 8 } = await req.json().catch(() => ({}));
    
    // Authenticate the user session via cookies
    const u = await supabaseUser();
    const { data: { user }, error: authErr } = await u.auth.getUser();
    if (authErr || !user) {
      return NextResponse.json({ error: "no session" }, { status: 401 });
    }

    const admin = supabaseAdmin();

    // 1) Fetch user interest weights
    const { data: rows, error: interestErr } = await admin
      .from("user_interest")
      .select("topic,weight")
      .eq("user_id", user.id);
      
    if (interestErr) {
      console.error("Error fetching interest weights:", interestErr);
    }
    
    const interest: Record<string, number> = Object.fromEntries(
      (rows ?? []).map(r => [r.topic, r.weight])
    );
    
    // Choose exploitation and exploration topics
    const topics = chooseBatchTopics(interest);

    // 2) Reinforce one unresolved weak topic (from incorrect quiz answers)
    const { data: weak, error: weakErr } = await admin
      .from("user_weak_topics")
      .select("id,topic")
      .eq("user_id", user.id)
      .eq("resolved", false)
      .limit(1);
      
    if (weakErr) {
      console.error("Error fetching weak topics:", weakErr);
    }

    if (weak && weak.length > 0) {
      topics.push(weak[0].topic);
      // Mark this weak topic as resolved so it doesn't immediately repeat
      await admin
        .from("user_weak_topics")
        .update({ resolved: true })
        .eq("id", weak[0].id);
    }

    // 3) Call RPC to select a larger candidate pool of unseen content in these topics
    const candidateLimit = limit * 4;
    const { data: candidates, error: rpcErr } = await admin.rpc("get_feed", {
      p_user: user.id,
      p_topics: topics,
      p_limit: candidateLimit,
    });

    if (rpcErr) {
      console.error("RPC get_feed error:", rpcErr);
      return NextResponse.json({ error: "failed to retrieve feed" }, { status: 500 });
    }

    // Separate candidates by type
    const facts = (candidates ?? []).filter((c: any) => c.type === "fact");
    const quizzes = (candidates ?? []).filter((c: any) => c.type === "quiz");
    const videos = (candidates ?? []).filter((c: any) => c.type === "video");

    // Define target counts for the batch (e.g. ~15% quizzes, ~25% videos)
    const targetQuizCount = Math.max(1, Math.floor(limit * 0.15));
    const targetVideoCount = Math.max(1, Math.floor(limit * 0.25));
    
    const selectedQuizzes = quizzes.slice(0, targetQuizCount);
    const selectedVideos = videos.slice(0, targetVideoCount);
    
    // Facts get the remaining slots
    const targetFactCount = Math.max(0, limit - selectedQuizzes.length - selectedVideos.length);
    const selectedFacts = facts.slice(0, targetFactCount);

    const finalItems = [...selectedQuizzes, ...selectedVideos, ...selectedFacts];

    // If we don't have enough items to reach the limit, fill from the leftovers
    if (finalItems.length < limit) {
      const selectedIds = new Set(finalItems.map(i => i.id));
      const leftovers = (candidates ?? []).filter((c: any) => !selectedIds.has(c.id));
      
      for (const item of leftovers) {
        if (finalItems.length >= limit) break;
        finalItems.push(item);
      }
    }

    // Shuffle the final items to mix card types
    finalItems.sort(() => Math.random() - 0.5);

    // 4) Shape responses and resolve storage URLs
    const shaped = finalItems.map((c: any) => {
      const base: any = { id: c.id, type: c.type, topic: c.topic, title: c.title };
      if (c.type === "fact") {
        base.tag = c.tag;
        base.body = c.body;
        base.audioUrl = c.audio_path
          ? admin.storage.from("narration").getPublicUrl(c.audio_path).data.publicUrl
          : null;
      } else if (c.type === "quiz") {
        Object.assign(base, c.payload);
        base.question = c.payload?.question ?? c.title;
      } else if (c.type === "video") {
        Object.assign(base, c.payload);
      }
      return base;
    });

    // 5) Log as seen for the user
    if (shaped.length > 0) {
      const seenInserts = shaped.map((i: any) => ({
        user_id: user.id,
        content_id: i.id,
      }));
      const { error: seenErr } = await admin.from("user_seen").insert(seenInserts);
      if (seenErr) {
        console.error("Error marking cards as seen:", seenErr);
      }
    }

    return NextResponse.json({ items: shaped, interest });
  } catch (e) {
    console.error("Unhandled error in /api/feed:", e);
    return NextResponse.json({ error: "internal server error" }, { status: 500 });
  }
}
