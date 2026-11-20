-- A permission grant never changes after its insert, except that a revocation
-- sets revoked_at and revoked_by_user_id once, together (ADR 0015, P-77; #75,
-- recommendation 6, Project Manager decision of 2026-11-19). The trigger holds
-- this for every role, the application role included, whose privileges are set
-- outside the migrations. Each refusal has SQLSTATE 23000 and names its rule as
-- the constraint:
-- permission_grants_immutable_columns: a column other than the two changes;
-- permission_grants_revocation_final: a revoked grant's revocation changes;
-- permission_grants_revocation_pair: one of the two is set without the other.
-- A new column is covered by the first rule without a change here.
CREATE FUNCTION "public"."permission_grants_immutable"() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
	IF (to_jsonb(NEW) - 'revoked_at' - 'revoked_by_user_id') IS DISTINCT FROM (to_jsonb(OLD) - 'revoked_at' - 'revoked_by_user_id') THEN
		RAISE EXCEPTION 'A permission grant changes only by its revocation.'
			USING ERRCODE = '23000', CONSTRAINT = 'permission_grants_immutable_columns';
	END IF;
	IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.revoked_by_user_id IS DISTINCT FROM OLD.revoked_by_user_id) THEN
		RAISE EXCEPTION 'A revoked permission grant stays revoked as it is.'
			USING ERRCODE = '23000', CONSTRAINT = 'permission_grants_revocation_final';
	END IF;
	IF (NEW.revoked_at IS NULL) <> (NEW.revoked_by_user_id IS NULL) THEN
		RAISE EXCEPTION 'A revocation sets revoked_at and revoked_by_user_id together.'
			USING ERRCODE = '23000', CONSTRAINT = 'permission_grants_revocation_pair';
	END IF;
	RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "permission_grants_immutable" BEFORE UPDATE ON "public"."permission_grants" FOR EACH ROW EXECUTE FUNCTION "public"."permission_grants_immutable"();
