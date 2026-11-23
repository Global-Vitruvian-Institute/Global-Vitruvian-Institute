-- 0003_review_hardening.sql
-- Apply this after 0002 on a project that already ran the first migration.
-- It adds the transactional review path and closes direct status/pin writes.

alter table public.submissions
  add column if not exists last_feedback text;

-- Status is no longer directly writable by participants. Reflection edits and
-- pinning keep their column privileges; pinning also goes through an RPC so it
-- works after review.
revoke update on public.submissions from authenticated;
grant update (reflection, pinned) on public.submissions to authenticated;

drop policy if exists "delete own submissions" on public.submissions;
drop policy if exists "delete own pending submissions" on public.submissions;
create policy "delete own pending submissions"
  on public.submissions for delete to authenticated
  using (owner = auth.uid() and status = 'pending');

drop policy if exists "staff delete submissions" on public.submissions;
create policy "staff delete submissions"
  on public.submissions for delete to authenticated
  using (public.is_staff());

-- Evidence rows must name an object inside their own submission folder.
drop policy if exists "add evidence to own submissions" on public.evidence;
drop policy if exists "add evidence to own pending submissions" on public.evidence;
create policy "add evidence to own pending submissions"
  on public.evidence for insert to authenticated
  with check (
    object_path like auth.uid()::text || '/' || submission_id::text || '/%'
    and exists (
      select 1 from public.submissions s
      where s.id = submission_id and s.owner = auth.uid() and s.status = 'pending'
    )
  );

create unique index if not exists evidence_object_path_idx
  on public.evidence (object_path);

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

revoke all on function public.review_submission(uuid, public.submission_status, text) from public, anon;
grant execute on function public.review_submission(uuid, public.submission_status, text) to authenticated;

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

revoke all on function public.review_history(uuid) from public, anon;
grant execute on function public.review_history(uuid) to authenticated;

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

revoke all on function public.set_submission_pin(uuid, boolean) from public, anon;
grant execute on function public.set_submission_pin(uuid, boolean) to authenticated;

-- Upload/delete require an owned, still-pending submission in the object path.
drop policy if exists "upload evidence into own folder" on storage.objects;
drop policy if exists "upload evidence into own pending submission" on storage.objects;
create policy "upload evidence into own pending submission"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'evidence'
    and (storage.foldername(name))[1] = auth.uid()::text
    and exists (
      select 1 from public.submissions s
      where s.id::text = (storage.foldername(name))[2]
        and s.owner = auth.uid()
        and s.status = 'pending'
    )
  );

drop policy if exists "delete own evidence" on storage.objects;
drop policy if exists "delete own pending evidence" on storage.objects;
create policy "delete own pending evidence"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'evidence'
    and (storage.foldername(name))[1] = auth.uid()::text
    and exists (
      select 1 from public.submissions s
      where s.id::text = (storage.foldername(name))[2]
        and s.owner = auth.uid()
        and s.status = 'pending'
    )
  );
