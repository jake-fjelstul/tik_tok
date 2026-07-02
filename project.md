# project.md — LearnFeed build plan

> **Read this with `DOCUMENTATION.md`.** That file is the design bible (the "why" and the
> full reference). **This file is the authoritative build artifact**: the file tree, the
> build order, and paste-ready code/SQL. An agent (Cursor / Antigravity) should be able to
> build the entire project from this file. Where a decision isn't spelled out here, follow
> `DOCUMENTATION.md`.

LearnFeed is a personalized, infinite-scroll **learning feed** (a "TikTok for learning"):
full-screen snap cards of facts (read aloud), quizzes (a wrong answer resurfaces the topic
later), and auto-trimmed YouTube clips. It "learns what you like" via a visible interest
vector. Architecture is **producer/consumer**: a home-PC **producer** fills a Supabase
content pool (text + cached narration audio + clips); the always-on **consumer** (Next.js on
Vercel + Supabase) serves from the pool and never depends on the PC being online.

---

## 1. Stack & prerequisites

- **Next.js** (App Router) + **React** + **TypeScript**, deployed on **Vercel**.
- **Tailwind CSS**.
- **Supabase** (Postgres + Storage + anonymous Auth). `@supabase/supabase-js`, `@supabase/ssr`.
- **Producer** (separate Node/TS script run on the home PC): `@supabase/supabase-js`,
  `openai` (used for both Ollama-compatible text and Kokoro TTS), `youtube-transcript`.
- **Kokoro** TTS via Docker (`ghcr.io/eduardolat/kokoro-web`), OpenAI-compatible at `/api/v1`.
- Accounts/keys needed: Supabase project, Vercel project, YouTube Data API key, (optional)
  cloud LLM key if not using Ollama.

---

## 2. Repository file tree

```
learnfeed/
├─ app/
│  ├─ layout.tsx                # root layout, imports globals.css, PWA meta
│  ├─ page.tsx                  # entry: renders <LearnFeed/>
│  ├─ globals.css               # base + fonts
│  └─ api/
│     ├─ feed/route.ts          # POST /api/feed  — serve a personalized batch
│     └─ engage/route.ts        # POST /api/engage — log engagement, update interest
├─ components/
│  └─ LearnFeed.tsx             # client feed: onboarding + cards + meter + narration
├─ lib/
│  ├─ topics.ts                 # taxonomy + colors (shared client/server)
│  ├─ recommender.ts            # softmax topic sampling + constants
│  ├─ supabaseBrowser.ts        # anon client for the browser
│  └─ supabaseServer.ts         # server clients (user-scoped + service role)
├─ producer/                    # runs on the home PC (NOT deployed to Vercel)
│  ├─ producer.ts               # main loop: refill facts/quizzes/clips + cache audio
│  ├─ youtubeClips.ts           # search → transcript → LLM segment → store
│  ├─ llm.ts                    # OpenAI-compatible text gen (Ollama or cloud)
│  └─ package.json              # producer deps + "start" script
├─ supabase/
│  └─ schema.sql                # full DDL + RLS + get_feed RPC + storage bucket
├─ public/
│  ├─ manifest.webmanifest      # PWA manifest
│  └─ sw.js                     # minimal service worker
├─ .env.example
├─ next.config.js
├─ tailwind.config.ts
├─ package.json
└─ README.md
```

---

## 3. `.env.example`

```bash
# ---------- Web app (Vercel) ----------
NEXT_PUBLIC_SUPABASE_URL=https://YOUR-PROJECT.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=YOUR-ANON-KEY
SUPABASE_URL=https://YOUR-PROJECT.supabase.co
SUPABASE_ANON_KEY=YOUR-ANON-KEY
SUPABASE_SERVICE_ROLE_KEY=YOUR-SERVICE-ROLE-KEY   # server routes only, never client

# ---------- Producer (home PC only) ----------
# Text generation — Ollama (OpenAI-compatible) or any cloud OpenAI-compatible API
LLM_BASE_URL=http://localhost:11434/v1            # Ollama; or https://api.openai.com/v1
LLM_API_KEY=ollama                                # any non-empty string for Ollama
LLM_MODEL=llama3.1                                # or gpt-4o-mini, etc.
# Voice — Kokoro Docker (OpenAI-compatible). Swap to ElevenLabs/OpenAI here later.
KOKORO_BASE_URL=http://localhost:3000/api/v1
KOKORO_API_KEY=kokoro
KOKORO_MODEL=model_q8f16
KOKORO_VOICE=af_heart
# YouTube clip discovery
YOUTUBE_API_KEY=YOUR-YOUTUBE-DATA-API-KEY
```

