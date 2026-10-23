-- Hosted polling cost (#214): the agent_start lookup and the agent_end usage scan filter on type, so without this every poll read every event row of the session.
CREATE INDEX idx_events_type ON events (factory_id, adw_id, type, local_rowid);
