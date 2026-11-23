# Production and staging plan

Status: plan only. The current site is a static reader plus a browser-local
participation mock. Nothing here is provisioned or connected.

## Target shape

```
Markdown in vault/  ──build──►  dist/ static site
                                   │
                                   ├── Supabase Auth       (email, sessions)
                                   ├── Supabase Postgres   (accounts, portfolio, reviews, stats)
                                   └── Supabase Storage    (private evidence files)
```

Rendering stays static. Supabase replaces the demo store; the browser does not
talk to Postgres directly for writes that need authorization rules.

## Environments

| Environment | Site | Data | Accounts |
| --- | --- | --- | --- |
| Local | `dist/` on localhost | IndexedDB demo | Synthetic demo logins |
| Staging | Static preview deployment | Separate Supabase project | Invited test addresses |
| Production | Static production deployment | Production Supabase project | Invited participants and staff |

Use two Supabase projects rather than one with mixed test data. Keep staging
addresses and evidence out of production.

GitHub Pages can host the public site, but it has one published site per
repository and no server-side secrets. Preview deployments per branch need a
different host (Cloudflare Pages, Netlify, or Vercel). The Supabase publishable
key is safe to ship; the service-role key never belongs in the browser or in a
static build.

## Connection seam

`reader/public/demo-store.js` already exposes the operations the UI needs:
session, submissions, pins, reviews, evidence, statistics. Add
`reader/public/supabase-store.js` with the same public methods, chosen at boot by
a small public config file:

```json
{ "mode": "local" }
```

```json
{ "mode": "supabase", "url": "https://<project>.supabase.co", "publishableKey": "..." }
```

The runtime mode is selected in `reader/public/supabase-config.json`; `local` keeps the browser demo, `supabase` uses the project.
This keeps UI iteration independent of backend work.

## Supabase setup order

1. Create the staging project in a region near the expected users.
2. Enable email authentication. Prefer magic link or email OTP; no passwords.
3. Set site and redirect URLs for localhost, staging, and production.
4. Create schema through versioned SQL migrations committed in the repository.
5. Enable row-level security on every exposed table; deny by default.
6. Create a private storage bucket for evidence. No public bucket.
7. Seed one admin and a small set of staging participants by invitation.
8. Wire the store adapter and a feature flag; keep the demo reachable.
9. Run the access tests with two participant accounts plus a teacher account.

### Schema outline

- `profiles` — id (auth user), display name, role, created_at.
- `invites` — email, role, accepted_at. Controls who may participate.
- `submissions` — owner, activity note id, reflection, status, pinned, timestamps.
- `evidence` — submission, object path, filename, media type, size.
- `reviews` — submission, reviewer, decision, feedback, created_at.
- `reading_stats` — owner, note id, first/last seen, active milliseconds. Store
  per note so pages explored are countable without a row per event.

Roles come from `profiles` / server checks, never from an email comparison in the
browser. Teacher and admin access must be enforced in SQL policies or a server
function.

### Storage and privacy

Evidence is sensitive, especially for younger participants. Requirements before
real uploads:

- Private bucket, size and type limits, no executable previews.
- Signed URLs with short expiry, issued to an owner or reviewer.
- Deletion when a submission is deleted or an account is closed.
- A stated retention period and an export path for the participant.
- Moderation and reporting process for anything shared beyond the owner.

## Deploy sequence

1. Local demo stays on GitHub Pages while the adapter and schema are built.
2. Staging Supabase + preview deployment, behind invitations.
3. Fix access-control failures and privacy copy on staging.
4. Production Supabase project, production site, small invited cohort.
5. Only then consider open signup or public portfolios.

## Immediate prerequisites

- Supabase account access and two project slots (staging, production).
- Chosen site host for preview deployments.
- Confirmed sender domain for authentication email.
- Named reviewer/admin accounts.
- A written decision on whether uploaded evidence is visible to anyone other
  than the participant and reviewers at launch.

## What this does not decide yet

Video hosting, comments, public sharing, certificates, teacher rosters, and
exact tracking retention remain product hypotheses. They should not block the
auth, schema, and storage foundation.
