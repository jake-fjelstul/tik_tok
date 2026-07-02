# LearnFeed — Documentation & Requirements

> This is the design bible. It describes **what** LearnFeed is, **why** it is built
> the way it is, and the **complete reference** for the data model, algorithms, and
> requirements. For the step-by-step build plan, file tree, and paste-ready code, see
> **`project.md`** — that file is the authoritative build artifact. This file is the
> detail an agent consults when it needs the reasoning or the exact contract behind a
> piece of `project.md`.

---

## 1. Overview

LearnFeed is a personalized, infinite-scroll learning feed designed to replace mindless
phone scrolling (Instagram/YouTube) with content the user actually learns from. It mimics
the mechanics that make social feeds addictive — variable reward, low friction, a feed
that "learns what you like" — but redirects them toward education, and crucially makes the
personalization **visible** to the user rather than hidden.

The feed is a vertical, full-screen, snap-scrolling stack of cards. There are three card
types:

- **Fact cards** — a short, surprising paragraph on a topic, **read aloud** by a natural
  TTS voice as the card becomes active.
- **Quiz cards** — a one-question multiple-choice check. Getting one wrong causes a card
  on the same topic to **resurface later** in the scroll.
- **Video clip cards** — a YouTube video discovered and trimmed to its single most
  relevant ~20–40s segment, played inline; tapping opens the full video at that timestamp.

The system "learns what you like" with a transparent **interest vector** that updates from
your engagement (dwell time, thumbs, quiz results, video opens). A visible "Tuning to"
meter shows the vector shifting in real time.

### 1.1 Goals
- Replace the boredom-scroll habit with a habit that teaches.
- Feel as low-friction and rewarding as a social feed.
- Personalize quickly and **legibly** (the user can see what it learned).
- Work as a phone web app (PWA), opened from the browser.

### 1.2 Non-goals
- Not a social network (no following, posting, or DMs).
- Not a course platform (no linear curricula, no certificates).
- No native mobile app in v1 (PWA only).

---

## 2. Core concepts & terminology

| Term | Meaning |
|---|---|
| **Content pool** | The large, pre-generated set of cards stored in Supabase, ready to serve. |
| **Producer** | A worker on the user's home PC that fills the pool (text, audio, clips). Runs only when the PC is on. |
| **Consumer** | The always-on serving path: Vercel (Next.js) + Supabase. Reads the pool; never calls the PC. |
| **Interest vector** | Per-user map of `topic → weight`; the personalization state. |
| **Seen set** | Per-user record of content already served, used to avoid repeats. |
| **Weak topic** | A topic on which the user recently missed a quiz; scheduled for a refresher card. |
| **Offline runway** | How long the live site keeps serving good content while the PC is off — a function of pool depth. |

---

## 3. System architecture

LearnFeed uses a **producer/consumer split** with the database as the buffer between them.

```
            You (browser, PWA)
                   │  reads/serves
                   ▼
   ┌──────────── ALWAYS ON ─────────────┐
   │  Vercel (Next.js feed API)  ◀────▶  Supabase                  │
   │                                     (Postgres pool + Storage) │
   └──────────────────────────────────────────────▲───────────────┘
                                                   │ fills the pool (write only)
   ┌──────── HOME PC — on intermittently ──────────┴───────────────┐
   │  Producer worker  ◀── Text (Ollama / cloud API)               │
   │                   ◀── Voice (Kokoro, Docker, OpenAI-compatible)│
   │                   ◀── Clips (YouTube Data API + transcript)    │
   └───────────────────────────────────────────────────────────────┘
```

**The single most important architectural rule: the home PC is never in the request
path.** The PC is a *producer* that writes ready-to-serve content (text + cached narration
audio + selected clips) into Supabase. The live site is a *consumer* that only ever reads
from Supabase. As long as the pool is deep enough, the PC can be off for days and the site
works normally.

Two properties make this robust:
1. **Cached audio.** Narration mp3s are generated once at content-creation time and stored
   in Supabase Storage, so serving a fact card never requires the TTS service to be online.
