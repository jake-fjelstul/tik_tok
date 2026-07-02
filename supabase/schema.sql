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
