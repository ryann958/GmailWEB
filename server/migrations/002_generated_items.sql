CREATE TABLE generated_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  generated_text varchar(30) NOT NULL UNIQUE,
  status varchar(16) NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted', 'pending', 'accepted', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  admin_note varchar(1000)
);

CREATE INDEX generated_items_user_created_idx
  ON generated_items (user_id, created_at DESC);

CREATE INDEX generated_items_status_created_idx
  ON generated_items (status, created_at DESC);
