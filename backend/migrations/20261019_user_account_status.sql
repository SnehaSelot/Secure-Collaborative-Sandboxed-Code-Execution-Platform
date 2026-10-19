-- Persist account state for directory visibility and access control.
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_status TEXT NOT NULL
    DEFAULT 'active' CHECK (account_status IN ('active', 'disabled'));