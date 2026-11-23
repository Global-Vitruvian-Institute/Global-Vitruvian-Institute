-- 0004_repair_functions.sql
-- Run once if 0002/0003 reported success but the RPCs are missing. Safe to
-- re-run: tables are altered conditionally, functions are replaced, and
-- grants are idempotent.

alter table public.submissions
  add column if not exists last_feedback text;

alter table public.reading_stats
  add column if not exists visits integer not null default 0;

create table if not exists public.account_stats (
  owner uuid primary key references public.profiles (id) on delete cascade,
  active_ms bigint not null default 0 check (active_ms >= 0),
  updated_at timestamptz not null default now()
);

alter table public.account_stats enable row level security;
revoke all on public.account_stats from anon, authenticated;
grant select on public.account_stats to authenticated;

drop policy if exists "read own account statistics or any as staff" on public.account_stats;
create policy "read own account statistics or any as staff"
  on public.account_stats for select to authenticated
  using (owner = auth.uid() or public.is_staff());

revoke insert, update on public.reading_stats from authenticated;

create or replace function public.record_note_view(p_note_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  if p_note_id is null or length(trim(p_note_id)) = 0 then
    raise exception 'A note id is required' using errcode = '22023';
  end if;

  insert into public.reading_stats as rs (owner, note_id, first_seen, last_seen, visits)
  values (auth.uid(), p_note_id, now(), now(), 1)
  on conflict (owner, note_id) do update
    set last_seen = now(), visits = rs.visits + 1;
end;
$$;

create or replace function public.add_active_time(p_ms bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  if p_ms is null or p_ms < 0 or p_ms > 3600000 then
    raise exception 'Active time is out of range' using errcode = '22023';
  end if;

  insert into public.account_stats as s (owner, active_ms, updated_at)
  values (auth.uid(), p_ms, now())
  on conflict (owner) do update
    set active_ms = s.active_ms + excluded.active_ms,
        updated_at = now();
end;
$$;

create or replace function public.review_submission(
  p_submission_id uuid,
  p_status public.submission_status,
  p_feedback text default ''
)
returns public.submissions
language plpgsql
security definer
set search_path = ''
as $$
declare
  reviewed public.submissions;
  trimmed text := btrim(coalesce(p_feedback, ''));
begin
  if not public.is_staff() then
    raise exception 'Only a reviewer may review a submission' using errcode = '42501';
  end if;
  if p_status is null then
    raise exception 'Choose one of the three review states' using errcode = '22023';
  end if;
  if p_status = 'changes_requested' and trimmed = '' then
    raise exception 'Feedback is required when requesting changes' using errcode = '22023';
  end if;

  update public.submissions
    set status = p_status,
        last_feedback = nullif(trimmed, '')
    where id = p_submission_id
    returning * into reviewed;

  if reviewed.id is null then
    raise exception 'That submission no longer exists' using errcode = 'P0002';
  end if;

  insert into public.reviews (submission_id, reviewer, decision, feedback)
  values (p_submission_id, auth.uid(), p_status, trimmed);

  return reviewed;
end;
$$;

create or replace function public.review_history(p_submission_id uuid default null)
returns table (
  id uuid,
  submission_id uuid,
  decision public.submission_status,
  feedback text,
  created_at timestamptz,
  reviewer_email text,
  reviewer_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  select r.id, r.submission_id, r.decision, r.feedback, r.created_at,
         p.email, p.display_name
  from public.reviews r
  join public.profiles p on p.id = r.reviewer
  where (
    (p_submission_id is null and public.is_staff())
    or (
      r.submission_id = p_submission_id
      and (
        public.is_staff()
        or exists (
          select 1 from public.submissions s
          where s.id = r.submission_id and s.owner = auth.uid()
        )
      )
    )
  )
  order by r.created_at asc;
$$;

create or replace function public.set_submission_pin(
  p_submission_id uuid,
  p_pinned boolean
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed integer;
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;

  update public.submissions
    set pinned = coalesce(p_pinned, false)
    where id = p_submission_id and owner = auth.uid();
  get diagnostics changed = row_count;

  if changed = 0 then
    raise exception 'Only the author can pin this submission' using errcode = '42501';
  end if;

  return coalesce(p_pinned, false);
end;
$$;

revoke all on function public.record_note_view(text) from public, anon;
revoke all on function public.add_active_time(bigint) from public, anon;
revoke all on function public.review_submission(uuid, public.submission_status, text) from public, anon;
revoke all on function public.review_history(uuid) from public, anon;
revoke all on function public.set_submission_pin(uuid, boolean) from public, anon;

grant execute on function public.record_note_view(text) to authenticated;
grant execute on function public.add_active_time(bigint) to authenticated;
grant execute on function public.review_submission(uuid, public.submission_status, text) to authenticated;
grant execute on function public.review_history(uuid) to authenticated;
grant execute on function public.set_submission_pin(uuid, boolean) to authenticated;
