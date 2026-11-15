-- Findings holds this row while it reads a snapshot. The checked singleton
-- column gives the worker PostgreSQL's required UPDATE privilege for FOR SHARE
-- without granting permission to change snapshot_id.
GRANT UPDATE (singleton) ON current_geodata TO app_runtime;
