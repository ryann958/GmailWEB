ALTER TABLE users
  ADD COLUMN email_verified_at timestamptz;

UPDATE users
SET email_verified_at = COALESCE(created_at, now())
WHERE email_verified_at IS NULL;

CREATE TABLE email_verification_codes (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash char(64) NOT NULL,
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX email_verification_codes_user_created_idx
  ON email_verification_codes (user_id, created_at DESC);

CREATE INDEX email_verification_codes_active_idx
  ON email_verification_codes (user_id, expires_at)
  WHERE used_at IS NULL;
