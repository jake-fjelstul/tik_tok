import { NextResponse } from "next/server";
import { supabaseUser, supabaseAdmin } from "@/lib/supabaseServer";
import { DELTAS, DECAY, CLAMP_MIN, CLAMP_MAX } from "@/lib/recommender";
import { TOPIC_NAMES } from "@/lib/topics";

export async function POST(req: Request) {
  try {
    const { contentId, topic, action, dwellS } = await req.json();
    
    // Authenticate the user session via cookies
    const u = await supabaseUser();
    const { data: { user }, error: authErr } = await u.auth.getUser();
    if (authErr || !user) {
      return NextResponse.json({ error: "no session" }, { status: 401 });
    }

    const admin = supabaseAdmin();

    // 1) Log the engagement action
    const { error: logErr } = await admin
      .from("engagement_log")
      .insert({ 
        user_id: user.id, 
        content_id: contentId, 
        action, 
        dwell_s: dwellS ?? null 
      });
      
    if (logErr) {
      console.error("Engagement logging error:", logErr);
    }

    // 2) Update weights if the action carries a delta
    const delta = (DELTAS as any)[action] ?? 0;
    if (topic && delta !== 0) {
      const { data: rows, error: interestErr } = await admin
        .from("user_interest")
        .select("topic,weight")
        .eq("user_id", user.id);
        
      if (interestErr) {
        console.error("Error fetching interest weights on engage:", interestErr);
      }

      // Initialize all topics in the local record to default baseline to guarantee decay is recorded
      const interest: Record<string, number> = {};
      for (const name of TOPIC_NAMES) {
        interest[name] = CLAMP_MIN;
      }
      (rows ?? []).forEach(r => {
        interest[r.topic] = r.weight;
      });

      // Apply delta update to target topic
      interest[topic] = Math.min(CLAMP_MAX, Math.max(CLAMP_MIN, (interest[topic] ?? CLAMP_MIN) + delta));
      
      // Decay all other topics
      for (const t of TOPIC_NAMES) {
        if (t !== topic) {
          interest[t] = Math.max(CLAMP_MIN, (interest[t] ?? CLAMP_MIN) * DECAY);
        }
      }

      const upserts = Object.entries(interest).map(([t, w]) => ({
        user_id: user.id,
        topic: t,
        weight: w,
        updated_at: new Date().toISOString()
      }));

      const { error: upsertErr } = await admin.from("user_interest").upsert(upserts);
      if (upsertErr) {
        console.error("Error upserting interest vector updates:", upsertErr);
      }
    }

    // 3) Mark topic as weak on wrong quiz answer
    if (action === "quiz_wrong" && topic) {
      const { error: weakErr } = await admin
        .from("user_weak_topics")
        .insert({ user_id: user.id, topic });
        
      if (weakErr) {
        console.error("Error scheduling weak topic refresher:", weakErr);
      }
    }

    // Return the updated interest vector
    const { data: rows2, error: fetchErr } = await admin
      .from("user_interest")
      .select("topic,weight")
      .eq("user_id", user.id);
      
    if (fetchErr) {
      console.error("Error fetching updated interest vector:", fetchErr);
    }

    const finalInterest = Object.fromEntries(
      (rows2 ?? []).map(r => [r.topic, r.weight])
    );

    return NextResponse.json({ interest: finalInterest });
  } catch (e) {
    console.error("Unhandled error in /api/engage:", e);
    return NextResponse.json({ error: "internal server error" }, { status: 500 });
  }
}
