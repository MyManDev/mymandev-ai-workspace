CREATE TABLE "agent_run_transitions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"repository_id" uuid,
	"previous_state" text NOT NULL,
	"state" text NOT NULL,
	"reason" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"correlation_id" uuid,
	"causation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_run_transitions_device_event_key" UNIQUE("device_id","event_id"),
	CONSTRAINT "agent_run_transitions_previous_state_check" CHECK ("agent_run_transitions"."previous_state" in ('queued', 'running', 'awaiting_input', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "agent_run_transitions_state_check" CHECK ("agent_run_transitions"."state" in ('queued', 'running', 'awaiting_input', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "agent_run_transitions_transition_check" CHECK (("agent_run_transitions"."previous_state", "agent_run_transitions"."state") in (('queued', 'running'), ('queued', 'failed'), ('queued', 'cancelled'), ('running', 'awaiting_input'), ('running', 'completed'), ('running', 'failed'), ('running', 'cancelled'), ('awaiting_input', 'running'), ('awaiting_input', 'failed'), ('awaiting_input', 'cancelled'))),
	CONSTRAINT "agent_run_transitions_reason_length" CHECK (char_length("agent_run_transitions"."reason") between 1 and 500)
);
--> statement-breakpoint
ALTER TABLE "agent_run_transitions" ADD CONSTRAINT "agent_run_transitions_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_transitions" ADD CONSTRAINT "agent_run_transitions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_transitions" ADD CONSTRAINT "agent_run_transitions_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_transitions" ADD CONSTRAINT "agent_run_transitions_run_agent_fk" FOREIGN KEY ("run_id","agent_id") REFERENCES "public"."agent_runs"("id","agent_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_transitions" ADD CONSTRAINT "agent_run_transitions_agent_host_device_fk" FOREIGN KEY ("agent_id","device_id") REFERENCES "public"."agents"("id","host_device_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_transitions" ADD CONSTRAINT "agent_run_transitions_run_repository_fk" FOREIGN KEY ("run_id","repository_id") REFERENCES "public"."agent_runs"("id","repository_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_run_transitions_run_id_idx" ON "agent_run_transitions" USING btree ("run_id");