---

## 4. Build order (phases) + acceptance criteria

**Phase 0 — Scaffold.** `create-next-app` (TS, App Router, Tailwind). Add deps. Add
`manifest.webmanifest`, `sw.js`, PWA meta in `layout.tsx`.
✅ App runs locally; installable PWA shell.

**Phase 1 — Database.** Run `supabase/schema.sql`. Create public bucket `narration`.
Enable anonymous auth.
✅ All tables, RLS, `get_feed` RPC, and bucket exist. (FR-9, NFR-4)

**Phase 2 — Producer.** Implement `producer/` (`llm.ts`, `youtubeClips.ts`, `producer.ts`).
Run one pass against Supabase with Ollama + Kokoro running.
✅ Pool fills: ≥1 fact (with `audio_path` set + mp3 in Storage), ≥1 quiz, ≥1 clip per
seeded topic. Re-running only fills the deficit. (§11, §12, FR-7)

**Phase 3 — Serving API.** Implement `/api/feed` and `/api/engage` + `lib/recommender.ts`.
✅ `POST /api/feed` returns a personalized batch with `audioUrl`s, excludes seen items,
and inserts `user_seen`. `POST /api/engage` updates `user_interest` and (on `quiz_wrong`)
inserts `user_weak_topics`. Neither route calls the PC. (FR-6, FR-8, FR-9, FR-10, FR-11)

**Phase 4 — Frontend.** Implement `components/LearnFeed.tsx`: onboarding → feed with
fact/quiz/clip cards, interest meter, narration (cached audio + Web Speech fallback), mute
toggle, prefetch.
✅ All of FR-1..FR-7. Only the active clip plays. Narration reads the paragraph at ~1.25×.
Meter visibly shifts with reactions.

**Phase 5 — Polish/PWA/deploy.** `prefers-reduced-motion`, install prompt, deploy to Vercel,
schedule the producer on the PC.
✅ NFR-1..NFR-6 met; site serves normally with the PC off (NFR-3).

---

## 5. `supabase/schema.sql`

```sql
create extension if not exists "pgcrypto";

-- shared content pool ------------------------------------------------------
create table content (
  id         uuid primary key default gen_random_uuid(),
  type       text not null check (type in ('fact','quiz','video')),
  topic      text not null,
  source     text not null default 'producer',
  title      text,
  body       text,
  tag        text,
  payload    jsonb,
  audio_path text,
  created_at timestamptz not null default now()
);
create index on content (topic);
create index on content (type);

create table youtube_videos (
  video_id   text primary key,
  title      text, channel text, duration_s int, topic text,
  fetched_at timestamptz not null default now()
);
create table youtube_clips (
  id uuid primary key default gen_random_uuid(),
  video_id text references youtube_videos(video_id),
  topic text not null, start_s int not null, end_s int not null,
  transcript_excerpt text, reason text,
  content_id uuid references content(id) on delete set null,
  created_at timestamptz not null default now()
);

-- per-user state -----------------------------------------------------------
create table user_interest (
  user_id uuid references auth.users(id) on delete cascade,
  topic text not null, weight real not null default 0.1,
  updated_at timestamptz not null default now(),
  primary key (user_id, topic)
);
create table user_seen (
  user_id uuid references auth.users(id) on delete cascade,
  content_id uuid references content(id) on delete cascade,
  seen_at timestamptz not null default now(),
  primary key (user_id, content_id)
);
create table user_weak_topics (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  topic text not null, resolved boolean not null default false,
  created_at timestamptz not null default now()
);
create table engagement_log (
  id bigserial primary key,
  user_id uuid references auth.users(id) on delete cascade,
  content_id uuid references content(id) on delete cascade,
  action text not null, dwell_s real,
  created_at timestamptz not null default now()
);

-- future: app-generated videos
create table generated_videos (
  id uuid primary key default gen_random_uuid(),
  source_content_id uuid references content(id) on delete set null,
  topic text, asset_path text,
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

-- serve unseen content in the chosen topics --------------------------------
create or replace function get_feed(p_user uuid, p_topics text[], p_limit int)
returns setof content language sql stable as $$
  select c.* from content c
  where c.topic = any(p_topics)
    and not exists (
      select 1 from user_seen s where s.user_id = p_user and s.content_id = c.id
    )
  order by random()
  limit p_limit;
$$;

-- RLS ----------------------------------------------------------------------
alter table content enable row level security;
alter table youtube_videos enable row level security;
alter table youtube_clips enable row level security;
alter table user_interest enable row level security;
alter table user_seen enable row level security;
alter table user_weak_topics enable row level security;
alter table engagement_log enable row level security;

create policy "content public read" on content for select using (true);
create policy "yt videos public read" on youtube_videos for select using (true);
create policy "yt clips public read" on youtube_clips for select using (true);

create policy "own interest" on user_interest
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own seen" on user_seen
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own weak" on user_weak_topics
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own engagement" on engagement_log
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Storage bucket (or create in dashboard): public read narration
insert into storage.buckets (id, name, public) values ('narration','narration', true)
  on conflict (id) do nothing;
```