2. **Per-user seen, shared pool.** Dedup is per user (`user_seen`), but the content pool is
   shared across all users. So the pool does not deplete globally as people scroll — content
   is reused across users, and the producer only needs to add *new* content for variety, not
   keep pace with consumption.

---

## 4. Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Frontend | **Next.js (App Router) + React + TypeScript** | Hosted on Vercel. Mobile-first PWA. |
| Styling | Tailwind CSS (or scoped CSS) | Dark, feed-style UI. |
| Backend / DB | **Supabase** (Postgres + Storage + Auth) | Single source of truth = the content pool. |
| Serving API | Next.js Route Handlers on Vercel | `/api/feed`, `/api/engage`. Always on. |
| Auth | Supabase **anonymous auth** | Frictionless; gives every user an `auth.users` id for RLS. |
| Text generation | **Ollama** (home PC) or any **OpenAI-compatible API** | Producer-side only. |
| Voice (TTS) | **Kokoro** via Docker (`ghcr.io/eduardolat/kokoro-web`), OpenAI-compatible endpoint | Producer-side. $0 marginal cost. Swappable for ElevenLabs/OpenAI by changing base URL + key. |
| Video clips | **YouTube Data API v3** + `youtube-transcript` + LLM segment selection | Producer-side. |
| Producer runtime | Node + TypeScript script (cron/loop on the PC) | Uses Supabase service role key. |

---

## 5. Functional requirements

IDs are referenced by `project.md` acceptance criteria.

- **FR-1 Onboarding.** On first launch, the user picks ≥3 topics from the taxonomy (§9).
  These seed the interest vector. An anonymous Supabase session is created.
- **FR-2 Feed.** A vertical, full-screen, snap-scrolling feed. Each card fills the
  viewport. Scrolling is smooth on mobile.
- **FR-3 Fact cards.** Show topic eyebrow, optional tag/kicker, title, and a 2-sentence
  body. The body is **read aloud** when the card becomes active (see FR-7).
- **FR-4 Quiz cards.** Show a question and 4 options. On tap, reveal correct/incorrect +
  a one-sentence explanation. Disable after answering.
- **FR-5 Video clip cards.** Embed a YouTube clip that auto-plays muted, trimmed to
  `[start, end]`, and only the currently-active card plays. A "Watch full on YouTube"
  action opens `https://www.youtube.com/watch?v=<id>&t=<start>s`.
- **FR-6 Personalization.** An interest vector updates from engagement and steers which
  topics appear next (see §10). A visible "Tuning to" meter reflects the vector; tapping
  it opens a sheet listing all topics ranked by weight.
- **FR-7 Narration.** Fact card bodies are narrated using cached audio from Supabase
  Storage. If the audio is missing/not ready, fall back to the browser Web Speech API.
  Playback rate ≈ 1.25×. A mute toggle is always visible; muting cancels current speech.
- **FR-8 Adaptive quizzes.** A wrong quiz answer marks the topic "weak" and schedules a
  refresher card on that topic to appear later in the scroll (4–8 cards later).
- **FR-9 No repeats.** Content already served to a user is not served again (`user_seen`).
- **FR-10 Offline resilience.** With the home PC off, the site continues to serve a good,
  varied, personalized feed from the pool. (See NFR-3.)
- **FR-11 Engagement logging.** Dwell, thumbs up/down, quiz result, and video open are
  recorded and update the interest vector via an always-on endpoint.

---

## 6. Non-functional requirements

- **NFR-1 Performance.** First feed batch renders < 1.5s on a warm session. Narration audio
  is a cached file (no per-card synthesis at request time). Next batch prefetches before the
  user reaches the end.
- **NFR-2 Cost.** Marginal serving cost ≈ storage + Vercel/Supabase free-tier usage. TTS via
  self-hosted Kokoro = $0/char. Text via Ollama = $0; cloud API optional.
- **NFR-3 Offline runway.** Target pool depth ≥ **200 fact cards** and ≥ **30 clips** *per
  topic*. With per-user dedup over a shared pool, this serves heavy use for many days with
  the PC off.
