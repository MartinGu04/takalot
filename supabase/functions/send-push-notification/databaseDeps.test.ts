// Focused unit test for createDatabaseDeps' actor display-name lookup
// (Push actor name polish) -- the ONE place that decides which profile
// column can ever reach a Push payload as the actor's name. A minimal fake
// Supabase query-builder chain (.from().select().eq().maybeSingle()) is
// used instead of a real client/network call, matching this function's own
// no-network-in-tests convention (see dispatch.test.ts).
//
// deno-lint-ignore-file require-await -- the fake maybeSingle() deliberately
// matches the real client's async signature without needing an internal
// `await` itself.
import assert from "node:assert/strict";
import { createDatabaseDeps } from "./databaseDeps.ts";

interface FakeCall {
  table: string;
  columns: string;
  eqColumn: string;
  eqValue: string;
}

function fakeClient(row: Record<string, unknown> | null) {
  const calls: FakeCall[] = [];
  const client = {
    from(table: string) {
      return {
        select(columns: string) {
          return {
            eq(eqColumn: string, eqValue: string) {
              calls.push({ table, columns, eqColumn, eqValue });
              return {
                async maybeSingle() {
                  return { data: row, error: null };
                },
              };
            },
          };
        },
      };
    },
  };
  // deno-lint-ignore no-explicit-any -- deliberately minimal fake, not a real SupabaseClient
  return { client: client as any, calls };
}

Deno.test("fetchActorDisplayName selects ONLY profiles.full_name -- never email or any other column", async () => {
  const { client, calls } = fakeClient({ full_name: "דניאל דיוקרב" });
  const deps = createDatabaseDeps(client);
  const name = await deps.fetchActorDisplayName(
    "44444444-4444-4444-4444-444444444444",
  );
  assert.equal(name, "דניאל דיוקרב");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].table, "profiles");
  assert.equal(calls[0].columns, "full_name");
  assert.equal(calls[0].eqColumn, "id");
  assert.equal(
    calls[0].eqValue,
    "44444444-4444-4444-4444-444444444444",
    "must look up by the actor's id -- never the recipient's",
  );
});

Deno.test("fetchActorDisplayName returns null for a missing profile", async () => {
  const { client } = fakeClient(null);
  const deps = createDatabaseDeps(client);
  const name = await deps.fetchActorDisplayName(
    "44444444-4444-4444-4444-444444444444",
  );
  assert.equal(name, null);
});

Deno.test("fetchActorDisplayName returns null for a blank/whitespace-only full_name, never an empty-string suffix", async () => {
  const { client } = fakeClient({ full_name: "   " });
  const deps = createDatabaseDeps(client);
  const name = await deps.fetchActorDisplayName(
    "44444444-4444-4444-4444-444444444444",
  );
  assert.equal(name, null);
});

Deno.test("fetchActorDisplayName trims surrounding whitespace from a real name", async () => {
  const { client } = fakeClient({ full_name: "  דניאל דיוקרב  " });
  const deps = createDatabaseDeps(client);
  const name = await deps.fetchActorDisplayName(
    "44444444-4444-4444-4444-444444444444",
  );
  assert.equal(name, "דניאל דיוקרב");
});