> Service-role writes (the producer and server routes) bypass RLS, so pool inserts and
> server-side per-user writes work with an explicit `user_id`.

---

## 6. `lib/topics.ts`

```ts
export const TOPICS: Record<string, string> = {
  "Space": "#6C8CFF",
  "Programming & Building": "#2FC3D6",
  "AI & Machine Learning": "#13C2A6",
  "Biology & Nature": "#36C46A",
  "Health & Body": "#8FD14F",
  "Cooking & Food": "#E0A93B",
  "History": "#E07A3B",
  "How Things Work": "#E0563B",
  "Art & Design": "#E04B8A",
  "Psychology & Mind": "#C45BE0",
  "Philosophy": "#9B5BE0",
  "Language & Words": "#6B6BEA",
  "Money & Economics": "#E0C53B",
  "Physics": "#3B9EE0",
  "Skills & Productivity": "#E07ABF",
};
export const TOPIC_NAMES = Object.keys(TOPICS);
export const BASELINE = 0.1;
```

---

## 7. `lib/recommender.ts`

```ts
import { TOPIC_NAMES } from "./topics";

export const DELTAS = { dwell: 0.15, up: 0.6, down: -0.8, quiz_correct: 0.3, quiz_wrong: 0.1, video_open: 0.4 };
export const DECAY = 0.997, CLAMP_MIN = 0.1, CLAMP_MAX = 5.0, TEMPERATURE = 0.6;

export function softmaxSample(weights: Record<string, number>, k: number, temp = TEMPERATURE): string[] {
  const pool = Object.entries(weights).map(([t, w]) => [t, Math.exp(w / temp)] as [string, number]);
  const picked: string[] = [];
  while (picked.length < k && pool.length) {
    const total = pool.reduce((s, [, e]) => s + e, 0);
    let r = Math.random() * total, idx = 0;
    for (let i = 0; i < pool.length; i++) { r -= pool[i][1]; if (r <= 0) { idx = i; break; } }
    picked.push(pool[idx][0]); pool.splice(idx, 1);
  }
  return picked;
}

// 3 exploit + 1 explore (+ caller may append a weak/reinforce topic)
export function chooseBatchTopics(interest: Record<string, number>): string[] {
  const filled = Object.fromEntries(TOPIC_NAMES.map(t => [t, interest[t] ?? CLAMP_MIN]));
  const exploit = softmaxSample(filled, 3);
  const rest = TOPIC_NAMES.filter(t => !exploit.includes(t));
  const explore = rest[Math.floor(Math.random() * rest.length)];
  return [...exploit, explore];
}

export function applyDelta(interest: Record<string, number>, topic: string, delta: number) {
  const next = { ...interest };
  next[topic] = Math.min(CLAMP_MAX, Math.max(CLAMP_MIN, (next[topic] ?? CLAMP_MIN) + delta));
  for (const t of TOPIC_NAMES) next[t] = Math.max(CLAMP_MIN, (next[t] ?? CLAMP_MIN) * DECAY);
  return next;
}
```

---

## 8. `lib/supabaseBrowser.ts` and `lib/supabaseServer.ts`

```ts
// lib/supabaseBrowser.ts
import { createBrowserClient } from "@supabase/ssr";
export const supabaseBrowser = () =>
  createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
```

