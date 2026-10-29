CREATE TABLE "provider_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"host_device_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "provider_connections_id_host_device_id_key" UNIQUE("id","host_device_id")
);
--> statement-breakpoint
ALTER TABLE "permission_grants" DROP CONSTRAINT "permission_grants_scope_check";--> statement-breakpoint
DROP INDEX "permission_grants_active_unscoped_key";--> statement-breakpoint
ALTER TABLE "permission_grants" ADD COLUMN "host_device_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "permission_grants" ADD COLUMN "provider_connection_id" uuid;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_host_device_id_devices_id_fk" FOREIGN KEY ("host_device_id") REFERENCES "public"."devices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_connections_host_device_id_idx" ON "provider_connections" USING btree ("host_device_id");--> statement-breakpoint
ALTER TABLE "permission_grants" ADD CONSTRAINT "permission_grants_provider_connection_id_provider_connections_id_fk" FOREIGN KEY ("provider_connection_id") REFERENCES "public"."provider_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_grants" ADD CONSTRAINT "permission_grants_agent_host_device_fk" FOREIGN KEY ("grantee_agent_id","host_device_id") REFERENCES "public"."agents"("id","host_device_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_grants" ADD CONSTRAINT "permission_grants_provider_connection_device_fk" FOREIGN KEY ("provider_connection_id","host_device_id") REFERENCES "public"."provider_connections"("id","host_device_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "permission_grants_active_provider_connection_key" ON "permission_grants" USING btree ("grantee_agent_id","capability","provider_connection_id") WHERE "permission_grants"."revoked_at" is null and "permission_grants"."provider_connection_id" is not null;--> statement-breakpoint
ALTER TABLE "permission_grants" ADD CONSTRAINT "permission_grants_scope_check" CHECK (num_nonnulls("permission_grants"."repository_id", "permission_grants"."provider_connection_id") = 1 and ("permission_grants"."capability" = 'provider.use') = ("permission_grants"."provider_connection_id" is not null));