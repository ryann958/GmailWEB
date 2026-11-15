CREATE TABLE withdrawal_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_idr bigint NOT NULL CHECK (amount_idr > 0),
  method varchar(16) NOT NULL
    CHECK (method IN ('bank', 'dana', 'ovo', 'gopay')),
  recipient_name varchar(80) NOT NULL,
  destination varchar(64) NOT NULL,
  bank_name varchar(80),
  usd_per_idr numeric(16, 12) NOT NULL CHECK (usd_per_idr > 0),
  status varchar(16) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'paid', 'rejected')),
  admin_note varchar(1000),
  processed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (method = 'bank' AND bank_name IS NOT NULL AND length(trim(bank_name)) > 0)
    OR (method <> 'bank' AND bank_name IS NULL)
  )
);

CREATE INDEX withdrawal_requests_user_created_idx
  ON withdrawal_requests (user_id, created_at DESC);

CREATE INDEX withdrawal_requests_status_created_idx
  ON withdrawal_requests (status, created_at ASC);