```ts
// lib/supabaseServer.ts
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

// user-scoped (RLS) client, reads the anon session from cookies
export async function supabaseUser() {
  const cookieStore = await cookies();
  return createServerClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (all) => all.forEach(({ name, value, options }) => cookieStore.set(name, value, options)),
    },
  });
}
// privileged client for pool reads + explicit per-user writes (bypasses RLS)
export const supabaseAdmin = () =>
  createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
```

---

## 9. `app/api/feed/route.ts`

```ts
import { NextResponse } from "next/server";
import { supabaseUser, supabaseAdmin } from "@/lib/supabaseServer";
import { chooseBatchTopics } from "@/lib/recommender";

export async function POST(req: Request) {
  const { limit = 8 } = await req.json().catch(() => ({}));
  const u = await supabaseUser();
  const { data: { user } } = await u.auth.getUser();
  if (!user) return NextResponse.json({ error: "no session" }, { status: 401 });

  const admin = supabaseAdmin();

  // 1) interest vector
  const { data: rows } = await admin.from("user_interest").select("topic,weight").eq("user_id", user.id);
  const interest: Record<string, number> = Object.fromEntries((rows ?? []).map(r => [r.topic, r.weight]));
  const topics = chooseBatchTopics(interest);

  // 2) reinforce one unresolved weak topic (adaptive quizzes)
  const { data: weak } = await admin.from("user_weak_topics")
    .select("id,topic").eq("user_id", user.id).eq("resolved", false).limit(1);
  if (weak?.[0]) { topics.push(weak[0].topic); await admin.from("user_weak_topics").update({ resolved: true }).eq("id", weak[0].id); }

  // 3) unseen content in those topics
  const { data: items } = await admin.rpc("get_feed", { p_user: user.id, p_topics: topics, p_limit: limit });

  // 4) shape + public audio URLs
  const shaped = (items ?? []).map((c: any) => {
    const base: any = { id: c.id, type: c.type, topic: c.topic, title: c.title };
    if (c.type === "fact") {
      base.tag = c.tag; base.body = c.body;
      base.audioUrl = c.audio_path ? admin.storage.from("narration").getPublicUrl(c.audio_path).data.publicUrl : null;
    } else if (c.type === "quiz") {
      Object.assign(base, c.payload); // {question?, options, correct, explain}  (store question in payload or title)
      base.question = c.payload?.question ?? c.title;
    } else if (c.type === "video") {
      Object.assign(base, c.payload); // {videoId, start, end, channel}
    }
    return base;
  });

  // 5) mark seen
  if (shaped.length) await admin.from("user_seen").insert(shaped.map((i: any) => ({ user_id: user.id, content_id: i.id })));

  return NextResponse.json({ items: shaped, interest });
}
```

> Decide where the quiz question lives: simplest is `payload.question`. Keep `options`,
> `correct`, `explain` in `payload` too. Be consistent in the producer.

---

## 10. `app/api/engage/route.ts`

```ts
import { NextResponse } from "next/server";
import { supabaseUser, supabaseAdmin } from "@/lib/supabaseServer";
import { DELTAS, DECAY, CLAMP_MIN, CLAMP_MAX } from "@/lib/recommender";
import { TOPIC_NAMES } from "@/lib/topics";

export async function POST(req: Request) {
  const { contentId, topic, action, dwellS } = await req.json();
  const u = await supabaseUser();
  const { data: { user } } = await u.auth.getUser();
  if (!user) return NextResponse.json({ error: "no session" }, { status: 401 });
  const admin = supabaseAdmin();

  await admin.from("engagement_log").insert({ user_id: user.id, content_id: contentId, action, dwell_s: dwellS ?? null });

  const delta = (DELTAS as any)[action] ?? 0;
  if (topic && delta !== 0) {
    const { data: rows } = await admin.from("user_interest").select("topic,weight").eq("user_id", user.id);
    const interest: Record<string, number> = Object.fromEntries((rows ?? []).map(r => [r.topic, r.weight]));
    interest[topic] = Math.min(CLAMP_MAX, Math.max(CLAMP_MIN, (interest[topic] ?? CLAMP_MIN) + delta));
    for (const t of TOPIC_NAMES) interest[t] = Math.max(CLAMP_MIN, (interest[t] ?? CLAMP_MIN) * DECAY);
    const upserts = Object.entries(interest).map(([t, w]) => ({ user_id: user.id, topic: t, weight: w }));
    await admin.from("user_interest").upsert(upserts);
  }
  if (action === "quiz_wrong" && topic)
    await admin.from("user_weak_topics").insert({ user_id: user.id, topic });

  const { data: rows2 } = await admin.from("user_interest").select("topic,weight").eq("user_id", user.id);
  return NextResponse.json({ interest: Object.fromEntries((rows2 ?? []).map(r => [r.topic, r.weight])) });
}
```

