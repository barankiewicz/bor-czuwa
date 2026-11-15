#!/usr/bin/env bash
# PostgreSQL alone installs extensions and assigns the database roles.
set -euo pipefail
[[ $EUID == 0 ]]
runuser -u postgres -- psql -XAt -v ON_ERROR_STOP=1 -c "SELECT 1 FROM pg_roles WHERE rolname='bor_czuwa_owner'" | grep -qx 1 || \
  runuser -u postgres -- createuser bor_czuwa_owner
runuser -u postgres -- psql -XAt -v ON_ERROR_STOP=1 -c "SELECT 1 FROM pg_database WHERE datname='bor_czuwa'" | grep -qx 1 || \
  runuser -u postgres -- createdb --owner=bor_czuwa_owner bor_czuwa
runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -d bor_czuwa <<'SQL'
CREATE EXTENSION IF NOT EXISTS postgis;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime LOGIN;
  END IF;
END $$;
ALTER ROLE app_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE bor_czuwa_owner LOGIN NOSUPERUSER NOCREATEDB CREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT app_runtime TO bor_czuwa_owner WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
SQL
