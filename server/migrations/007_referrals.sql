ALTER TABLE users
  ADD COLUMN referral_code varchar(12),
  ADD COLUMN referred_by uuid REFERENCES users(id) ON DELETE SET NULL;

UPDATE users
SET referral_code = upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))
WHERE referral_code IS NULL;

ALTER TABLE users
  ALTER COLUMN referral_code SET NOT NULL,
  ADD CONSTRAINT users_referral_code_format
    CHECK (referral_code ~ '^[A-F0-9]{12}$'),
  ADD CONSTRAINT users_cannot_refer_themselves
    CHECK (referred_by IS NULL OR referred_by <> id);

CREATE UNIQUE INDEX users_referral_code_key ON users (referral_code);
CREATE INDEX users_referred_by_verified_idx
  ON users (referred_by, email_verified_at)
  WHERE referred_by IS NOT NULL;

CREATE TABLE referral_rewards (
  referrer_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  amount_idr bigint NOT NULL CHECK (amount_idr = 20000),
  verified_referrals_at_award integer NOT NULL CHECK (verified_referrals_at_award >= 20),
  awarded_at timestamptz NOT NULL DEFAULT now()
);