- **NFR-4 Privacy/security.** Service role key only on the producer and server routes, never
  shipped to the client. RLS protects per-user tables. Content is public-read.
- **NFR-5 Accessibility.** Respect `prefers-reduced-motion`. Narration is optional/mutable.
  Sufficient contrast on the dark theme.
- **NFR-6 PWA.** Installable ("Add to Home Screen"), with a manifest and service worker.

---

## 7. Data model

Postgres (Supabase). UUIDs via `gen_random_uuid()` (`pgcrypto`). Per-user tables key off
`auth.users(id)` and are protected by RLS. The full DDL lives in `project.md`; this is the
data dictionary and the rationale.

### Tables

**`content`** — the shared content pool (every card).
| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `type` | text | `fact` \| `quiz` \| `video` |
| `topic` | text | one of the taxonomy strings (§9) |
| `source` | text | `producer` \| `youtube` \| `llm` |
| `title` | text | hook (fact/video) |
| `body` | text | the spoken paragraph (fact) |
| `tag` | text | 1–3 word kicker (fact) |
| `payload` | jsonb | quiz: `{options, correct, explain}`; video: `{videoId, start, end, channel}` |
| `audio_path` | text | Storage object path of the narration mp3 (fact); nullable |
| `created_at` | timestamptz | |

**`youtube_videos`** — cache of discovered videos (avoid re-hitting the API).
`video_id` PK, `title`, `channel`, `duration_s`, `topic`, `fetched_at`.

**`youtube_clips`** — the specific selected segment of a video.
`id` PK, `video_id` FK, `topic`, `start_s`, `end_s`, `transcript_excerpt`, `reason`,
`content_id` FK → `content`, `created_at`.

**`user_interest`** — the interest vector.
`(user_id, topic)` PK, `weight` real (default 0.1), `updated_at`.

**`user_seen`** — dedup.
`(user_id, content_id)` PK, `seen_at`.

**`user_weak_topics`** — adaptive-quiz scheduling.
`id` PK, `user_id`, `topic`, `created_at`, `resolved` bool (default false).

**`engagement_log`** — raw events that drive the recommender.
`id` bigserial PK, `user_id`, `content_id`, `action`
(`dwell|up|down|quiz_correct|quiz_wrong|video_open`), `dwell_s` real, `created_at`.

**`generated_videos`** *(future)* — app-rendered videos (e.g. narrated card → mp4).
`id` PK, `source_content_id` FK, `topic`, `asset_path`, `status`
(`pending|ready|failed`), `created_at`.

### Storage
- Bucket **`narration`** (public read): narration mp3s named `<content_id>.mp3`.
- Public URL is derived via the Supabase Storage client and returned by the feed API.

### RLS summary
- `content`, `youtube_*`: public read; writes only via service role (producer).
- `user_interest`, `user_seen`, `user_weak_topics`, `engagement_log`: row-owner only
  (`user_id = auth.uid()`), or written by server routes using the service role with an
  explicit `user_id`.

---

## 8. Storage & audio caching

Narration is **generated once, cached forever**:
1. Producer creates a fact card row (gets its `id`).
2. Producer synthesizes `body` → mp3 via Kokoro.
3. Producer uploads mp3 to `narration/<id>.mp3` and sets `content.audio_path`.
4. Feed API returns the public URL as `audioUrl`.
5. Client plays `audioUrl`; if null/unavailable, falls back to Web Speech.

This removes TTS from the request path (NFR-1) and makes audio PC-independent (FR-10).

---

## 9. Topic taxonomy

15 topics, each with a hue used for color-coding cards (color = information). The exact hex
values are in `project.md`.

`Space`, `Programming & Building`, `AI & Machine Learning`, `Biology & Nature`,
`Health & Body`, `Cooking & Food`, `History`, `How Things Work`, `Art & Design`,
`Psychology & Mind`, `Philosophy`, `Language & Words`, `Money & Economics`, `Physics`,
`Skills & Productivity`.

