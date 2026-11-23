# Supabase setup

Project: `Vitruvian` (`https://qplbfsnhrsmudpnppoy.supabase.co`, `us-east-1`).

One project is fine while there is no real participant data. Before real
sign-ups, either reset this project or create a separate production project and
re-run the migration there.

## 1. Run the schema

Open **SQL Editor → New query**, paste
[`supabase/migrations/0001_initial.sql`](../supabase/migrations/0001_initial.sql),
and run it once.

It creates profiles, invitations, submissions, evidence, reviews, reading
statistics, row-level security, and the private `evidence` bucket policies.

## 2. Invite the first admin

Sign-up is invitation-only. In the SQL editor:

```sql
insert into public.invites (email, role)
values ('you@example.com', 'admin');
```

Use the address that will own the account. The first sign-in consumes the
invite and creates the profile with the invited role. Never set roles from the
browser.

## 3. Configure email sign-in

**Authentication → Sign In / Providers → Email**:

- Enable email sign-in.
- Enable one-time codes (OTP), not only magic links.
- Edit both the **Magic Link** and **Confirm signup** email templates so they
  include `{{ .Token }}`; the reader asks for a six-digit code. A first-time
  invitee receives the confirmation template, not the magic-link one.

**Authentication → URL Configuration**:

- Site URL: the staging or production site URL.
- Redirect URLs: localhost preview, staging, production.

The project must be able to send email. Supabase's default sender is rate
limited and only suitable for first tests; add a custom SMTP sender before real
participants.

## 4. Verify the database

After the migration, **Table Editor** should show:

`invites`, `profiles`, `submissions`, `evidence`, `reviews`, `reading_stats`.

Storage should show a private `evidence` bucket.

Quick checks in the SQL editor:

```sql
select tablename, rowsecurity from pg_tables where schemaname = 'public';
select id, public from storage.buckets where id = 'evidence';
```

Every listed table should have `rowsecurity = true`; the bucket should be
private.

## 5. Client configuration

`reader/public/supabase-client.js` implements email OTP, session refresh, REST
reads/writes, private evidence upload, and signed downloads without adding a
framework or bundler. It is not yet connected to the UI; the local demo remains
the default until the store adapter is wired and tested against this project.

The browser only ever receives:

- Project URL.
- Publishable key (`sb_publishable_…`).

Never ship the secret / `service_role` key.

## 6. Next code step

Add `reader/public/supabase-store.js` implementing the same operations as
`demo-store.js`, then select it through a runtime config file:

```json
{ "mode": "supabase", "url": "https://qplbfsnhrsmudpnppoy.supabase.co", "publishableKey": "sb_publishable_…" }
```

Test with two participants and one reviewer before any real account exists:

1. Participant signs in with an invited email.
2. Participant logs a reflection and a file; both appear after reload.
3. A second participant cannot read the first participant's rows or files.
4. Reviewer sees both, verifies one, requests changes on the other.
5. Participant sees the decision but cannot change status directly.