---

## 11. `producer/llm.ts`

```ts
import OpenAI from "openai";
const llm = new OpenAI({ baseURL: process.env.LLM_BASE_URL, apiKey: process.env.LLM_API_KEY || "x" });
const MODEL = process.env.LLM_MODEL!;

async function jsonArray(prompt: string): Promise<any[]> {
  const r = await llm.chat.completions.create({
    model: MODEL,
    messages: [{ role: "system", content: "Output only a valid JSON array. No markdown." },
               { role: "user", content: prompt }],
  });
  const txt = r.choices[0]?.message?.content ?? "";
  return JSON.parse(txt.slice(txt.indexOf("["), txt.lastIndexOf("]") + 1));
}

export const genFacts = (topic: string, n: number) => jsonArray(
  `Generate ${n} surprising, specific fact cards about "${topic}" for a curious adult.
Each: {"title":"<=9 words","tag":"1-3 words","body":"2 sentences written to be spoken aloud"}.
JSON array only.`);

export const genQuizzes = (topic: string, n: number) => jsonArray(
  `Generate ${n} multiple-choice quiz cards about "${topic}".
Each: {"question":"...","options":["a","b","c","d"],"correct":<0-3>,"explain":"1 sentence"}.
JSON array only.`);

export { llm };
```

---

## 12. `producer/youtubeClips.ts`

