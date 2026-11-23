# Supabase setup

Project: `Vitruvian` (`https://qplbfsnhrsmudpnppoy.supabase.co`, `us-east-1`).

One project is fine while there is no real participant data. Before real
sign-ups, either reset this project or create a separate production project and
re-run the migration there.

## 1. Run the schema

Open **SQL Editor → New query** and run the migrations **in order**:

1. [`supabase/migrations/0001_initial.sql`](../supabase/migrations/0001_initial.sql)
2. [`supabase/migrations/0002_reading_stats.sql`](../supabase/migrations/0002_reading_stats.sql)
3. [`supabase/migrations/0003_review_hardening.sql`](../supabase/migrations/0003_review_hardening.sql)

Migration 0001 creates profiles, invitations, submissions, evidence, reviews,
reading statistics, row-level security, and the private `evidence` bucket
policies. Migration 0002 adds `account_stats` and the two activity RPCs
(`record_note_view`, `add_active_time`). Migration 0003 adds transactional
reviews, review history, and the pin RPC, and closes direct edits to reviewed
work. A project that already ran the original 0001 still needs 0002 and 0003.

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

After all three migrations, **Table Editor** should show:

`invites`, `profiles`, `submissions`, `evidence`, `reviews`, `reading_stats`,
`account_stats`.

Storage should show a private `evidence` bucket.

Quick checks in the SQL editor:

```sql
select tablename, rowsecurity from pg_tables where schemaname = 'public';
select id, public from storage.buckets where id = 'evidence';
select proname from pg_proc
where pronamespace = 'public'::regnamespace
  and proname in ('record_note_view', 'add_active_time', 'review_submission', 'set_submission_pin', 'review_history');
```

Every listed table should have `rowsecurity = true`; the bucket should be
private; all five RPCs should be present.

## 5. Client configuration

`reader/public/supabase-client.js` implements email OTP, session refresh, REST
reads/writes, private evidence upload, and signed downloads without adding a
framework or bundler. `reader/public/supabase-store.js` adapts it to the same
operations as `demo-store.js`, and `reader/public/store-config.js` picks the
store at boot from a small public config file:

```json
{ "mode": "local" }
```

```json
{ "mode": "supabase", "url": "https://<project>.supabase.co", "publishableKey": "sb_publishable_…" }
```

The file is `reader/public/supabase-config.json`; the build copies it to `dist/`
unchanged, so the deployed site is configured without rebuilding.

- `mode: "local"`, a missing file or an unreadable file keeps the browser-only
demo. The notes always load.
- `mode: "supabase"` with both fields selects Supabase. If Supabase cannot be
reached, the notes still load and the account region explains the failure; a
rejected refresh token returns the reader to the signed-out state instead of
stranding them.
- `mode: "supabase"` with a missing `url` or `publishableKey` is treated as an
incomplete configuration: the notes load, and the account region says account
features are unavailable. It does **not** silently fall back to local storage.

The browser only ever receives:

- Project URL.
- Publishable key (`sb_publishable_…`).

Never ship the secret / `service_role` key.

## 6. Verify with two participants and one reviewer

Before any real account exists:

1. Participant signs in with an invited email.
2. Participant logs a reflection and a file; both appear after reload.
3. A second participant cannot read the first participant's rows or files.
4. Reviewer sees both, verifies one, requests changes on the other, and the
decision appears in the participant's review history with the reviewer's
address.
5. Participant sees the decision but cannot change status directly.
6. Participant pins and unpins the reviewed submission from User info.
7. Participant cannot delete or replace the verified submission or its file.
