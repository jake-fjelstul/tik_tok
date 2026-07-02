import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";

export async function GET() {
  try {
    const admin = supabaseAdmin();
    const { data, error } = await admin
      .from("music")
      .select("id, title, public_url");
    if (error) throw error;
    const filtered = (data || []).filter((t: any) => 
      t.public_url && /\.(mp3|wav|m4a)$/i.test(t.public_url)
    );
    return NextResponse.json({ tracks: filtered });
  } catch (err: any) {
    console.error("Error in /api/music:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
