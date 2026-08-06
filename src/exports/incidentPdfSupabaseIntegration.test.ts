// Integration/regression coverage for the exact runtime bug reported after
// the first PDF-classification commit: the generated PDF was missing the
// new lifecycle-classification data for a real, Supabase-backed reopened
// incident, even though the same data rendered fine in unit tests built on
// hand-written fixtures.
//
// This suite reproduces the report as literally as this sandboxed
// environment allows: it drives the REAL RPCs (create_incident_v2/
// update_incident/close_incident_v2/reopen_incident) against a local
// Postgres instance running the actual migration chain (supabase/
// migrations/*.sql, unmodified), reads the resulting rows back with plain
// SQL exactly like SupabaseRepository's own `.select('*')...` queries
// would, and maps them through the REAL, exported SupabaseRepository row
// mappers (mapIncident/mapIncidentEvent/mapIncidentUpdate/
// mapCauseAssessment/mapTreatmentAction/mapClosure) -- never a
// hand-written substitute for that mapping logic. The resulting PDF's
// actual bytes are then text-extracted (pdfjs-dist) and asserted against,
// so a regression that silently drops data (e.g. the fixed race condition
// where IncidentDetailPage read the classification queries' still-loading
// `undefined` state instead of fetching fresh) would fail this test even
// though it would never show up in a fixture-only unit test.
//
// Skips cleanly (not a failure) if local Postgres/sudo access isn't
// available in the current environment -- npm test must stay runnable
// everywhere, matching supabase/tests/run.sh's own local-Postgres-only
// convention (that harness isn't part of `npm test` either).
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { buildIncidentPdf } from './incidentPdf';
import { DEPARTMENT_LOGOS } from '../components/DepartmentLogos';
import {
  mapCauseAssessment,
  mapClosure,
  mapIncident,
  mapIncidentEvent,
  mapIncidentUpdate,
  mapLocation,
  mapProfile,
  mapSystem,
  mapTreatmentAction,
} from '../data/supabase/supabaseRepository';

const DB = 'takalot_pdf_integration_test';
const PSQL = ['sudo', '-u', 'postgres', 'psql'] as const;

function run(args: string[], opts: { encoding?: 'utf-8' } = {}) {
  const [cmd, ...rest] = PSQL;
  return execFileSync(cmd, [...rest, ...args], { encoding: opts.encoding, stdio: opts.encoding ? undefined : 'ignore' });
}

function pgAvailable(): boolean {
  try {
    run(['-c', 'select 1']);
    return true;
  } catch {
    return false;
  }
}

const available = pgAvailable();

async function extractAllText(bytes: Uint8Array): Promise<string> {
  const doc = await getDocument({
    data: bytes,
    useWorkerFetch: false,
    useSystemFonts: true,
  }).promise;
  let text = '';
  for (let p = 1; p <= doc.numPages; p += 1) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    text += content.items.map((item) => ('str' in item ? item.str : '')).join(' ') + '\n';
  }
  return text;
}

