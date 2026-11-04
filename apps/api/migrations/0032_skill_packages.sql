CREATE TABLE IF NOT EXISTS tw_skill_packages (
  package_id text NOT NULL,
  version text NOT NULL,
  digest text NOT NULL,
  manifest jsonb NOT NULL,
  report jsonb NOT NULL,
  provenance jsonb NOT NULL,
  state text NOT NULL DEFAULT 'loaded' CHECK (state IN ('loaded', 'activated', 'deactivated')),
  activated_by text,
  activated_at timestamptz,
  PRIMARY KEY (package_id, version)
);
CREATE TABLE IF NOT EXISTS tw_skill_package_skills (
  package_id text NOT NULL,
  version text NOT NULL,
  name text NOT NULL,
  description text NOT NULL,
  instructions text NOT NULL,
  frontmatter jsonb NOT NULL,
  digest text NOT NULL,
  allowed_tools jsonb NOT NULL,
  PRIMARY KEY (package_id, version, name),
  FOREIGN KEY (package_id, version) REFERENCES tw_skill_packages (package_id, version)
);
CREATE OR REPLACE FUNCTION tw_skill_package_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'skill package records are immutable'; END IF;
  IF TG_TABLE_NAME = 'tw_skill_package_skills' OR
    (NEW.package_id, NEW.version, NEW.digest, NEW.manifest, NEW.report, NEW.provenance)
      IS DISTINCT FROM (OLD.package_id, OLD.version, OLD.digest, OLD.manifest, OLD.report, OLD.provenance) THEN
    RAISE EXCEPTION 'skill package records are immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tw_skill_packages_immutable ON tw_skill_packages;
CREATE TRIGGER tw_skill_packages_immutable BEFORE UPDATE OR DELETE ON tw_skill_packages FOR EACH ROW EXECUTE FUNCTION tw_skill_package_immutable();
DROP TRIGGER IF EXISTS tw_skill_package_skills_immutable ON tw_skill_package_skills;
CREATE TRIGGER tw_skill_package_skills_immutable BEFORE UPDATE OR DELETE ON tw_skill_package_skills FOR EACH ROW EXECUTE FUNCTION tw_skill_package_immutable();
