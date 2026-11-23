-- 0001_initial.sql
-- Invitation-only accounts, activity submissions, evidence, reviews and reading
-- statistics. Run in the Supabase SQL editor, then create the private
-- `evidence` bucket and the policies at the bottom.

create extension if not exists pgcrypto;

create type public.member_role as enum ('participant', 'reviewer', 'admin');
create type public.submission_status as enum ('pending', 'verified', 'changes_requested');

-- ---------------------------------------------------------------- invites ---

create table public.invites (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  role public.member_role not null default 'participant',
  created_at timestamptz not null default now(),
  accepted_at timestamptz
);

create unique index invites_email_lower_idx on public.invites (lower(email));

alter table public.invites enable row level security;
revoke all on public.invites from anon, authenticated;
-- No policies: only the SQL editor / service role may read or write invites.

-- --------------------------------------------------------------- profiles ---

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  display_name text not null,
  role public.member_role not null default 'participant',
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;

create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('reviewer', 'admin')
  );
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

create policy "read own profile or any profile as staff"
  on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_staff());

create policy "update own display name"
  on public.profiles for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- Sign-up is invitation-only. The invite's role decides staff access; a browser
-- cannot choose its own role. Removing the invite blocks the account creation.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  invited public.invites%rowtype;
begin
  select * into invited
  from public.invites
  where lower(email) = lower(new.email) and accepted_at is null;

  if not found then
    raise exception 'An invitation is required for %', new.email
      using errcode = '42501';
  end if;

  insert into public.profiles (id, email, display_name, role)
  values (
    new.id,
    lower(new.email),
    coalesce(nullif(new.raw_user_meta_data ->> 'display_name', ''), split_part(new.email, '@', 1)),
    invited.role
  );

  update public.invites set accepted_at = now() where id = invited.id;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ------------------------------------------------------------ submissions ---

create table public.submissions (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references public.profiles (id) on delete cascade,
  note_id text not null,
  note_title text not null,
  reflection text not null default '',
  status public.submission_status not null default 'pending',
  pinned boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index submissions_owner_idx on public.submissions (owner, created_at desc);
create index submissions_status_idx on public.submissions (status, created_at desc);

alter table public.submissions enable row level security;
revoke all on public.submissions from anon;
grant select, insert, update, delete on public.submissions to authenticated;

create policy "read own submissions or any as staff"
  on public.submissions for select to authenticated
  using (owner = auth.uid() or public.is_staff());

create policy "create own submissions"
  on public.submissions for insert to authenticated
  with check (owner = auth.uid() and status = 'pending');

-- A participant may edit only while their work is still pending. Once reviewed,
-- the verified reflection and evidence are immutable to the owner.
create policy "update own pending submissions"
  on public.submissions for update to authenticated
  using (owner = auth.uid() and status = 'pending')
  with check (owner = auth.uid() and status = 'pending');

create policy "staff manage submissions"
  on public.submissions for update to authenticated
  using (public.is_staff())
  with check (public.is_staff());

create policy "delete own submissions"
  on public.submissions for delete to authenticated
  using (owner = auth.uid());

-- A participant may pin or edit their reflection, but may not mark their own
-- work verified. Only staff may change the verification status.
create or replace function public.protect_submission_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status is distinct from old.status and not public.is_staff() then
    raise exception 'Only a reviewer may change submission status'
      using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger submissions_status_guard
  before update on public.submissions
  for each row execute function public.protect_submission_status();

-- ---------------------------------------------------------------- evidence ---

create table public.evidence (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.submissions (id) on delete cascade,
  object_path text not null,
  name text not null,
  mime text not null,
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 26214400),
  created_at timestamptz not null default now()
);

create index evidence_submission_idx on public.evidence (submission_id);

alter table public.evidence enable row level security;
revoke all on public.evidence from anon;
grant select, insert, update, delete on public.evidence to authenticated;

create policy "read evidence of visible submissions"
  on public.evidence for select to authenticated
  using (exists (
    select 1 from public.submissions s
    where s.id = submission_id and (s.owner = auth.uid() or public.is_staff())
  ));

create policy "add evidence to own pending submissions"
  on public.evidence for insert to authenticated
  with check (
    object_path like auth.uid()::text || '/%'
    and exists (
      select 1 from public.submissions s
      where s.id = submission_id and s.owner = auth.uid() and s.status = 'pending'
    )
  );

create policy "delete evidence from own pending submissions"
  on public.evidence for delete to authenticated
  using (exists (
    select 1 from public.submissions s
    where s.id = submission_id and s.owner = auth.uid() and s.status = 'pending'
  ));

-- ----------------------------------------------------------------- reviews ---

create table public.reviews (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.submissions (id) on delete cascade,
  reviewer uuid not null references public.profiles (id) on delete cascade,
  decision public.submission_status not null,
  feedback text not null default '',
  created_at timestamptz not null default now()
);

create index reviews_submission_idx on public.reviews (submission_id, created_at desc);

alter table public.reviews enable row level security;
revoke all on public.reviews from anon;
grant select, insert on public.reviews to authenticated;

create policy "read reviews of own submissions or any as staff"
  on public.reviews for select to authenticated
  using (public.is_staff() or exists (
    select 1 from public.submissions s
    where s.id = submission_id and s.owner = auth.uid()
  ));

create policy "staff leave reviews"
  on public.reviews for insert to authenticated
  with check (public.is_staff() and reviewer = auth.uid());

-- ---------------------------------------------------------- reading stats ---

create table public.reading_stats (
  owner uuid not null references public.profiles (id) on delete cascade,
  note_id text not null,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  active_ms bigint not null default 0 check (active_ms >= 0),
  primary key (owner, note_id)
);

alter table public.reading_stats enable row level security;
revoke all on public.reading_stats from anon;
grant select, insert, update on public.reading_stats to authenticated;

create policy "read own statistics or any as staff"
  on public.reading_stats for select to authenticated
  using (owner = auth.uid() or public.is_staff());

create policy "write own statistics"
  on public.reading_stats for insert to authenticated
  with check (owner = auth.uid());

create policy "update own statistics"
  on public.reading_stats for update to authenticated
  using (owner = auth.uid())
  with check (owner = auth.uid());

-- ----------------------------------------------------------- storage RLS ----
-- Create a PRIVATE bucket named `evidence` first (Dashboard → Storage), then
-- run these policies.

insert into storage.buckets (id, name, public)
values ('evidence', 'evidence', false)
on conflict (id) do update set public = false;

create policy "upload evidence into own folder"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'evidence'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "read own evidence or any as staff"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'evidence'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.is_staff())
  );

create policy "delete own evidence"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'evidence'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