describe.skipIf(!available)('buildIncidentPdf: real Supabase-backed integration (local Postgres, real RPCs, real row mappers)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let dump: any;

  beforeAll(() => {
    run(['-c', `drop database if exists ${DB};`]);
    run(['-c', `create database ${DB} owner postgres;`]);
    run(['-d', DB, '-v', 'ON_ERROR_STOP=1', '-f', 'supabase/tests/harness/prelude.sql']);
    const migrationFiles = readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).sort();
    for (const f of migrationFiles) {
      run(['-d', DB, '-v', 'ON_ERROR_STOP=1', '-q', '-f', `supabase/migrations/${f}`]);
    }
    const out = run(
      ['-d', DB, '-t', '-A', '-q', '-v', 'ON_ERROR_STOP=1', '-f', 'src/exports/fixtures/pdfIntegrationScenario.sql'],
      { encoding: 'utf-8' },
    ) as unknown as string;
    const lastLine = out.trim().split('\n').filter(Boolean).pop();
    if (!lastLine) throw new Error('pdfIntegrationScenario.sql produced no output');
    dump = JSON.parse(lastLine);
  }, 180_000);

  afterAll(() => {
    try {
      run(['-c', `drop database if exists ${DB};`]);
    } catch {
      // best-effort cleanup only
    }
  });

  it('reproduces the reported scenario end to end and the generated PDF text contains every classification value', async () => {
    const incident = mapIncident(dump.incident);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const events = (dump.events as any[]).map(mapIncidentEvent);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updates = (dump.updates as any[]).map(mapIncidentUpdate);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const causeAssessments = (dump.causeAssessments as any[]).map(mapCauseAssessment);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const treatmentActions = (dump.treatmentActions as any[]).map(mapTreatmentAction);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const closures = (dump.closures as any[]).map(mapClosure);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const profiles = (dump.profiles as any[]).map(mapProfile);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const systems = (dump.systems as any[]).map(mapSystem);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const locations = (dump.locations as any[]).map(mapLocation);

    // Sanity-check the scenario itself before checking the PDF -- these
    // assertions are on the REAL RPC-produced/mapped data, independent of
    // the PDF export entirely.
    expect(incident.status).toBe('reopened');
    expect(incident.reopenCount).toBe(1);
    expect(incident.reportedDomain).toBe('infrastructure');
    expect(incident.currentSuspectedCause).toBeNull(); // reset by reopen_incident
    expect(closures).toHaveLength(1);
    expect(closures[0].cycleNumber).toBe(0);
    expect(closures[0].confirmedCause).toBe('software');

    const logos = DEPARTMENT_LOGOS.map((l) => ({
      key: l.key,
      bytes: new Uint8Array(readFileSync(`public${l.src}`)),
    }));
    const pdf = await buildIncidentPdf(
      incident,
      events,
      updates,
      profiles,
      systems,
      locations,
      'Integration Test Exporter',
      logos,
      causeAssessments,
      treatmentActions,
      closures,
    );

    const rawText = await extractAllText(pdf.outputBytes());
    // pdfjs' text-content extraction inserts a space between individual
    // glyph-show operations in a merged RTL run (see pdf.ts's own header
    // comment -- the *drawn*/copy-pasted reading order is correct, this is
    // purely a pdfjs item-clustering artifact) -- comparisons are made
    // whitespace-insensitive so this artifact never causes a false negative
    // or, by stripping too little, a false positive.
    const normalized = rawText.replace(/\s+/g, '');
    const expectContains = (label: string, value: string) => {
      expect(normalized, `expected the PDF text to contain ${label} ("${value}")`).toContain(value.replace(/\s+/g, ''));
    };

    // ===== Main summary =====
    expectContains('reported domain label', 'תחום התקלה');
    expectContains('reported domain value (infrastructure)', 'תשתית או חשמל');
    // Reopened + active -> "חשד נוכחי" must show, with the unassessed
    // fallback (reset to null by reopen, never the pre-reopen/confirmed
    // cause).
    expectContains('current suspected cause label', 'חשד נוכחי');
    expectContains('unassessed cause fallback', 'לא הוזנה הערכת גורם');

    // ===== Timeline: creation event =====
    expectContains('initial suspected cause line', 'חשד ראשוני');
    expectContains('initial suspected cause value (equipment)', 'ציוד או חומרה');
    expectContains('documented-at-opening wording', 'תועד בעת פתיחת התקלה');
    expectContains('initial treatment action (diagnosis)', 'בדיקה או אבחון');

    // ===== Timeline: update event (cause change + structured action) =====
    expectContains('cause-change title prefix', 'חשד נוכחי שונה');
    expectContains('updated cause value (software)', 'תוכנה');
    expectContains('update treatment action (software_fix)', 'תיקון תוכנה');

    // ===== Timeline: historical closure event (must survive the reopen) =====
    expectContains('confirmed cause label', 'הגורם שאומת');
    expectContains('treatment outcome label', 'תוצאת הטיפול');
    expectContains('treatment outcome value (permanent_resolution)', 'פתרון קבוע');
    expectContains('resolution attribution label', 'מה ידוע על מה שהוביל לפתרון');
    expectContains('resolution attribution value (specific_action)', 'פעולה מסוימת שתועדה');
    expectContains('linked resolving action (config_change)', 'שינוי הגדרה');

    // ===== Timeline: the reopen itself is recorded =====
    expectContains('reopened event title', 'התקלה נפתחה מחדש');
  }, 60_000);
});
