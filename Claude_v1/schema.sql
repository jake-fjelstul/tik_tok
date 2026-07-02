-- LearnFeed database (Postgres) ---------------------------------------------
-- Stores everything the feed produces: fact paragraphs, the YouTube clips it
-- selects, any videos the app itself generates, plus per-user interest + logs.

create extension if not exists "pgcrypto";          -- gen_random_uuid()
-- create extension if not exists vector;            -- enable if you store embeddings in Postgres
--                                                     (skip if you keep vectors in Qdrant)

-- a user and their tuned interest vector ------------------------------------
create table users (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now()
);

create table user_interest (
  user_id     uuid references users(id) on delete cascade,
  topic       text not null,
  weight      real not null default 0.1,
  updated_at  timestamptz not null default now(),
  primary key (user_id, topic)
);

-- every card the feed has ever produced -------------------------------------
-- type: 'fact' | 'quiz' | 'video' | 'generated_video'
-- source: 'llm' | 'youtube' | 'generated'
create table content (
  id          uuid primary key default gen_random_uuid(),
  type        text not null check (type in ('fact','quiz','video','generated_video')),
  topic       text not null,
  source      text not null default 'llm',
  title       text,
  body        text,                 -- the paragraph that gets read aloud (facts)
  tag         text,
  payload     jsonb,                -- quiz: {options,correct,explain}; video: {videoId,start,end,channel}
  -- embedding   vector(768),       -- optional: for the embedding recommender (or store in Qdrant)
  created_at  timestamptz not null default now()
);
create index on content (topic);
create index on content (type);

-- cache of videos we've discovered, so we don't re-hit the YouTube API -------
create table youtube_videos (
  video_id    text primary key,
  title       text,
  channel     text,
  duration_s  int,
  topic       text,
  fetched_at  timestamptz not null default now()
);

-- the specific clip chosen out of a video -----------------------------------
create table youtube_clips (
  id                 uuid primary key default gen_random_uuid(),
  video_id           text references youtube_videos(video_id),
  topic              text not null,
  start_s            int not null,
  end_s              int not null,
  transcript_excerpt text,          -- the lines the clip spans
  reason             text,          -- why the model picked this segment
  content_id         uuid references content(id) on delete set null,
  created_at         timestamptz not null default now()
);

-- videos the app itself renders (e.g. a narrated fact card -> mp4) -----------
create table generated_videos (
  id                uuid primary key default gen_random_uuid(),
  source_content_id uuid references content(id) on delete set null,
  topic             text,
  asset_path        text,           -- where the rendered file lives (local / S3)
  status            text not null default 'pending', -- pending | ready | failed
  created_at        timestamptz not null default now()
);

-- raw engagement events that drive the recommender --------------------------
-- action: dwell | up | down | quiz_correct | quiz_wrong | video_open
create table engagement_log (
  id          bigserial primary key,
  user_id     uuid references users(id) on delete cascade,
  content_id  uuid references content(id) on delete cascade,
  action      text not null,
  dwell_s     real,
  created_at  timestamptz not null default now()
);
create index on engagement_log (user_id, created_at);
