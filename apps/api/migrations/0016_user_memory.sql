-- Offline memory. Append-only revisions except physical privacy erasure.
CREATE TABLE user_memory_consents (
 tenant text NOT NULL, owner text NOT NULL, revision integer NOT NULL CHECK (revision > 0),
 payload jsonb NOT NULL, PRIMARY KEY (tenant,owner)
);
CREATE TABLE user_memory_items (
 id uuid PRIMARY KEY, tenant text NOT NULL, owner text NOT NULL, agent text NOT NULL,
 revision integer NOT NULL CHECK (revision > 0), source_ref text, expires_at timestamptz NOT NULL,
 legal_hold boolean NOT NULL DEFAULT false, payload jsonb NOT NULL,
 CHECK (payload->>'classification' <> 'RESTRICTED')
);
CREATE INDEX user_memory_owner_scope ON user_memory_items(tenant,owner,agent);
CREATE INDEX user_memory_source_ref ON user_memory_items(source_ref);
CREATE INDEX user_memory_expiry ON user_memory_items(expires_at) WHERE NOT legal_hold;
CREATE TABLE user_memory_history (
 id uuid NOT NULL, revision integer NOT NULL, tenant text NOT NULL, owner text NOT NULL,
 payload jsonb NOT NULL, PRIMARY KEY(id,revision),
 FOREIGN KEY(id) REFERENCES user_memory_items(id) ON DELETE CASCADE
);
CREATE FUNCTION reject_user_memory_history_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'memory history is append-only'; END; $$;
CREATE TRIGGER user_memory_history_no_update BEFORE UPDATE ON user_memory_history
 FOR EACH ROW EXECUTE FUNCTION reject_user_memory_history_update();
CREATE TABLE user_memory_audit (seq bigserial PRIMARY KEY, id uuid UNIQUE NOT NULL, payload jsonb NOT NULL);
CREATE FUNCTION reject_user_memory_audit_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'memory audit is immutable'; END; $$;
CREATE TRIGGER user_memory_audit_no_rewrite BEFORE UPDATE OR DELETE ON user_memory_audit
 FOR EACH ROW EXECUTE FUNCTION reject_user_memory_audit_rewrite();
CREATE TABLE user_memory_tombstones (key text PRIMARY KEY, payload jsonb NOT NULL);
CREATE TABLE user_memory_revoked_sources (source_ref text PRIMARY KEY);
