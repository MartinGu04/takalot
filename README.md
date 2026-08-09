<p align="center">
  <img src="public/branding/avaria-logo-full.png" alt="AVARIA" width="360">
</p>

# AVARIA — מערכת ניהול ומעקב תקלות

AVARIA is an internal, Hebrew-first, RTL, mobile-first incident-tracking
application. Its job is to make it obvious at every moment which incidents
are open, who owns them, what's been done, what's next, and what the next
shift needs to accept — for a unit operating systems across multiple sites.

**This is a prototype / engineering foundation, not approved for real
operational, classified, or production use.** The demo mode shown at login
says so explicitly ("אב־טיפוס להדגמה בלבד"), and every scrap of demo data
is fictional. See [Current limitations](#current-limitations) before
considering any real deployment.

## Contents

- [Project overview](#project-overview)
- [Implemented capabilities](#implemented-capabilities)
- [Roles and permissions](#roles-and-permissions)
- [Technology stack](#technology-stack)
- [Local development](#local-development)
- [Available scripts](#available-scripts)
- [Database and migrations](#database-and-migrations)
- [Testing and validation](#testing-and-validation)
- [Project structure](#project-structure)
- [Deployment](#deployment)
- [Security and data integrity](#security-and-data-integrity)
- [Current limitations](#current-limitations)

## Project overview

A shift-based operations team needs one place to answer: what's broken right
now, who's handling it, is it getting worse, and what does the next shift
need to know before they take over? AVARIA is that place — a single
incident record moves through a defined lifecycle (opened → worked →
closed/cancelled/reopened), every change is captured on an append-only
timeline, and the current-state dashboard is derived from that live data on
every visit rather than a static snapshot.

The product is Hebrew-first and right-to-left throughout, including PDF/Excel
exports, and is built mobile-first so it's usable from a phone during a
shift, not just from a desk.

## Implemented capabilities

### Incident lifecycle

- **Creation** — system/location, discovery time, description, severity,
  operational impact, actions already taken, an internal owner (required),
  an optional external handling party, and opening-time reporting questions
  (reported to the operations room, reported to communications, opened in
  WISDOM). New incidents always start `בטיפול` (in progress).
- **Updates** — a full update (status/severity/impact/owner, restricted to
  operational roles) or a technician's restricted content-only update
  (current status text, actions taken, findings, next steps — no protected
  fields), each optionally answering the same reporting questions again.
- **Closure** — requires root cause and resolution; an incomplete-readiness
  closure keeps the incident open under "כשירות חלקית" with mandatory
  follow-up notes instead of actually closing it. A genuine close records
  duration and readiness.
- **Reopening** — a closed incident can be reopened with a reason and an
  owner (role-gated — see [Roles and permissions](#roles-and-permissions)).
- **Cancellation** — a separate terminal outcome from closure (no root
  cause/resolution expected), reachable from the incident's overflow menu.
- **Corrections** — any update, status/severity/impact/assignment change can
  be amended after the fact via a dedicated correction, recorded as its own
  audit entry rather than silently rewriting history.

### Timeline and history

Every incident renders a single chronological, grouped timeline: creation,
acknowledgement, every update (with its own reporting answers), status/
severity/impact/assignment changes (explicit before/after values, never
color-only), closure, reopening, cancellation, and corrections. Multiple
field changes from one user action are grouped as one entry instead of
several disconnected rows.

### Current-state dashboard

The home view ("מצב נוכחי") shows a live open/critical-or-high summary,
a "needs attention now" section (open + critical), the rest of the open
incidents, and a compact "recently closed" strip (closed only, never
cancelled) linking to the full archive.

### Incidents and archive

- **Incidents** (`/incidents`) — every open incident, with search, filters
  (severity, system/station, assignee, location), five sort orders,
  pagination, and export.
- **Archive** (`/archive`) — every closed **and** cancelled incident, with an
  outcome filter to narrow to just one, plus system/assignee/date-range
  filters and export. General search also matches root cause and resolution
  text.

### Systems, locations, and personnel

- **Reference data** (`/admin`) — systems/stations and locations, each
  grouped into fixed product-defined categories. Create, rename, recategorize,
  drag-reorder within a category, deactivate/reactivate, and delete (an
  in-use record is archived instead of deleted, automatically). Also hosts a
  read-only, filterable audit-log view.
- **Personnel** (`/personnel`) — real user/access management in personnel
  terms: pending (not-yet-signed-in) entries, active users, and inactive/
  deleted users, grouped by role. Pre-provision a person by name, email, and
  role; edit, rename, activate/deactivate, or permanently delete (which also
  removes their Google sign-in access). A strict role-ceiling model governs
  who can register or manage whom, and the last active system administrator
  can never be demoted, deactivated, or deleted.

### Analytics

The reports page (`/reports`, "ניתוח תקלות") shows, for a selected period
(7/30/90 days) and optional system/location/severity filter: opened/closed
counts, average close time, currently-open count, average open duration,
reopened count, an opened-vs-closed trend chart, and the top systems and
locations by incident count.

### Exports

- Incident list (Incidents or Archive, respecting active filters) — `.xlsx`
  and UTF-8 CSV-with-BOM, Hebrew headers, Asia/Jerusalem-formatted dates.
- A single incident — full PDF (creation/closure details, owner history,
  complete timeline), Hebrew RTL via an embedded Alef font.

Every export call records an audit entry **before** the file is produced —
an unauthorized export never generates a file, because the backend check
runs and throws first.

### What this is *not*

- **No real WhatsApp send.** After creating or genuinely closing an
  incident, a dialog offers a pre-built Hebrew message with a "copy" button
  (`navigator.clipboard.writeText`) for pasting into a WhatsApp group by
  hand. The app has no way to know whether the message was actually pasted
  or sent anywhere.
- **No incident-list PDF** — only the export combinations listed above exist.
- Department logos shown in the desktop header are purely decorative unit
  branding, not an interactive feature.

## Roles and permissions

| Role (`Role` value) | Hebrew label |
|---|---|
| `system_admin` | מנהל מערכת |
| `professional_manager` | נגד / מנהל מקצועי |
| `shift_supervisor` | אחמ״ש |
| `technician` | טכנאי |
| `viewer` | צפייה בלבד |

(The personnel page and the internal-owner picker use a shorter label for
`professional_manager` — "נגד" — everywhere else the fuller label above is
used.)

| Capability | מנהל מערכת | נגד / מנהל מקצועי | אחמ״ש | טכנאי | צפייה בלבד |
|---|:---:|:---:|:---:|:---:|:---:|
| View all incidents | ✓ | ✓ | ✓ | ✓ | ✓ |
| Create, close, or reassign an incident's owner | ✓ | ✓ | ✓ | ✓ | – |
| Acknowledge, fully update, change severity, cancel, or complete follow-up on an incident | ✓ | ✓ | ✓ | – | – |
| Manage personnel | ✓ | ✓ | ✓ | – | – |
| Technical update (own assigned incidents only) | – | – | – | ✓ | – |
| Reopen a closed incident | ✓ | ✓ | only if backend policy allows it | – | – |
| Export (PDF/XLSX/CSV) | ✓ | ✓ | ✓ | – | only with an explicit backend grant |
| Manage systems/locations reference data | ✓ | – | – | – | – |
| View full audit log | ✓ | incidents/handovers/exports only | – | – | – |

A few things this table doesn't show on its own:

- **Registering or managing personnel is a strict hierarchy**: a system
  administrator may reach any role, including other system administrators;
  a professional manager or shift supervisor may each only reach roles
  strictly below their own (never a peer or their own role) — down to
  technicians and viewers. Technicians and viewers cannot register or
  manage anyone.
- **A viewer can never be an incident's internal owner**, even if active.
- Reopening by a shift supervisor and export access for a viewer are
  **backend policy decisions**, not frontend toggles, and both default to off.

`src/domain/permissions.ts` is the single source of truth for this table;
see [Security and data integrity](#security-and-data-integrity) for how
it's enforced end to end.

## Technology stack

| Layer | Choice |
|---|---|
| Frontend | React 18 + TypeScript, Vite, Tailwind CSS v4, React Router, TanStack Query, React Hook Form + Zod |
| Data layer | An abstraction (`src/data/repository.ts`) with two implementations — a local in-browser demo repository and a real Supabase repository — selected at runtime, never mixed |
| Backend / database | Supabase (PostgreSQL): SQL schema, `SECURITY DEFINER` RPCs, and Row-Level Security policies in `supabase/migrations/` |
| Authentication | Google OAuth via Supabase Auth |
| Exports | `jspdf` (PDF, embedded Hebrew font) and `xlsx` (Excel), plus a hand-written UTF-8 CSV writer |
| Hosting | Vercel (static SPA build), `vercel.json` rewrites every path to `index.html` |
| Testing | Vitest + Testing Library (unit/component), Playwright (end-to-end), a GitHub Actions workflow that runs the SQL migration test suite against a disposable PostgreSQL 16 instance |

## Local development

### Prerequisites

- Node.js and npm (no specific version is pinned in this repository — use a
  current LTS Node release).

### Install

```bash
npm install
```

### Run in demo mode (no backend required)

```bash
VITE_DEMO_MODE=true npm run dev
```

Open <http://localhost:5173> and pick any fictional demo user on the login
screen — their role is shown next to their name. Plain `npm run dev` with no
environment variables also falls back to demo mode in a development build.

### Run against a real Supabase project

Create a gitignored `.env.local` in the repository root:

```bash
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```

Then:

```bash
npm run dev
```

`src/data/appMode.ts` resolves the mode strictly at startup:

- `VITE_DEMO_MODE=true` → demo mode, unconditionally (wins over any Supabase
  configuration present).
- Both Supabase variables set and valid → Supabase mode.
- Only one of the two Supabase variables set, or the key doesn't look like a
  publishable key → a configuration-error screen, in every build mode.
- A key that looks like a service-role secret (`sb_secret_...` prefix, or a
  JWT payload with `role: "service_role"`) is refused outright — it must
  never be a client-side variable.
- Neither variable set → demo mode in development, but a hard
  configuration-error screen in a **production** build. Production never
  silently falls back to demo data.

### Environment variables

| Variable | Required for | Notes |
|---|---|---|
| `VITE_SUPABASE_URL` | Supabase mode | Project URL, must be `https:`. |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Supabase mode | Public (publishable) key only. **Never** put a service-role key, database password, or OAuth client secret in a `VITE_*` variable — it ships to every browser. |
| `VITE_DEMO_MODE` | Demo mode | Must be exactly `true` to explicitly enable the local demo repository. The Playwright config sets this for e2e runs. |
| `VITE_VAPID_PUBLIC_KEY` | Push notifications (optional, v1.5.0 Phase 4+) | Web Push application-server public key (VAPID), base64url-encoded. Optional — unset or invalid resolves to a calm "not available" Push state rather than an error. **Never** put the matching private key in a `VITE_*` variable or anywhere client-side; the real hosted keypair and server-side dispatch are a Phase 5 concern. |

No `.env.example` file exists in the repository yet — the Supabase and Push
variables above are the complete set needed for `.env.local`.

### First administrator (one-time, Supabase mode only)

A fresh database has zero profiles, so nobody can create or claim anything
yet. The project owner performs exactly **one** manual, server-side action
in the Supabase SQL editor before the first login:

```sql
insert into public.bootstrap_admin_config (email)
values ('owner.account@gmail.com');
```

The owner then signs in once with Google, normally. The backend verifies
the confirmed Google identity server-side against that address and creates
the single first `system_admin` profile — at most once, ever. Knowing the
email grants nothing on its own: the caller must *be* the verified Google
account behind it.

### Provisioning every other user (Supabase mode only)

1. An authorized creator (see the role-ceiling rules above) registers the
   person as a **pending personnel entry** — full name, Google email, and
   intended role — before they ever sign in.
2. The person signs in once with Google. On that first authenticated
   session, the backend automatically and atomically claims the matching
   entry using the *verified* email from `auth.users` (never client input),
   creates their `profiles` row with the preassigned role, and marks the
   entry claimed. No invitation link, no manual ID handling.
3. No valid matching entry (none, cancelled, expired, already claimed, or a
   different Google account) → the person stays on an unauthorized-access
   screen. Nothing is ever auto-created from a Google identity alone.

## Available scripts

| Script | What it does |
|---|---|
| `npm run dev` | Start the Vite dev server (default `http://localhost:5173`). |
| `npm run build` | Type-check (`tsc -b`) then produce a production build (`vite build`). |
| `npm run preview` | Serve the last production build locally. |
| `npm run typecheck` | Type-check only (`tsc -b`), no build output. |
| `npm test` | Run the Vitest unit/component suite once. |
| `npm run test:watch` | Run Vitest in watch mode. |
| `npm run test:e2e` | Run the Playwright end-to-end suite (starts its own dev server in demo mode). |

There is no `lint` or `format` script — the repository has no ESLint or
Prettier configuration.

## Database and migrations

```
supabase/
  migrations/   sequential, numbered SQL migrations (0001_schema.sql, 0002_functions.sql, ...)
  functions/    Supabase Edge Functions
  tests/        pgTAP-style SQL test suite exercised by CI
```

Migrations are strictly sequential and additive — never edit an already-
applied migration; add a new one. The foundational three set the pattern
every later migration follows:

- `0001_schema.sql` — tables, enums, indexes, and immutability triggers.
- `0002_functions.sql` — the `SECURITY DEFINER` RPCs that own every write:
  atomic incident numbering, transition validation, closure/reopen/handover
  logic, audit writes.
- `0003_rls.sql` — Row-Level Security policies for every exposed table.

Every migration since keeps to that shape: a schema change ships alongside
the RPC/RLS changes it needs, in the same file, so a table is never exposed
without its policies. The migration history as a whole reflects a few
recurring themes worth knowing about: hardening personnel/access rules
(role ceilings, tombstoned deletion, owner eligibility), expanding the
incident lifecycle (new statuses, reporting fields, corrections), and
adding reference-data management (systems/locations categorization) and
analytics on top of the same foundation.

**Local development** does not require a live database at all — demo mode
runs entirely in the browser against an in-memory/localStorage repository
that independently re-implements the same permission and lifecycle rules.

**Applying migrations to a hosted Supabase project** is a separate,
deliberate operational step, not something this repository or its build
runs automatically: apply them in order with the Supabase CLI
(`supabase db push`) or by pasting each file into the SQL editor in
sequence. All lifecycle mutations go through the RPCs in the migrations —
the application code never writes incident rows directly.

### Server-side operations (Edge Functions)

`supabase/functions/delete-user/` is the one place a service-role key is
used, and it never reaches the browser. Deleting a person is two required
steps, in order: (1) `admin_delete_user`, a normal RPC authorized exactly
like any other action (role-ceiling checked; blocks self-deletion, deleting
the last active system administrator, or deleting someone who still owns an
open incident) — it tombstones the profile and writes an audit entry, but
does not touch the Auth account; (2) only if that succeeds, the Edge
Function uses a separate service-role client to delete the actual Supabase
Auth account. Both steps are idempotent and safe to retry. Deploying the
function (`supabase functions deploy delete-user`) is a separate explicit
step from any code change.

## Testing and validation

```bash
npm run typecheck   # tsc -b
npm test            # Vitest: unit + component tests
npm run test:e2e    # Playwright: end-to-end flows (starts its own dev server)
npm run build       # type-check + production build
```

- **Vitest** (`src/**/*.test.{ts,tsx}`) covers domain logic (permissions,
  status transitions, overdue/priority calculation, dashboard summaries,
  notification-message building), the data layer (both repository
  implementations, including optimistic concurrency and atomic incident
  numbering), export generation (PDF byte signatures, CSV/XLSX encoding and
  exact Hebrew file names), and component/page behavior rendered through
  the real app shell with a real (local demo) repository behind it.
- **Playwright** (`e2e/*.spec.ts`) exercises full user journeys end-to-end
  against a real running dev server in demo mode: incident lifecycle by
  role, reopening, exports (verified by reading the downloaded file's
  actual bytes, not just its filename), personnel management,
  reference-data drag-reorder, analytics, mobile/RTL layout, and
  authorization/routing.
- **`.github/workflows/postgresql-verification.yml`** runs on any pull
  request touching `supabase/migrations/` or `supabase/tests/`: it spins up
  a disposable PostgreSQL 16 instance and runs the SQL test suite plus a set
  of migration-atomicity/backfill/concurrency verification scripts — a
  third, independent layer of validation for the database itself.

There is no lint or format script in this repository (see
[Available scripts](#available-scripts)).

## Project structure

```
src/
  pages/         Routed screens (Dashboard, Incidents, Archive, Incident
                 detail/create, Personnel, Admin, Reports, Login)
  components/    Shared UI: brand/layout chrome, the incident card/badges,
                 the shared Timeline, filter bars, plus analytics/ and
                 dialogs/ subfolders for the reporting widgets and modal
                 actions
  domain/        Pure business logic and types — roles/permissions, status
                 transitions, zod schemas, labels, dashboard/analytics
                 summaries — independent of React or any data source
  data/          The repository abstraction (repository.ts, hooks.ts) plus
                 the two implementations: data/local (in-browser demo) and
                 data/supabase (real client + RPC calls)
  auth/          Authentication context/provider (Supabase and demo)
  exports/       PDF/XLSX/CSV generation, RTL bidi text handling, file
                 naming
  lib/           Small framework-agnostic utilities (time formatting,
                 debounced fields, URL-persisted filter state, ...)
  test/          Vitest setup and test helpers

supabase/        SQL migrations, Edge Functions, and the SQL test suite
e2e/             Playwright end-to-end specs
public/          Static assets: AVARIA branding, favicons, embedded fonts
.github/         CI workflow for the SQL migration test suite
```

## Deployment

`vercel.json` configures the app as a single-page application: every path
rewrites to `index.html`, since routing is handled entirely client-side by
React Router. Beyond that one rewrite rule, this repository has no Vercel
project configuration — build/branch/environment wiring lives in the
hosting platform's own project settings, not in this repository.

A production build enforces its own safety net regardless of how or where
it's built: see [Run against a real Supabase project](#run-against-a-real-supabase-project)
for the exact configuration rules. Applying database migrations to a
hosted Supabase project (see [Database and migrations](#database-and-migrations))
is always a separate, manual step from any frontend deployment.

## Security and data integrity

- **Identity is not authorization.** Signing in with Google only proves who
  someone is; they also need an active row in `public.profiles`, which only
  an authorized user can create (via the pending-personnel or bootstrap
  flow above) — nothing is ever auto-provisioned from a successful login
  alone.
- **The client never writes incident data directly.** Every lifecycle
  mutation (create/update/close/reopen/cancel/assign/handover) goes through
  a `SECURITY DEFINER` RPC in `supabase/migrations/`, and Row-Level Security
  policies cover every exposed table — authorization lives in the database,
  not the UI.
- **One shared source of truth for permissions.** `src/domain/permissions.ts`
  defines the capability matrix once; the local demo repository and the
  Supabase RPCs/RLS each independently enforce the same rules rather than
  trusting the frontend to hide the right buttons.
- **The service-role key is isolated to one Edge Function**
  (`supabase/functions/delete-user`) and never reaches the browser or any
  client bundle; every other operation uses only the public, publishable
  key.
- A publishable key that looks like a server secret is rejected outright by
  `src/data/appMode.ts` before the app will even start.

This section documents verified principles, not a security audit — see
[Current limitations](#current-limitations).

## Current limitations

- **Not security-reviewed or authorized for real operational, classified,
  or production use.** Stated explicitly on the login screen in demo mode
  and here.
- Technician incident visibility is "every technician sees every incident,
  but may only add technical updates to ones assigned to them" — a simpler
  model than a per-department visibility scheme.
- Large PDF/XLSX export libraries aren't code-split beyond route-level lazy
  loading, so the production bundle includes a few large JavaScript chunks
  — a build-size concern, not a functional defect.
- Dependency vulnerabilities should be checked with `npm audit` before any
  real deployment rather than assumed current from this document.
- There is no `.env.example`, `LICENSE`, or `CONTRIBUTING.md` in this
  repository yet (see [Available scripts](#available-scripts) for the
  missing lint/format tooling).
