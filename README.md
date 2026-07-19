# Nexus — מערכת ניהול ומעקב תקלות

An internal, Hebrew-first, RTL, mobile-first incident-tracking tool. Its single
purpose: make it obvious at every moment which incidents are open, who owns
them, what's been done, what's next, and what the next shift must accept.

**This is a prototype/engineering foundation. It is not approved for
operational, classified, military, or production use.** All demo data is
fictional. Real deployment requires a separate security and authorization
review — see [Known limitations](#known-limitations).

## Stack

React + TypeScript + Vite, Tailwind CSS, React Hook Form + Zod, TanStack
Query, React Router. Data layer is an abstraction (`src/data/repository.ts`)
with two implementations:

- **Local demo repository** (`src/data/local`) — runs entirely in the browser
  (localStorage), but *enforces the same rules a real backend would*:
  permissions, status transitions, optimistic concurrency, atomic incident
  numbering, and an append-only audit log. It is not a UI convenience layer.
- **Supabase repository** (`src/data/supabase`) — the production data layer:
  real Google authentication (Supabase Auth) and the hosted database, via the
  SQL schema, RPCs, and RLS in `supabase/migrations/`.

Mode selection (`src/data/appMode.ts`) is strict:

- Valid `VITE_SUPABASE_URL` + `VITE_SUPABASE_PUBLISHABLE_KEY` → **supabase mode**.
- `VITE_DEMO_MODE=true` → **demo mode** (explicit development/test fallback;
  shows the persistent "מצב הדגמה" banner + demo-only role switcher).
- No configuration in a dev/test build → demo mode (development fallback).
- No or partial configuration in a **production build** → a hard
  configuration-error screen. Production **never** silently falls back to
  demo data. A key that looks like a server secret (`sb_secret_…`, or a JWT
  with `role=service_role`) is refused outright.

### Authentication and authorization (supabase mode)

Sign-in is Google OAuth via Supabase Auth. **Identity is not authorization**:
after Google proves who you are, you must also match an **active row in
`public.profiles`** (readable under RLS only by active members). No profile →
a clear unauthorized-access screen with logout; profiles are provisioned by
an administrator only and are never auto-created by a successful login.
Application roles come from that profiles row — the database is the source
of truth.

## Setup and run

```bash
npm install
VITE_DEMO_MODE=true npm run dev   # http://localhost:5173, explicit demo mode
```

(Plain `npm run dev` with no env vars also falls back to demo in
development.) Pick any demo user on the login screen — role is shown next to
the name.

### Environment variables

| Variable | Required for | Notes |
|---|---|---|
| `VITE_SUPABASE_URL` | Supabase mode | Project URL (https). |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Supabase mode | Public (publishable) key only — `sb_publishable_…` or the legacy JWT-shaped public key. **Never** put a service-role key, database password, or OAuth client secret in client env vars. |
| `VITE_DEMO_MODE` | Demo fallback | `true` explicitly enables the local demo repository (development/tests only — the e2e suite sets it). |

Create a gitignored `.env.local` with the two Supabase variables to run
against the hosted project.

### Provisioning a new authorized user (supabase mode)

1. An authorized creator (shift supervisor, NCO, or system administrator)
   registers the person as a **pending personnel entry** — full name, Google
   email, and intended role — *before* they ever sign in. Role ceilings are
   enforced in the database: a supervisor may register technicians and
   supervisors; an NCO additionally NCOs; only a system administrator may
   register any role. Technicians cannot register anyone.
2. The person signs in once with Google. On that first authenticated
   session the backend **automatically and atomically claims** the matching
   entry: it derives the identity from `auth.uid()`, reads the *verified*
   email server-side from `auth.users` (client input plays no part),
   creates the `public.profiles` row with the preassigned role, and marks
   the entry claimed. No invitation link, no manual UUID handling, no
   dashboard step.
3. No valid matching entry (none, cancelled, expired, already claimed, or a
   different Google account) → the user stays on the unauthorized-access
   screen. Nothing is ever auto-created from a Google identity alone.

## Database migrations (Supabase)

```
supabase/migrations/
  0001_schema.sql      tables, enums, indexes, immutability triggers
  0002_functions.sql   SECURITY DEFINER RPCs: atomic numbering, transition
                       validation, closure/reopen/handover logic, audit writes
  0003_rls.sql         RLS policies for every exposed table
```

Apply with the Supabase CLI (`supabase db push`) or paste into the SQL editor
in order. All lifecycle mutations (create/update/close/reopen/assign/handover)
go through the RPCs in `0002_functions.sql` — the client never writes
incident rows directly, so authorization lives in the database, not the UI.

## Demo mode

Fictional users covering every role (see `src/data/local/seed.ts`,
`DEMO_USERS`), and fictional incidents covering: a critical overdue incident,
a high-severity incident in progress, one waiting on an external party, one
in monitoring, one closed with full readiness, one closed with partial
readiness (follow-up required), one reopened incident, one pending handover,
one accepted handover. No real systems, locations, incidents, or personnel
are referenced anywhere.

The role switcher in the top bar (labeled "החלפת תפקיד (הדגמה)") is
demo-only, styled distinctly (orange), and is naturally excluded from any
real deployment since it depends on `isDemoMode()` being true.

## Role matrix

| Capability | מנהל מערכת | נגד / מנהל מקצועי | אחמ"ש | טכנאי | צפייה בלבד |
|---|:---:|:---:|:---:|:---:|:---:|
| View all incidents | ✓ | ✓ | ✓ | ✓ | ✓ |
| Create / assign / close incidents | ✓ | ✓ | ✓ | – | – |
| Technical update (own assigned incidents only) | ✓* | ✓* | ✓* | ✓ | – |
| Change severity / operational impact | ✓ | ✓ | ✓ | – | – |
| Reopen a closed incident | ✓ | ✓ | only if backend policy `allow_supervisor_reopen` is set | – | – |
| Create / accept handover | ✓ | ✓ | ✓ | – | – |
| Export (PDF/XLSX/CSV) | ✓ | ✓ | ✓ | – | only with an explicit backend grant |
| Manage users / systems / locations | ✓ | – | – | – | – |
| View full audit log | ✓ | incidents/handovers/exports only | – | – | – |

\* these roles also have full update rights; the technician-only "content
only" restriction doesn't apply to them.

Enforcement is **backend-first**: `src/domain/permissions.ts` is the single
source of truth, mirrored by the local repository's runtime checks and by
the Supabase RLS policies / RPC checks in `0002_functions.sql` +
`0003_rls.sql`. The UI hides unavailable actions, but hiding a button is not
how authorization is enforced — every capability above is independently
checked in `LocalDemoRepository` and in the corresponding SQL function.

## Tests

```bash
npm test          # Vitest: unit + component tests
npm run test:e2e  # Playwright: critical end-to-end flows (starts the dev server)
```

### What's covered

**Vitest (71 tests, `npm test`)**
- Incident-number atomicity under concurrent creation + yearly reset (Asia/Jerusalem)
- Full role/permission matrix
- Status-transition validity (including "must use dedicated flow" for close/reopen)
- Technician update restrictions (assigned-only, no protected fields)
- Closure requirements (root cause + resolution mandatory, follow-up required
  when readiness isn't full)
- Reopening requirements (reason, owner, next-update deadline; supervisor
  gated by backend policy)
- Overdue calculation and dashboard priority sort
- Optimistic concurrency (stale version is rejected)
- Handover creation (correct incident snapshot) and acceptance (only the
  named recipient, only once)
- Filter behavior (severity/status/overdue/search)
- Export permission enforcement (backend-checked, not just hidden buttons)
- CSV Hebrew/UTF-8 BOM encoding, escaping, mixed-language content, zero-row export
- PDF generation (valid `%PDF-` bytes, Hebrew/mixed-language text, pagination)
- Exact Hebrew export file names (`תקלה-2026-001.pdf`, `תקלות-...-עד-...xlsx`)
- RTL document attributes + mobile bottom-nav destination count
- Unauthorized route access (direct URL navigation is blocked)

**Playwright (8 flows, `npm run test:e2e`)**
1. Shift supervisor creates an incident, assigns a technician, adds an
   update, and closes it
2. Technician adds a permitted technical update to their assigned incident
   and has no close/assign actions available
3. Supervisor creates a handover; a different supervisor accepts it
4. Professional manager reopens a closed incident
5. Authorized user filters the archive and exports XLSX/CSV (verified by
   reading the downloaded file's real bytes: PK zip signature / UTF-8 BOM)
6. Authorized user exports a complete incident PDF (verified via `%PDF-` byte
   signature)
7. Viewer is blocked from mutation routes and sees no mutating buttons
8. Mobile RTL layout: `dir="rtl"`, no horizontal overflow, compact bottom nav

All 79 tests were **actually executed** in this environment; results above
reflect the real, current run — not a static claim.

### A note on export file names in this sandbox

Headless Chromium in this environment cannot report non-Latin `download`
attribute values through Playwright's `suggestedFilename()` API — confirmed
independent of this app (a bare `א.csv` blob download is reported back as the
literal string `"download"`, extension included, even without our app code
in the picture). The e2e export tests therefore verify the downloaded file's
actual bytes; the exact required Hebrew file names
(`תקלה-2026-001.pdf`, `תקלות-2026-07-01-עד-2026-07-31.xlsx`) are verified
directly and deterministically in `src/exports/filenames.test.ts`.

## Export behavior

- **Single incident PDF** — app name, generation time, full creation/closure
  details, owner history, complete timeline, exported-by. Hebrew RTL via
  jsPDF's native `setR2L`/`isInputRtl` support with the embedded, permissively
  licensed Alef font (SIL OFL, see `public/fonts/OFL-Alef.txt`).
- **Shift handover PDF** — creator/recipient, timestamps, general note, every
  included incident's snapshot, pending/accepted state.
- **Filtered incidents export** — `.xlsx` and UTF-8 CSV-with-BOM, respecting
  active filters, Hebrew headers, Asia/Jerusalem-formatted dates, only the
  fields the spec lists (no incident description — it isn't in that list).
- Every export call records an audit entry (user, time, export type, active
  filters) **before** the file is generated — an unauthorized export never
  produces a file, because the backend check runs first and throws.

## Known limitations

- Not security-reviewed or authorized for real operational/classified use.
  This is stated explicitly in the login screen and here.
- Supabase repository is implemented and migration-complete but has not been
  run against a live Supabase project (no credentials were available in this
  environment) — treat it as ready-to-connect, not battle-tested.
- Technician visibility is simplified to "all technicians see all incidents,
  but may only mutate ones assigned to them" rather than a finer per-department
  visibility model; the spec allows either interpretation ("assigned to them
  and other incidents explicitly visible to the department").
- `npm audit` reports vulnerabilities in transitive build-tooling
  dependencies (Vite/esbuild toolchain); none are reachable at runtime in the
  shipped app, but a real deployment should re-audit before release.
- Large PDF/XLSX libraries are not yet code-split beyond route-level lazy
  loading; the production bundle has a few chunks over 500kB (noted by the
  Vite build, not a functional defect).
- Non-ASCII (Hebrew) `download` attribute filenames cannot be introspected by
  Playwright in this specific sandboxed headless Chromium — see the testing
  section above. This affects test *observability* only, not the app.
