-- Allow standalone and anonymous executions to contribute aggregate metrics.
-- Execution source and output remain unpersisted.
ALTER TABLE executions ALTER COLUMN session_id DROP NOT NULL;
ALTER TABLE executions ALTER COLUMN triggered_by DROP NOT NULL;
ALTER TABLE executions ALTER COLUMN language_id DROP NOT NULL;
