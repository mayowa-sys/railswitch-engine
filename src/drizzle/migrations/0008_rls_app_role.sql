-- Enforce row-level security for tenant-scoped requests.
--
-- The migration/connection role owns every table, and table owners (and
-- superusers) bypass RLS. Tenant requests therefore switch to this
-- unprivileged role (SET ROLE) on a dedicated connection, so the
-- merchant_isolation policies are actually evaluated. See src/db/client.ts.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'railswitch_app') THEN
    CREATE ROLE railswitch_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;--> statement-breakpoint
GRANT railswitch_app TO CURRENT_USER;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO railswitch_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO railswitch_app;--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO railswitch_app;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO railswitch_app;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO railswitch_app;
