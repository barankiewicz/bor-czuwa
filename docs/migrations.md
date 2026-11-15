# Schema migrations

Run `npm run migrate` before starting the API or loading geodata. It needs
`MIGRATION_DATABASE_URL` for the current schema owner (or a database
administrator) and `RUNTIME_DB_PASSWORD` for the `app_runtime` login. Give the
API `DATABASE_URL` with that runtime login. Give geodata ingest the migration
credential. Do not give the API a schema-owner credential.

Private demo maintenance, ingest and API environments set
`RUNTIME_DB_ROLE=bor_czuwa_demo_runtime`. Root bootstrap creates that restricted login
and its password separately; the demo schema owner does not need `CREATEROLE`.
The default remains `app_runtime`. Migration SQL files are never edited: for the
demo only, the runner binds that explicit role in grants and operator-event
protection, then hashes the exact rendered SQL. API startup checks the same
role-specific ledger. Changing or omitting the role against an existing demo
database fails compatibility rather than granting access to the production role.

The migration command takes a database advisory lock. It records each migration's
number and SHA-256 in `schema_migrations` (the SQL file bytes by default, rendered
role-specific bytes for the demo), in the same transaction as that migration's
changes. It also creates or updates the default runtime login and loads Rule sets. A
failed SQL file leaves no ledger row or partial changes; fix the cause and rerun
the command. Never edit an applied SQL file. Add the next numbered file instead,
and add it to the list in `server/migrations.ts`: a SQL file missing from that
list stops the command and API startup with `migration_list_mismatch`.

Rule sets follow the same rule. When a file under `data/rule-sets/` no longer
matches the Rule set stored under its id, the command and API startup stop with
`rule_set_changed:<id>`. Publish the correction under a new id.

API startup reads the ledger and checks every version, checksum and stored Rule
set. It refuses
an unmigrated database, changed migration history, or a schema newer than the
application. Startup does not apply DDL or reload Rule sets. For rollback,
restore a database backup and application build from a compatible pair; an
older build cannot run against a newer ledger.

The first migration includes the former `schema.sql`. On an existing database
without a ledger, run the migration command once with its current schema owner.
It applies that idempotent baseline inside a transaction, then records version
1. Keep a backup before this upgrade. Later starts use only the compatibility
check.

Back up the database with `pg_dump -Fc --exclude-table-data=public.rate_counter`.
The dump includes `schema_migrations`; restore it with the application data.
After `pg_restore`, start the matching application or run its compatibility
check before admitting traffic. The `rate_counter` table is unlogged and holds
temporary admission state, so it does not need restoration. Backup encryption,
retention, and the full production restore drill belong to phase-2 ticket 28.
