ALTER TABLE users
  ADD COLUMN role varchar(16) NOT NULL DEFAULT 'user'
  CHECK (role IN ('user', 'admin'));

ALTER TABLE generated_items
  DROP CONSTRAINT generated_items_status_check;

ALTER TABLE generated_items
  ADD CONSTRAINT generated_items_status_check
  CHECK (status IN ('submitted', 'pending', 'checking', 'accepted', 'rejected'));

CREATE TABLE generated_item_reviews (
  id bigserial PRIMARY KEY,
  generated_item_id uuid NOT NULL REFERENCES generated_items(id) ON DELETE CASCADE,
  reviewed_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  previous_status varchar(16) NOT NULL,
  new_status varchar(16) NOT NULL
    CHECK (new_status IN ('submitted', 'pending', 'checking', 'accepted', 'rejected')),
  admin_note varchar(1000),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX generated_item_reviews_item_created_idx
  ON generated_item_reviews (generated_item_id, created_at DESC);