> `Programming & Building` covers learning to code and things you can build with CS.
> `AI & Machine Learning` covers general AI content. These are distinct interest dimensions.

---

## 10. The recommender

The recommender is intentionally simple, legible, and effective. All constants below are
the defaults; expose them as config.

### 10.1 Interest vector
- Each topic has a weight, clamped to `[0.1, 5.0]`.
- Baseline weight on every topic: `0.1`. Onboarding-selected topics start at `1.0`.

### 10.2 Engagement updates
Applied when the corresponding event fires (FR-11):

| Signal | Δ weight on card's topic |
|---|---|
| Dwell ≥ 4s on a card | +0.15 |
| Thumbs up | +0.60 |
| Thumbs down | −0.80 |
| Quiz correct | +0.30 |
| Quiz wrong | +0.10 **and** mark topic weak (FR-8) |
| Video opened ("watch full") | +0.40 |

After each update, apply slow decay to **all** topics: `weight *= 0.997` (then re-clamp).
This lets interests drift over time.

### 10.3 Topic sampling for the next batch
To choose which topics a new batch features:
1. **Exploit:** softmax-sample **3 distinct** topics from the interest vector, temperature
   `0.6` (`p_i ∝ exp(weight_i / 0.6)`).
2. **Explore:** add **1 random** topic not already chosen (discovery; mirrors how social
   feeds inject novelty so the feed doesn't collapse into one rabbit hole).
3. **Reinforce:** if the user has unresolved `user_weak_topics`, include one as a refresher
   target and mark it resolved (FR-8).

### 10.4 Serving (no repeats)
The feed API selects pool items whose `topic ∈ chosen topics` and whose `id` is **not** in
the user's `user_seen`, ordered randomly (or by freshness), limited to the batch size
(default 6–8). Returned items are inserted into `user_seen`.

### 10.5 Where it runs
All recommender logic runs in the **always-on** path (Next.js routes / Supabase RPC),
reading the pre-built pool. It does **not** depend on the home PC.

---

## 11. Content generation pipeline (producer)

Runs on the home PC, on a loop or cron, only while the PC is on. One pass:

```
for each topic:
  if fact_count(topic) < TARGET_FACTS (200):
     facts = LLM.generate_facts(topic, batch)         # Ollama or cloud API
     for f in facts:
        row = supabase.insert(content, fact f)         # get id
        mp3 = kokoro.tts(f.body)                        # OpenAI-compatible
        path = supabase.storage.upload(narration/{id}.mp3, mp3)
        supabase.update(content[id].audio_path = path)
  if quiz_count(topic) < TARGET_QUIZZES (60):
     quizzes = LLM.generate_quizzes(topic, batch); insert
  if clip_count(topic) < TARGET_CLIPS (30):
     clip = youtube_clip_pipeline(topic)               # §12
     insert content(video) + youtube_videos + youtube_clips
```

The producer is **idempotent on depth**: it only generates the deficit, so re-running it
is safe and it naturally stops when pools are full.

---

## 12. YouTube clip pipeline (producer)

Given a topic, produce one stored, playable clip:
1. **Search** YouTube Data API (`search.list`, `videoEmbeddable=true`) for the topic.
2. **Rank** candidates via `videos.list` (duration, views); skip < 60s or > 30min.
3. **Transcript** via `youtube-transcript`; skip videos without captions.
4. **Select segment**: send the timestamped transcript to the LLM, ask for the single most
   engaging 20–40s segment that best teaches the topic → `{start, end, reason}`.
5. **Persist**: insert `youtube_videos`, `youtube_clips`, and a `content` row of type
   `video` with `payload = {videoId, start, end, channel}`.

> Caveat to verify in implementation: `youtube-transcript` timestamp units (ms vs s), and
> that videos with embedding disabled or no captions are skipped.

---

## 13. Serving APIs (contracts)

### `POST /api/feed`
Request: `{ "limit": 8 }` (user identified by the Supabase session/JWT).
Response:
```json
{ "items": [
  { "id": "...", "type": "fact", "topic": "Space",
    "title": "...", "tag": "...", "body": "...",
    "audioUrl": "https://.../narration/<id>.mp3" },
  { "id": "...", "type": "quiz", "topic": "Physics",
    "question": "...", "options": ["..."], "correct": 1, "explain": "..." },
  { "id": "...", "type": "video", "topic": "AI & Machine Learning",
    "title": "...", "videoId": "aircAruvnKk", "start": 163, "end": 205, "channel": "3Blue1Brown" }
] }
```
Behavior: read interest + weak topics → sample topics (§10.3) → `get_feed` RPC excludes seen
→ attach `audioUrl` → insert `user_seen` → return.

### `POST /api/engage`
Request: `{ "contentId": "...", "topic": "Space", "action": "up", "dwellS": 6.2 }`.
Behavior: insert `engagement_log`, apply the interest update (§10.2) to `user_interest`,
and on `quiz_wrong` insert a `user_weak_topics` row. Always-on; never touches the PC.

---

## 14. Frontend specification

Mobile-first PWA. Dark theme. Full-viewport snap cards.

**Screens**
- **Onboarding** — topic chips, pick ≥3, "Start scrolling" (creates anon session, seeds
  interest, fetches first batch).
- **Feed** — snap-scroll list of cards; top-center "Tuning to" meter; top-right mute toggle;
  end-of-list loader that prefetches the next batch.

**Components**
- `Feed` — owns scroll, IntersectionObserver (active card + dwell), prefetch, narration
  trigger.
- `FactCard`, `QuizCard`, `VideoClipCard`, `ReactionBar`, `InterestMeter`, `Onboarding`.

**Key interactions**
- Active-card detection via IntersectionObserver (> 0.6 visible).
- Dwell ≥ 4s → `engage(dwell)`. Thumbs → `engage(up|down)`. Quiz answer → `engage(quiz_*)`.
  Watch full → `engage(video_open)`.
- Narration: on active fact card, play `audioUrl` (HTMLAudioElement); fallback to Web Speech
  at rate 1.25; cancel on card change or mute.
- Clip cards: render the YouTube iframe **only** for the active card (so only one plays);
  others show a poster.
- Interest meter updates live from local state mirrored from `/api/engage` responses.

**Design system**
- Base `#0B0D14`, near-white text, topic-hued radial tints per card.
- Display face for titles (e.g. Fraunces), sans for body (Inter), mono for labels.
- Respect `prefers-reduced-motion`.

A complete, working reference implementation of the feed UI (interest vector, adaptive
quiz, clip player, narration) is provided in `project.md` and is adapted to fetch from
`/api/feed` and report to `/api/engage` instead of generating content client-side.

---

## 15. Environment variables

See `.env.example` in `project.md`. Summary:
- **Web/Vercel (server):** `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.
- **Client:** `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
- **Producer (PC):** `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
  `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`,
  `KOKORO_BASE_URL`, `KOKORO_API_KEY`, `KOKORO_MODEL`, `KOKORO_VOICE`,
  `YOUTUBE_API_KEY`.

---

## 16. Deployment

- **Supabase:** run the schema SQL; create the `narration` public bucket; enable anonymous
  auth; set RLS policies.
- **Vercel:** deploy the Next.js app; set server + public env vars.
- **Kokoro (home PC):** run the Docker image (OpenAI-compatible TTS at `/api/v1`).
- **Producer (home PC):** run the worker on a schedule (Task Scheduler / cron / loop) so the
  pool stays topped up whenever the PC is on.

---

## 17. Future extensions

- **Embedding recommender.** Replace the fixed-topic vector with embeddings: embed each
  content item and maintain a per-user embedding (running average of engaged items); pull
  the next batch by nearest-neighbor similarity. Store vectors in **Qdrant** (or `pgvector`).
- **Generated videos.** Render narrated fact cards into short mp4s (`generated_videos`).
- **Swappable premium voice.** Point `KOKORO_BASE_URL`/key at ElevenLabs/OpenAI for more
  human narration with no other code change.
