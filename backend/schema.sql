-- Secure Collaborative Sandboxed Code Execution Platform
-- PostgreSQL schema (draft v2) -- columns reconstructed from the table list + agreed fixes.
-- Diff against your own draft; keep your column names where they differ.

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()

-- ---------- Lookups ----------
CREATE TABLE languages (
    id            SMALLSERIAL PRIMARY KEY,
    name          TEXT NOT NULL UNIQUE,          -- 'python', 'go', ...
    pids_limit    INT  NOT NULL,
    fsize_limit_mb INT NOT NULL,
    timeout_seconds INT NOT NULL
);

CREATE TABLE system_settings (
    key         TEXT PRIMARY KEY,                -- e.g. 'risk_threshold_default'
    value       JSONB NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Identity / RBAC ----------
CREATE TABLE users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email         TEXT NOT NULL UNIQUE,
    display_name  TEXT NOT NULL,
    password_hash TEXT,                          -- null if Cognito-only
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE roles (
    id          SMALLSERIAL PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,            -- 'admin', 'reviewer', 'member'
    description TEXT
);

CREATE TABLE user_roles (
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id     SMALLINT NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
    granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    granted_by  UUID REFERENCES users(id),
    PRIMARY KEY (user_id, role_id)
);

-- ---------- Sessions ----------
CREATE TABLE sessions (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id       UUID NOT NULL REFERENCES users(id),
    name           TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'hibernated', 'closed')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_active_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    hibernated_at  TIMESTAMPTZ,
    closed_at      TIMESTAMPTZ
);
CREATE INDEX idx_sessions_status_active ON sessions (status, last_active_at);

-- Surrogate id => keeps rejoin history (one row per join). Swap to a composite
-- PK (session_id, user_id) with left_at dropped if you don't want history.
CREATE TABLE session_participants (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id  UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES users(id),
    joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    left_at     TIMESTAMPTZ
);
-- at most one open participation per user per session
CREATE UNIQUE INDEX uq_participant_open
    ON session_participants (session_id, user_id) WHERE left_at IS NULL;

-- ---------- Files ----------
CREATE TABLE files (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id  UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    path        TEXT NOT NULL,
    language_id SMALLINT REFERENCES languages(id),
    content     TEXT,                            -- last materialized snapshot
    yjs_state   BYTEA,                           -- authoritative CRDT state (debounced flush)
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (session_id, path)
);

-- ---------- Executions ----------
CREATE TABLE executions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id      UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    file_id         UUID REFERENCES files(id) ON DELETE SET NULL,
    triggered_by    UUID NOT NULL REFERENCES users(id),
    language_id     SMALLINT NOT NULL REFERENCES languages(id),
    container_id    TEXT,                        -- only place container_id lives
    status          TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','running','completed','failed','timeout','blocked')),
    exit_code       INT,
    -- Intentional snapshot of limits applied at run time (not derived from languages;
    -- languages limits can change later and history must stay accurate).
    pids_limit      INT,
    fsize_limit_mb  INT,
    timeout_seconds INT,
    started_at      TIMESTAMPTZ,
    finished_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_exec_session ON executions (session_id, created_at DESC);

-- ---------- Risk ----------
CREATE TABLE risk_rules (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),   -- FK target is id
    code        TEXT NOT NULL UNIQUE,                         -- human-readable key
    description TEXT NOT NULL,
    pattern     JSONB,
    severity    SMALLINT NOT NULL CHECK (severity BETWEEN 1 AND 5),
    enabled     BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE risk_assessments (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    execution_id      UUID NOT NULL UNIQUE REFERENCES executions(id) ON DELETE CASCADE,
    score             NUMERIC(5,2) NOT NULL,
    threshold_applied NUMERIC(5,2) NOT NULL,
    decision          TEXT NOT NULL CHECK (decision IN ('allow','flag','block')),
    review_status     TEXT NOT NULL DEFAULT 'none'
                      CHECK (review_status IN ('none','pending','approved','rejected')),
    reviewed_by       UUID REFERENCES users(id),
    reviewed_at       TIMESTAMPTZ,
    review_note       TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE risk_findings (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    assessment_id  UUID NOT NULL REFERENCES risk_assessments(id) ON DELETE CASCADE,
    rule_id        UUID REFERENCES risk_rules(id),   -- NULL => ML-originated finding
    source         TEXT NOT NULL CHECK (source IN ('rule','ast','ml','llm')),
    line_start     INT,
    line_end       INT,
    confidence     NUMERIC(4,3),
    detail         JSONB
);

-- ---------- Audit ----------
CREATE TABLE audit_logs (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor_id    UUID REFERENCES users(id),
    session_id  UUID REFERENCES sessions(id) ON DELETE SET NULL,
    action      TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id   UUID NOT NULL,                   -- one consistent type for every entity
    metadata    JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_session ON audit_logs (session_id, created_at);
CREATE INDEX idx_audit_entity  ON audit_logs (entity_type, entity_id);

-- Append-only: run as the table owner, then connect the app as a different role.
-- CREATE ROLE app_user LOGIN PASSWORD '...';
-- GRANT SELECT, INSERT ON audit_logs TO app_user;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM PUBLIC;
