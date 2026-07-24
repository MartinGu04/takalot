-- Supabase client roles, created idempotently (cluster-level; safe to
-- re-run). Mirrors the hosted platform's role model closely enough for
-- grant/RLS verification: anon and authenticated are the two JWT-mapped
-- client roles; service_role bypasses RLS on the platform (modelled here
-- as a plain role -- tests never rely on its bypass).
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin;
  end if;
end $$;
