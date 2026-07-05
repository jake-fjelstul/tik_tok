-- ============================================================
-- Migration: learning sessions + topic mastery
-- ============================================================

-- 1. Sessions ------------------------------------------------
create table if not exists public.learning_sessions (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  started_at         timestamptz not null default now(),
  ended_at           timestamptz,
  goal               text,                     -- e.g. 'google_swe_interview'
  target_cards       int  not null default 12, -- the satisfying endpoint
  cards_seen         int  not null default 0,
  quizzes_attempted  int  not null default 0,
  quizzes_correct    int  not null default 0,
  completed          boolean not null default false
);
create index if not exists idx_sessions_user on public.learning_sessions(user_id, started_at desc);

-- 2. Individual quiz attempts (source of truth for mastery) --
create table if not exists public.quiz_responses (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  content_id  uuid not null references public.content(id) on delete cascade,
  session_id  uuid references public.learning_sessions(id) on delete set null,
  topic       text not null,
  selected    text,
  is_correct  boolean not null,
  answered_at timestamptz not null default now()
);
create index if not exists idx_responses_user_topic on public.quiz_responses(user_id, topic);

-- 3. Rolled-up mastery per user+topic ------------------------
create table if not exists public.topic_mastery (
  user_id         uuid not null references auth.users(id) on delete cascade,
  topic           text not null,
  attempts        int  not null default 0,
  correct         int  not null default 0,
  current_streak  int  not null default 0,
  mastery         numeric(4,3) not null default 0,  -- 0..1, recency-weighted (EMA)
  last_attempt_at timestamptz,
  updated_at      timestamptz not null default now(),
  primary key (user_id, topic)
);

-- 4. SQL Backfill from engagement_log oldest-first ----------------
do $$
declare
  r record;
  hit int;
  alpha constant numeric := 0.3;
  prev public.topic_mastery%rowtype;
begin
  -- Check if engagement_log exists and has quiz actions
  if exists (
    select 1 from information_schema.tables 
    where table_schema = 'public' and table_name = 'engagement_log'
  ) then
    for r in 
      select e.user_id, e.content_id, c.topic, (e.action = 'quiz_correct') as is_correct, e.created_at
      from public.engagement_log e
      join public.content c on e.content_id = c.id
      where e.action in ('quiz_correct', 'quiz_wrong')
      order by e.created_at asc
    loop
      hit := case when r.is_correct then 1 else 0 end;
      
      -- Insert into quiz_responses first so we have the detailed logs
      insert into public.quiz_responses(user_id, content_id, session_id, topic, selected, is_correct, answered_at)
      values (r.user_id, r.content_id, null, coalesce(r.topic, 'unknown'), null, r.is_correct, r.created_at);

      select * into prev from public.topic_mastery
      where user_id = r.user_id and topic = r.topic;

      if not found then
        insert into public.topic_mastery(
          user_id, topic, attempts, correct, current_streak, mastery, last_attempt_at, updated_at)
        values (r.user_id, r.topic, 1, hit, hit, hit, r.created_at, r.created_at);
      else
        update public.topic_mastery set
          attempts        = prev.attempts + 1,
          correct         = prev.correct + hit,
          current_streak  = case when r.is_correct then prev.current_streak + 1 else 0 end,
          mastery         = round(alpha * hit + (1 - alpha) * prev.mastery, 3),
          last_attempt_at = r.created_at,
          updated_at      = now()
        where user_id = r.user_id and topic = r.topic;
      end if;
    end loop;
  end if;
end;
$$;

-- 5. Trigger function: recompute mastery + session counters on each answer
create or replace function public.apply_quiz_response()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  alpha constant numeric := 0.3;   -- weight on the newest answer
  prev  public.topic_mastery%rowtype;
  hit   int := case when new.is_correct then 1 else 0 end;
begin
  select * into prev from public.topic_mastery
  where user_id = new.user_id and topic = new.topic;

  if not found then
    insert into public.topic_mastery(
      user_id, topic, attempts, correct, current_streak, mastery, last_attempt_at, updated_at)
    values (new.user_id, new.topic, 1, hit, hit, hit, new.answered_at, now());
  else
    update public.topic_mastery set
      attempts        = prev.attempts + 1,
      correct         = prev.correct + hit,
      current_streak  = case when new.is_correct then prev.current_streak + 1 else 0 end,
      mastery         = round(alpha * hit + (1 - alpha) * prev.mastery, 3),
      last_attempt_at = new.answered_at,
      updated_at      = now()
    where user_id = new.user_id and topic = new.topic;
  end if;

  if new.session_id is not null then
    update public.learning_sessions set
      quizzes_attempted = quizzes_attempted + 1,
      quizzes_correct   = quizzes_correct + hit
    where id = new.session_id;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_apply_quiz_response on public.quiz_responses;
create trigger trg_apply_quiz_response
after insert on public.quiz_responses
for each row execute function public.apply_quiz_response();

