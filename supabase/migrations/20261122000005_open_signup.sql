-- 20261122000005_open_signup.sql
-- Reading is public and anyone may create a participant account. Staff roles
-- still require an invite, so a new account can never choose to be a reviewer
-- or admin.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  invited public.invites%rowtype;
  assigned public.member_role := 'participant';
begin
  select * into invited
  from public.invites
  where lower(email) = lower(new.email) and accepted_at is null;

  if found then
    assigned := invited.role;
    update public.invites set accepted_at = now() where id = invited.id;
  end if;

  insert into public.profiles (id, email, display_name, role)
  values (
    new.id,
    lower(new.email),
    coalesce(nullif(new.raw_user_meta_data ->> 'display_name', ''), split_part(new.email, '@', 1)),
    assigned
  );

  return new;
end;
$$;
