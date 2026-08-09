# AVARIA v1.5.0 — Phase 5B: hosted Push activation

Phase 5A (this repository, as of this document) implements the complete
server-side Push dispatch path — migration `0054_push_dispatch_trigger.sql`,
the `send-push-notification` Edge Function, and their local test coverage —
but activates nothing on the hosted project. Every fail-safe in that code
(missing Vault config, missing VAPID config, an unconfigured webhook secret)
is exercised by the local test suites specifically so this migration and
this function can be merged and sit inert until Phase 5B completes the
steps below.

**This document names configuration variables/secrets only. It contains no
real values, and none should ever be pasted into it, a commit, an issue, or
a chat message.**

## What Phase 5B actually does

1. Generate (or reuse the already-generated) VAPID keypair — this is an
   operational artifact, not something derived from this codebase.
2. Configure the two Vault entries the database trigger reads.
3. Configure the Edge Function's own environment secrets.
4. Deploy migration `0054_push_dispatch_trigger.sql` to the hosted project
   (if not already applied).
5. Deploy the `send-push-notification` function.
6. Configure `VITE_VAPID_PUBLIC_KEY` in Vercel and redeploy the frontend —
   this is what lifts Phase 4's client-side rollout gate
   (`src/components/PushSubscriptionSettings.tsx`) and makes the Push UI
   visible to real users for the first time.
7. Verify end-to-end, per the checklist below.

## 1. Database — Vault entries

Two named Vault secrets, read at call time by `dispatch_push_notification()`
(migration 0054). Both must be present and non-blank, or the trigger stays
in its fail-safe no-op state — no error, but also no dispatch.

| Vault entry name              | Value                                                                 |
| ------------------------------ | ---------------------------------------------------------------------- |
| `avaria_push_dispatch_url`     | The deployed `send-push-notification` function's invoke URL.          |
| `avaria_push_webhook_secret`   | A freshly generated, high-entropy shared secret — distinct from every other credential in this project (not the VAPID private key, not the anon/publishable key, not a JWT). |

Set these via the Supabase SQL editor (or CLI) using Vault's own
`vault.create_secret(secret, name, description)` function — never as a
plaintext table row, never in a migration file.

## 2. Edge Function — environment secrets

Configured via the Supabase Dashboard (Project Settings → Edge Functions →
`send-push-notification` → Secrets) or `supabase secrets set`, never
committed:

| Secret name           | Value                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| `PUSH_WEBHOOK_SECRET`  | The SAME value stored as `avaria_push_webhook_secret` in Vault (step 1). A mismatch means every dispatch attempt is rejected 401. |
| `VAPID_PUBLIC_KEY`     | The generated VAPID public key (base64url, 65-byte uncompressed EC point).                |
| `VAPID_PRIVATE_KEY`    | The generated VAPID private key. Edge Function secret ONLY — must never appear in a `VITE_*` variable, client code, a migration, or a log line. |
| `VAPID_SUBJECT`        | A `mailto:` or `https:` contact URI, per the VAPID spec (e.g. an ops mailbox/URL for this deployment). |

`SUPABASE_URL` and the service-role key (`SUPABASE_SECRET_KEYS` /
`SUPABASE_SERVICE_ROLE_KEY`) are already injected automatically by the
Supabase platform for every Edge Function — nothing to configure there,
matching the existing `delete-user` function's own convention.

## 3. Deployment

```sh
# 1. Apply the migration (if not already applied to this project)
supabase db push

# 2. Deploy the function. verify_jwt=false is already versioned in
#    supabase/config.toml -- no undocumented --no-verify-jwt flag needed.
supabase functions deploy send-push-notification

# 3. Confirm the secrets above are set (dashboard, or):
supabase secrets list
```

## 4. Vercel — the client-side public key

| Variable                | Value                                                          |
| ------------------------ | ----------------------------------------------------------------- |
| `VITE_VAPID_PUBLIC_KEY`  | The SAME public key configured as `VAPID_PUBLIC_KEY` above (step 2). Public by design — this is what ships to every browser — but still not something to hardcode; keep it a Vercel environment variable, exactly like the existing `VITE_SUPABASE_*` variables. |

Setting this is what makes `PushSubscriptionSettings` (Phase 4) start
rendering for real users instead of returning `null` — see that
component's own rollout-gate comment. Redeploy the frontend after setting
it; a `VITE_*` variable is baked in at build time, not read at runtime.

## 5. End-to-end verification checklist

Perform these against the hosted project only after every step above is
complete — never against production user data as a first attempt; a scratch
account/device is enough.

- **Trigger filtering**: insert (or naturally produce, e.g. by creating an
  incident) a qualifying notification and confirm a dispatch attempt was
  queued; separately confirm a routine `incident_updated`/`incident_closed`/
  `incident_cancelled` broadcast produces none. `select * from
  pg_stat_user_functions where funcname = 'dispatch_push_notification';`
  (call count) is a coarse signal; the Edge Function's own logs are the
  authoritative one.
- **Edge Function logs**: Dashboard → Edge Functions →
  `send-push-notification` → Logs. Every invocation logs its outcome
  (`ok`/`skipped`/`not_found`/`unauthorized`) — never a subscription
  endpoint, `p256dh`, `auth`, or key material (see `dispatch.test.ts`'s `S`
  tests, which assert this at the code level).
- **`push_deliveries` outcomes**: `select status, count(*) from
  push_deliveries group by status;` — expect `sent` rows to accumulate for
  real enabled devices, `pending` to never linger (every claimed row should
  resolve to `sent`/`failed`/`expired` within the request), and `failed`/
  `expired` to correspond to genuine provider errors, not a systemic
  misconfiguration (if EVERY row is `failed`, re-check the VAPID secrets
  first).
- **Expired subscription cleanup**: force a 404/410 from the push service
  (the most reliable local way: enable Push on a test device, then fully
  uninstall/reset that browser's Push permission so the endpoint truly
  dies) and confirm the corresponding `push_subscriptions` row is removed
  after the next notification for that user, with its `push_deliveries`
  rows cascade-removed alongside it (migration 0053's existing FK
  behavior).
- **Real-device receipt**: confirm a Push notification actually appears on
  a real enabled device/browser for at least one `action_required` case and
  the `incident_opened` broadcast case, with the approved fixed copy (see
  `dispatch.ts`) and a working deep link (Phase 3's `notificationclick`
  handler) into the correct incident.

## Explicitly NOT part of Phase 5B

- Retry/backoff for failed deliveries (documented as future work in
  migration 0054 and `dispatch.ts`; not built yet).
- Any change to the approved v1.5 send policy, payload copy, or TTL — those
  are Phase 5A decisions already implemented and tested; revisiting them is
  a separate, deliberate product change, not a deployment step.
- Bumping `AVARIA_VERSION`/`package.json`'s version to 1.5.0 — that happens
  only after this checklist's real-device verification succeeds.
