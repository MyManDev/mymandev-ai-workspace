CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"label" text NOT NULL,
	"platform" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "devices_id_user_id_key" UNIQUE("id","user_id"),
	CONSTRAINT "devices_label_length" CHECK (char_length("devices"."label") between 1 and 64),
	CONSTRAINT "devices_platform_check" CHECK ("devices"."platform" in ('windows', 'macos', 'linux'))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_display_name_length" CHECK (char_length("users"."display_name") between 1 and 64)
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "projects_name_length" CHECK (char_length("projects"."name") between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "repositories_id_project_id_key" UNIQUE("id","project_id"),
	CONSTRAINT "repositories_name_length" CHECK (char_length("repositories"."name") between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "workspace_members" (
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"added_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "workspace_members_pkey" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "workspaces_name_length" CHECK (char_length("workspaces"."name") between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"repository_id" uuid,
	"requested_by_user_id" uuid NOT NULL,
	"correlation_id" uuid,
	"state" text NOT NULL,
	"state_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "agent_runs_state_check" CHECK ("agent_runs"."state" in ('queued', 'running', 'awaiting_input', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "agent_runs_finished_at_check" CHECK (("agent_runs"."state" in ('completed', 'failed', 'cancelled')) = ("agent_runs"."finished_at" is not null)),
	CONSTRAINT "agent_runs_state_reason_length" CHECK (char_length("agent_runs"."state_reason") between 1 and 500)
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"host_device_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone,
	CONSTRAINT "agents_id_project_id_key" UNIQUE("id","project_id"),
	CONSTRAINT "agents_id_host_device_id_key" UNIQUE("id","host_device_id"),
	CONSTRAINT "agents_id_owner_user_id_key" UNIQUE("id","owner_user_id"),
	CONSTRAINT "agents_name_length" CHECK (char_length("agents"."name") between 1 and 64)
);
--> statement-breakpoint
CREATE TABLE "permission_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"grantee_agent_id" uuid NOT NULL,
	"capability" text NOT NULL,
	"repository_id" uuid,
	"granted_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" uuid,
	CONSTRAINT "permission_grants_capability_check" CHECK ("permission_grants"."capability" in ('repo.read', 'repo.write', 'terminal.execute', 'git.commit', 'git.push', 'provider.use')),
	CONSTRAINT "permission_grants_scope_check" CHECK (("permission_grants"."capability" = 'provider.use') = ("permission_grants"."repository_id" is null)),
	CONSTRAINT "permission_grants_revocation_check" CHECK (("permission_grants"."revoked_at" is null) = ("permission_grants"."revoked_by_user_id" is null)),
	CONSTRAINT "permission_grants_expiry_check" CHECK ("permission_grants"."expires_at" is null or "permission_grants"."expires_at" > "permission_grants"."created_at")
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text,
	"created_by_user_id" uuid NOT NULL,
	"last_seq" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_kind_check" CHECK ("conversations"."kind" in ('project')),
	CONSTRAINT "conversations_title_length" CHECK (char_length("conversations"."title") between 1 and 200),
	CONSTRAINT "conversations_last_seq_check" CHECK ("conversations"."last_seq" >= 0)
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"author_user_id" uuid,
	"author_agent_id" uuid,
	"sender_device_id" uuid NOT NULL,
	"client_event_id" uuid,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "messages_conversation_id_seq_key" UNIQUE("conversation_id","seq"),
	CONSTRAINT "messages_author_check" CHECK (num_nonnulls("messages"."author_user_id", "messages"."author_agent_id") = 1),
	CONSTRAINT "messages_seq_check" CHECK ("messages"."seq" >= 1),
	CONSTRAINT "messages_body_length" CHECK (char_length("messages"."body") between 1 and 16000)
);
--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_added_by_user_id_users_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_agent_project_fk" FOREIGN KEY ("agent_id","project_id") REFERENCES "public"."agents"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_repository_project_fk" FOREIGN KEY ("repository_id","project_id") REFERENCES "public"."repositories"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_host_device_id_devices_id_fk" FOREIGN KEY ("host_device_id") REFERENCES "public"."devices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_host_device_owner_fk" FOREIGN KEY ("host_device_id","owner_user_id") REFERENCES "public"."devices"("id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_grants" ADD CONSTRAINT "permission_grants_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_grants" ADD CONSTRAINT "permission_grants_grantee_agent_id_agents_id_fk" FOREIGN KEY ("grantee_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_grants" ADD CONSTRAINT "permission_grants_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_grants" ADD CONSTRAINT "permission_grants_granted_by_user_id_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_grants" ADD CONSTRAINT "permission_grants_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_grants" ADD CONSTRAINT "permission_grants_agent_project_fk" FOREIGN KEY ("grantee_agent_id","project_id") REFERENCES "public"."agents"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_grants" ADD CONSTRAINT "permission_grants_repository_project_fk" FOREIGN KEY ("repository_id","project_id") REFERENCES "public"."repositories"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_grants" ADD CONSTRAINT "permission_grants_agent_owner_fk" FOREIGN KEY ("grantee_agent_id","granted_by_user_id") REFERENCES "public"."agents"("id","owner_user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_device_id_devices_id_fk" FOREIGN KEY ("sender_device_id") REFERENCES "public"."devices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_device_user_fk" FOREIGN KEY ("sender_device_id","author_user_id") REFERENCES "public"."devices"("id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_agent_host_device_fk" FOREIGN KEY ("author_agent_id","sender_device_id") REFERENCES "public"."agents"("id","host_device_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "devices_user_id_idx" ON "devices" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "projects_workspace_id_idx" ON "projects" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "repositories_project_id_idx" ON "repositories" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "workspace_members_user_id_idx" ON "workspace_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "agent_runs_agent_id_created_at_idx" ON "agent_runs" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_runs_project_id_state_idx" ON "agent_runs" USING btree ("project_id","state");--> statement-breakpoint
CREATE INDEX "agents_project_id_idx" ON "agents" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "agents_host_device_id_idx" ON "agents" USING btree ("host_device_id");--> statement-breakpoint
CREATE INDEX "permission_grants_project_id_idx" ON "permission_grants" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "permission_grants_active_repository_key" ON "permission_grants" USING btree ("grantee_agent_id","capability","repository_id") WHERE "permission_grants"."revoked_at" is null and "permission_grants"."repository_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "permission_grants_active_unscoped_key" ON "permission_grants" USING btree ("grantee_agent_id","capability") WHERE "permission_grants"."revoked_at" is null and "permission_grants"."repository_id" is null;--> statement-breakpoint
CREATE INDEX "conversations_project_id_idx" ON "conversations" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_sender_device_client_event_key" ON "messages" USING btree ("sender_device_id","client_event_id") WHERE "messages"."client_event_id" is not null;