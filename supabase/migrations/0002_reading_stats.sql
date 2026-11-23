-- 0002_reading_stats.sql
-- Account totals and the two narrow RPCs the static reader uses to record
-- activity. Direct table writes stay closed to participants.

alter table public.reading_stats
  add column if not exists visits integer not null default 0;

-- Statistics are written only through the RPCs below; a participant must not
-- rewrite their own totals directly.
revoke insert, update on public.reading_stats from authenticated;

create table if not exists public.account_stats (
  owner uuid primary key references public.profiles (id) on delete cascade,
  active_ms bigint not null default 0 check (active_ms >= 0),
  updated_at timestamptz not null default now()
);

alter table public.account_stats enable row level security;
revoke all on public.account_stats from anon, authenticated;
grant select on public.account_stats to authenticated;

create policy "read own account statistics or any as staff"
  on public.account_stats for select to authenticated
  using (owner = auth.uid() or public.is_staff());

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

revoke all on function public.record_note_view(text) from public, anon;
revoke all on function public.add_active_time(bigint) from public, anon;
grant execute on function public.record_note_view(text) to authenticated;
grant execute on function public.add_active_time(bigint) to authenticated;
