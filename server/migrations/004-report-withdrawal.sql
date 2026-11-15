-- Acknowledged withdrawal must outlive uncertain or delayed Report uploads.
CREATE TABLE report_withdrawal (
  id uuid PRIMARY KEY,
  token_sha256 text NOT NULL CHECK (token_sha256 ~ '^[a-f0-9]{64}$'),
  withdrawn_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON report_withdrawal TO app_runtime;