-- 6. RLS -----------------------------------------------------
alter table public.learning_sessions enable row level security;
alter table public.quiz_responses    enable row level security;
alter table public.topic_mastery     enable row level security;

drop policy if exists "own sessions"  on public.learning_sessions;
drop policy if exists "own responses" on public.quiz_responses;
drop policy if exists "read own mastery" on public.topic_mastery;

create policy "own sessions" on public.learning_sessions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own responses" on public.quiz_responses
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- mastery is written ONLY by the security-definer trigger, so users get read-only
create policy "read own mastery" on public.topic_mastery
  for select using (auth.uid() = user_id);

-- ============================================================
-- RPC Functions
-- ============================================================

-- Start a session, return its id
create or replace function public.start_session(p_goal text default null, p_target int default 12)
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into public.learning_sessions(user_id, goal, target_cards)
  values (auth.uid(), p_goal, greatest(p_target, 1))
  returning id into v_id;
  return v_id;
end; $$;

-- Count a card view; tell the client when the target is hit (→ show the end screen)
create or replace function public.log_card_view(p_session_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v public.learning_sessions%rowtype;
begin
  update public.learning_sessions
  set cards_seen = cards_seen + 1
  where id = p_session_id and user_id = auth.uid()
  returning * into v;

  if not found then return null; end if;

  return jsonb_build_object(
    'cards_seen', v.cards_seen,
    'target_cards', v.target_cards,
    'reached_target', v.cards_seen >= v.target_cards
  );
end; $$;

-- Log a quiz answer. Server derives topic + correctness. Returns feedback for the UI.
create or replace function public.log_quiz_response(
  p_content_id uuid, p_selected text, p_session_id uuid default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_topic   text;
  v_correct_val text;
  v_correct text;
  v_ok      boolean;
begin
  -- Get topic and correct answer (resolving index to string if needed)
  select topic, payload->>'correct' into v_topic, v_correct_val
  from public.content where id = p_content_id;

  if v_correct_val ~ '^\d+$' then
    select payload->'options'->>(v_correct_val::int) into v_correct
    from public.content where id = p_content_id;
  else
    v_correct := v_correct_val;
  end if;

  v_ok := (p_selected is not distinct from v_correct);

  insert into public.quiz_responses(user_id, content_id, session_id, topic, selected, is_correct)
  values (auth.uid(), p_content_id, p_session_id, coalesce(v_topic, 'unknown'), p_selected, v_ok);

  return jsonb_build_object('is_correct', v_ok, 'correct', v_correct, 'topic', v_topic);
end; $$;

-- End a session; mark completed if the target was reached
create or replace function public.end_session(p_session_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.learning_sessions
  set ended_at  = now(),
      completed = (cards_seen >= target_cards)
  where id = p_session_id and user_id = auth.uid() and ended_at is null;
end; $$;

-- Progress summary for the mastery/progress UI + session-end screen
create or replace function public.get_progress()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v uuid := auth.uid();
begin
  return jsonb_build_object(
    'topics', (
      select coalesce(jsonb_agg(jsonb_build_object(
                'topic', topic, 'attempts', attempts, 'correct', correct,
                'mastery', mastery, 'streak', current_streak,
                'last_attempt_at', last_attempt_at) order by mastery asc), '[]'::jsonb)
      from public.topic_mastery where user_id = v),
    'totals', (
      select jsonb_build_object(
               'topics_touched', count(*),
               'topics_mastered', count(*) filter (where mastery >= 0.8 and attempts >= 3),
               'total_attempts', coalesce(sum(attempts),0),
               'total_correct',  coalesce(sum(correct),0))
      from public.topic_mastery where user_id = v),
    'recent_sessions', (
      select coalesce(jsonb_agg(jsonb_build_object(
                'started_at', started_at, 'ended_at', ended_at,
                'cards_seen', cards_seen, 'quizzes_attempted', quizzes_attempted,
                'quizzes_correct', quizzes_correct, 'completed', completed)
                order by started_at desc), '[]'::jsonb)
      from (select * from public.learning_sessions
            where user_id = v and ended_at is not null
            order by started_at desc limit 10) s)
  );
end; $$;

-- Update get_feed function
create or replace function get_feed(p_user uuid, p_topics text[], p_limit int)
returns setof content language sql stable as $$
  select c.* from content c
  left join public.user_interest ui on ui.user_id = p_user and ui.topic = c.topic
  left join public.topic_mastery m on m.user_id = p_user and m.topic = c.topic
  where c.topic = any(p_topics)
    and not exists (
      select 1 from user_seen s where s.user_id = p_user and s.content_id = c.id
    )
  order by
    (coalesce(ui.weight, 0.1) * (1.2 - coalesce(m.mastery, 0.0))) *
    (case 
      when c.type = 'quiz' and m.last_attempt_at is not null then
        least(1.0, extract(epoch from (now() - m.last_attempt_at)) / 86400.0)
      else 1.0
     end) desc,
    random()
  limit p_limit;
$$;
