ALTER TABLE "provider_connections" ADD COLUMN "kind" text NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD COLUMN "label" text NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_kind_check" CHECK ("provider_connections"."kind" in ('claude', 'codex'));--> statement-breakpoint
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_label_length" CHECK (char_length("provider_connections"."label") between 1 and 64);