```ts
import { YoutubeTranscript } from "youtube-transcript";
import { createClient } from "@supabase/supabase-js";
import { llm } from "./llm";

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const YT = process.env.YOUTUBE_API_KEY!;

const iso = (d: string) => { const m = d.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/) || []; return (+(m[1]||0))*3600+(+(m[2]||0))*60+(+(m[3]||0)); };

async function search(q: string, max = 6): Promise<string[]> {
  const u = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoEmbeddable=true&maxResults=${max}&q=${encodeURIComponent(q)}&key=${YT}`;
  const d = await (await fetch(u)).json();
  return (d.items ?? []).map((i: any) => i.id.videoId).filter(Boolean);
}
async function details(ids: string[]) {
  const u = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&id=${ids.join(",")}&key=${YT}`;
  const d = await (await fetch(u)).json();
  return (d.items ?? []).map((v: any) => ({ videoId: v.id, title: v.snippet.title, channel: v.snippet.channelTitle, duration_s: iso(v.contentDetails.duration), views: +(v.statistics?.viewCount ?? 0) }));
}
async function pickSegment(videoId: string, topic: string) {
  let tr: any[]; try { tr = await YoutubeTranscript.fetchTranscript(videoId); } catch { return null; }
  const lines = tr.map(t => `[${Math.floor(t.offset / 1000)}] ${t.text}`).join("\n").slice(0, 8000); // verify offset units
  const r = await llm.chat.completions.create({
    model: process.env.LLM_MODEL!,
    messages: [{ role: "system", content: "Output only minified JSON." },
      { role: "user", content: `Transcript lines with [second] timestamps. Pick the single most engaging 20-40s segment that best teaches "${topic}". Return {"start":<sec>,"end":<sec>,"excerpt":"...","reason":"..."}.\n\n${lines}` }],
  });
  const txt = r.choices[0]?.message?.content ?? "";
  try { return JSON.parse(txt.slice(txt.indexOf("{"), txt.lastIndexOf("}") + 1)); } catch { return null; }
}

export async function findAndStoreClip(topic: string): Promise<boolean> {
  const ids = await search(`${topic} explained`);
  if (!ids.length) return false;
  const cands = (await details(ids)).sort((a, b) => b.views - a.views);
  for (const v of cands) {
    if (v.duration_s < 60 || v.duration_s > 1800) continue;
    const seg = await pickSegment(v.videoId, topic);
    if (!seg || typeof seg.start !== "number") continue;
    await supabase.from("youtube_videos").upsert({ video_id: v.videoId, title: v.title, channel: v.channel, duration_s: v.duration_s, topic });
    const { data: c } = await supabase.from("content").insert({
      type: "video", topic, source: "youtube", title: v.title,
      payload: { videoId: v.videoId, start: seg.start, end: seg.end, channel: v.channel },
    }).select("id").single();
    await supabase.from("youtube_clips").insert({ video_id: v.videoId, topic, start_s: seg.start, end_s: seg.end, transcript_excerpt: seg.excerpt ?? null, reason: seg.reason ?? null, content_id: c?.id ?? null });
    return true;
  }
  return false;
}
```

---

## 13. `producer/producer.ts`

```ts
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { TOPIC_NAMES } from "../lib/topics"; // or copy the list locally
import { genFacts, genQuizzes } from "./llm";
import { findAndStoreClip } from "./youtubeClips";

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const tts = new OpenAI({ baseURL: process.env.KOKORO_BASE_URL, apiKey: process.env.KOKORO_API_KEY || "x" });

const TARGET_FACTS = 200, TARGET_QUIZZES = 60, TARGET_CLIPS = 30, BATCH = 10;

async function count(topic: string, type: string) {
  const { count } = await supabase.from("content").select("*", { count: "exact", head: true }).eq("topic", topic).eq("type", type);
  return count ?? 0;
}
async function synthAndUpload(id: string, text: string) {
  const mp3 = await tts.audio.speech.create({ model: process.env.KOKORO_MODEL || "model_q8f16", voice: process.env.KOKORO_VOICE || "af_heart", input: text } as any);
  const buf = Buffer.from(await mp3.arrayBuffer());
  await supabase.storage.from("narration").upload(`${id}.mp3`, buf, { contentType: "audio/mpeg", upsert: true });
  return `${id}.mp3`;
}

async function refillFacts(topic: string) {
  const need = TARGET_FACTS - await count(topic, "fact"); if (need <= 0) return;
  for (const f of await genFacts(topic, Math.min(need, BATCH))) {
    const { data } = await supabase.from("content").insert({ type: "fact", topic, source: "producer", title: f.title, tag: f.tag, body: f.body }).select("id").single();
    if (!data) continue;
    try { const p = await synthAndUpload(data.id, f.body); await supabase.from("content").update({ audio_path: p }).eq("id", data.id); }
    catch (e) { console.error("tts", e); /* leave null -> Web Speech fallback */ }
  }
}
async function refillQuizzes(topic: string) {
  const need = TARGET_QUIZZES - await count(topic, "quiz"); if (need <= 0) return;
  for (const q of await genQuizzes(topic, Math.min(need, BATCH)))
    await supabase.from("content").insert({ type: "quiz", topic, source: "producer", title: q.question, payload: { question: q.question, options: q.options, correct: q.correct, explain: q.explain } });
}
async function refillClips(topic: string) {
  if (await count(topic, "video") >= TARGET_CLIPS) return;
  try { await findAndStoreClip(topic); } catch (e) { console.error("clip", topic, e); }
}

async function pass() {
  for (const topic of TOPIC_NAMES) {
    try { await refillFacts(topic); await refillQuizzes(topic); await refillClips(topic); }
    catch (e) { console.error(topic, e); }
  }
  console.log("refill pass complete");
}
pass();
```

> Schedule `pass()` on a loop or via Task Scheduler/cron so the pool stays topped up while
> the PC is on. It only fills the deficit, so it's safe to run often.

---

## 14. `components/LearnFeed.tsx` (client)

This is the full feed, wired to the API. It handles anonymous sign-in, onboarding,
snap-scroll cards, the interest meter, narration (cached audio + Web Speech fallback),
adaptive-quiz reporting, and prefetch. (Adapt styling to Tailwind or keep the scoped CSS.)

```tsx
"use client";
import React, { useEffect, useRef, useState, useCallback } from "react";
import { supabaseBrowser } from "@/lib/supabaseBrowser";
import { TOPICS, TOPIC_NAMES } from "@/lib/topics";

type Item = any;
const RATE = 1.25;

async function api(path: string, body: any, token: string) {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  return r.json();
}

export default function LearnFeed() {
  const sb = useRef(supabaseBrowser());
  const [token, setToken] = useState<string | null>(null);
  const [phase, setPhase] = useState<"loading" | "onboard" | "feed">("loading");
  const [items, setItems] = useState<Item[]>([]);
  const [interest, setInterest] = useState<Record<string, number>>({});
  const [active, setActive] = useState(0);
  const [soundOn, setSoundOn] = useState(true);
  const [loading, setLoading] = useState(false);
  const cardRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const soundRef = useRef(true); useEffect(() => { soundRef.current = soundOn; if (!soundOn) stopAudio(); }, [soundOn]);
  const enter = useRef({ idx: 0, t: Date.now() });
  const loadingRef = useRef(false);

  // anon sign-in
  useEffect(() => { (async () => {
    const s = sb.current; let { data } = await s.auth.getSession();
    if (!data.session) { await s.auth.signInAnonymously(); ({ data } = await s.auth.getSession()); }
    setToken(data.session!.access_token);
    const { data: interestRows } = await s.from("user_interest").select("topic").eq("user_id", data.session!.user.id).limit(1);
    setPhase(interestRows && interestRows.length ? "feed" : "onboard");
  })(); }, []);
  useEffect(() => { if (phase === "feed" && token) loadMore(); }, [phase, token]);

  function stopAudio() { if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; } window.speechSynthesis?.cancel(); }
  function narrate(it: Item) {
    stopAudio(); if (!soundRef.current || it.type !== "fact") return;
    if (it.audioUrl) { const a = new Audio(it.audioUrl); a.playbackRate = RATE; audioRef.current = a; a.play().catch(() => speak(it.body)); }
    else speak(it.body);
  }
  function speak(text: string) { const synth = window.speechSynthesis; if (!synth || !text) return; synth.cancel(); const u = new SpeechSynthesisUtterance(text); u.rate = RATE; synth.speak(u); }

  const loadMore = useCallback(async () => {
    if (loadingRef.current || !token) return; loadingRef.current = true; setLoading(true);
    const { items: batch, interest: nx } = await api("/api/feed", { limit: 8 }, token);
    if (nx) setInterest(nx);
    if (batch?.length) setItems(p => [...p, ...batch]);
    loadingRef.current = false; setLoading(false);
  }, [token]);

  async function engage(it: Item, action: string, dwellS?: number) {
    if (!token) return; const { interest: nx } = await api("/api/engage", { contentId: it.id, topic: it.topic, action, dwellS }, token);
    if (nx) setInterest(nx);
  }

  async function start(picks: string[]) {
    const s = sb.current; const { data } = await s.auth.getUser();
    const rows = TOPIC_NAMES.map(t => ({ user_id: data.user!.id, topic: t, weight: picks.includes(t) ? 1.0 : 0.1 }));
    await s.from("user_interest").upsert(rows);
    if (window.speechSynthesis) try { window.speechSynthesis.speak(new SpeechSynthesisUtterance(" ")); } catch {}
    setPhase("feed");
  }

  // IntersectionObserver: active card, dwell, narration, prefetch
  useEffect(() => {
    if (phase !== "feed") return;
    const obs = new IntersectionObserver((entries) => {
      let best: number | null = null;
      for (const e of entries) if (e.isIntersecting && e.intersectionRatio > 0.6) best = Number((e.target as HTMLElement).dataset.idx);
      if (best === null || best === enter.current.idx) return;
      const prev = enter.current; const dwell = (Date.now() - prev.t) / 1000;
      const prevItem = items[prev.idx]; if (prevItem && dwell >= 4) engage(prevItem, "dwell", dwell);
      enter.current = { idx: best, t: Date.now() }; setActive(best); narrate(items[best]);
      if (items.length - best <= 4) loadMore();
    }, { threshold: [0.61] });
    Object.values(cardRefs.current).forEach(el => el && obs.observe(el));
    return () => obs.disconnect();
  }, [phase, items.length]);

  if (phase === "loading") return <div className="lf-center">Loading…</div>;
  if (phase === "onboard") return <Onboarding onStart={start} />;

  return (
    <div className="lf-root">
      <Meter interest={interest} />
      <button className="lf-sound" onClick={() => setSoundOn(s => !s)}>{soundOn ? "🔊" : "🔇"}</button>
      <div className="lf-feed">
        {items.map((it, idx) => (
          <div key={it.id} data-idx={idx} ref={el => (cardRefs.current[idx] = el)}>
            {it.type === "fact" && <FactCard item={it} onReact={(a: string) => engage(it, a)} />}
            {it.type === "quiz" && <QuizCard item={it} onAnswer={(c: boolean) => engage(it, c ? "quiz_correct" : "quiz_wrong")} />}
            {it.type === "video" && <VideoClipCard item={it} isActive={idx === active} onOpen={() => engage(it, "video_open")} />}
          </div>
        ))}
        <div className="lf-card"><div className="lf-center">{loading ? "Generating your feed…" : "Keep scrolling"}</div></div>
      </div>
    </div>
  );
}
```

Card subcomponents (`FactCard`, `QuizCard`, `VideoClipCard`, `Meter`, `Onboarding`) follow
the reference UI in the design bible: topic-hued cards, thumbs reaction bar, quiz reveal +
explanation, and a YouTube iframe rendered **only** for the active clip:

```tsx
function VideoClipCard({ item, isActive, onOpen }: any) {
  const hue = TOPICS[item.topic];
  const src = `https://www.youtube.com/embed/${item.videoId}?start=${item.start}&end=${item.end}&autoplay=1&mute=1&playsinline=1&rel=0&modestbranding=1`;
  return (
    <div className="lf-card">
      <div className="lf-eyebrow" style={{ color: hue }}>{item.topic} · {item.channel}</div>
      <div className="lf-playerwrap">
        {isActive ? <iframe className="lf-iframe" src={src} allow="autoplay; encrypted-media; picture-in-picture" allowFullScreen /> : <div className="lf-poster" />}
      </div>
      <h3 className="lf-vtitle">{item.title}</h3>
      <button className="lf-watch" style={{ background: hue }} onClick={() => { onOpen(); window.open(`https://www.youtube.com/watch?v=${item.videoId}&t=${item.start}s`, "_blank"); }}>Watch full on YouTube</button>
    </div>
  );
}
```

> The complete, styled implementation of these components (CSS, fonts, interest meter sheet,
> onboarding chips, reaction bar, quiz reveal) is the reference build in `DOCUMENTATION.md`
> §14. Port it verbatim and only change data wiring to the API as shown above.

---

## 15. PWA

`public/manifest.webmanifest`:
```json
{ "name": "LearnFeed", "short_name": "LearnFeed", "start_url": "/", "display": "standalone",
  "background_color": "#0B0D14", "theme_color": "#0B0D14",
  "icons": [{ "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
            { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" }] }
```
Register `sw.js` (a minimal cache-first shell SW) in `layout.tsx`, and link the manifest +
`theme-color` meta. Respect `prefers-reduced-motion` in all animations.

---

## 16. Commands

```bash
# web app
npm install
npm run dev            # local
vercel                 # deploy (set env vars in the Vercel dashboard)

# database
# paste supabase/schema.sql in the Supabase SQL editor; enable anonymous auth;
# confirm the 'narration' public bucket exists.

# producer (home PC)
cd producer && npm install
docker run -d -p 3000:3000 -e KW_SECRET_API_KEY=kokoro ghcr.io/eduardolat/kokoro-web:latest
ollama serve &         # if using Ollama for text
npm start              # runs one refill pass (schedule via cron/Task Scheduler)
```

---

## 17. Conventions & guardrails

- TypeScript strict. No secrets in client code — `SUPABASE_SERVICE_ROLE_KEY`, `YOUTUBE_API_KEY`,
  and LLM/Kokoro creds live only on the server route env (Vercel) or the producer (PC).
- The web app and serving routes must **never** call the home PC. All personalization reads
  the pre-built pool. (NFR-3, FR-10)
- Producer writes are idempotent on pool depth (fill the deficit only).
- Keep `payload` shapes consistent between producer and `/api/feed` (quiz: `{question,
  options, correct, explain}`; video: `{videoId, start, end, channel}`).
- Validate all LLM JSON before insert; drop malformed items rather than failing the pass.

---

## 18. Definition of done

- [ ] Schema, RLS, `get_feed`, and `narration` bucket exist (Phase 1).
- [ ] One producer pass fills facts (+cached mp3), quizzes, and clips per topic (Phase 2).
- [ ] `/api/feed` serves personalized, non-repeating batches with `audioUrl`; `/api/engage`
      updates interest + schedules weak-topic refreshers (Phase 3).
- [ ] Feed UI: onboarding, snap cards, narration (cached + fallback), mute, live meter,
      only-active-clip playback, adaptive quiz resurfacing, prefetch (Phase 4).
- [ ] PWA installable; site serves normally with the PC off; deployed to Vercel (Phase 5).
