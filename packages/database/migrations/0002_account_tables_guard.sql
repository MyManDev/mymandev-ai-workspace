-- Guard of the account tables migrations that follow, 0003 and 0004 (ADR 0014,
-- #86). The new required columns of devices and the new primary key of
-- workspace_members have no honest default, so the change runs only on a
-- database without accounts. The migrator applies all pending migrations in one
-- transaction, so this guard also stops the migrations after it. How to reset a
-- local database: packages/database/README.md, "Reset a local database".
DO $$
BEGIN
	IF EXISTS (SELECT FROM users) OR EXISTS (SELECT FROM devices) OR EXISTS (SELECT FROM workspace_members) THEN
		RAISE EXCEPTION 'The account tables migrations (0003, 0004) need a database without users, devices, or workspace members. Reset the local database as described in packages/database/README.md under "Reset a local database".';
	END IF;
END $$;
