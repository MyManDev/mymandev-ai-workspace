CREATE TABLE "user_identities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"identity_provider" text NOT NULL,
	"subject" text,
	"login" text,
	"account_created_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_sign_in_at" timestamp with time zone NOT NULL,
	"erased_at" timestamp with time zone,
	CONSTRAINT "user_identities_user_id_identity_provider_key" UNIQUE("user_id","identity_provider"),
	CONSTRAINT "user_identities_identity_provider_check" CHECK ("user_identities"."identity_provider" in ('github')),
	CONSTRAINT "user_identities_erasure_check" CHECK (("user_identities"."erased_at" is null) = ("user_identities"."subject" is not null) and ("user_identities"."erased_at" is null) = ("user_identities"."login" is not null) and ("user_identities"."erased_at" is null) = ("user_identities"."account_created_at" is not null)),
	CONSTRAINT "user_identities_github_subject_check" CHECK ("user_identities"."identity_provider" <> 'github' or "user_identities"."subject" ~ '^[1-9][0-9]{0,18}$'),
	CONSTRAINT "user_identities_github_login_check" CHECK ("user_identities"."identity_provider" <> 'github' or "user_identities"."login" ~ '^[A-Za-z0-9_-]{1,39}$')
);
--> statement-breakpoint
CREATE TABLE "workspace_invitations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by_user_id" uuid,
	"accepted_device_id" uuid,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" uuid,
	CONSTRAINT "workspace_invitations_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "workspace_invitations_token_hash_check" CHECK ("workspace_invitations"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "workspace_invitations_expiry_check" CHECK ("workspace_invitations"."expires_at" >= "workspace_invitations"."created_at" + interval '1 hour' and "workspace_invitations"."expires_at" <= "workspace_invitations"."created_at" + interval '168 hours'),
	CONSTRAINT "workspace_invitations_acceptance_check" CHECK (num_nonnulls("workspace_invitations"."accepted_at", "workspace_invitations"."accepted_by_user_id", "workspace_invitations"."accepted_device_id") in (0, 3)),
	CONSTRAINT "workspace_invitations_revocation_check" CHECK (("workspace_invitations"."revoked_at" is null) = ("workspace_invitations"."revoked_by_user_id" is null)),
	CONSTRAINT "workspace_invitations_accepted_or_revoked_check" CHECK ("workspace_invitations"."accepted_at" is null or "workspace_invitations"."revoked_at" is null)
);
--> statement-breakpoint
CREATE TABLE "workspace_join_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"requester_user_id" uuid NOT NULL,
	"requester_device_id" uuid NOT NULL,
	"requested_display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decision" text,
	"decided_at" timestamp with time zone,
	"decided_by_user_id" uuid,
	"member_id" uuid,
	"unblocked_at" timestamp with time zone,
	"unblocked_by_user_id" uuid,
	CONSTRAINT "workspace_join_requests_requested_display_name_length" CHECK (char_length("workspace_join_requests"."requested_display_name") between 1 and 64),
	CONSTRAINT "workspace_join_requests_decision_check" CHECK ("workspace_join_requests"."decision" in ('approved', 'denied', 'blocked', 'withdrawn', 'expired')),
	CONSTRAINT "workspace_join_requests_decided_check" CHECK (("workspace_join_requests"."decision" is null) = ("workspace_join_requests"."decided_at" is null)),
	CONSTRAINT "workspace_join_requests_decided_by_check" CHECK (("workspace_join_requests"."decided_by_user_id" is not null) = ("workspace_join_requests"."decision" is not null and "workspace_join_requests"."decision" <> 'expired')),
	CONSTRAINT "workspace_join_requests_member_check" CHECK (("workspace_join_requests"."member_id" is not null) = ("workspace_join_requests"."decision" is not distinct from 'approved')),
	CONSTRAINT "workspace_join_requests_unblocked_check" CHECK (("workspace_join_requests"."unblocked_at" is null) = ("workspace_join_requests"."unblocked_by_user_id" is null) and ("workspace_join_requests"."unblocked_at" is null or "workspace_join_requests"."decision" is not distinct from 'blocked'))
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"action" text NOT NULL,
	"actor_user_id" uuid,
	"actor_device_id" uuid,
	"workspace_id" uuid,
	"subject_id" uuid,
	"reason" text,
	"github_delivery_id" text,
	CONSTRAINT "audit_events_action_check" CHECK ("audit_events"."action" in ('account.signed_in', 'device.registered', 'device.key_replaced', 'device.signed_out', 'device.revoked', 'account.registration_locked', 'account.registration_lock_lifted', 'connection.replaced', 'github.authorization_revoked', 'event.identity_mismatch', 'account.disabled', 'account.enabled', 'account.erased', 'workspace.created', 'member.defined', 'member.renamed', 'member.claimed', 'member.removed', 'member.left', 'member.promoted', 'member.demoted', 'ownership.offered', 'ownership.offer_withdrawn', 'ownership.transferred', 'invitation.created', 'invitation.accepted', 'invitation.revoked', 'join_request.created', 'join_request.approved', 'join_request.denied', 'join_request.blocked', 'join_request.unblocked', 'join_request.withdrawn', 'join_requests.paused', 'join_requests.resumed')),
	CONSTRAINT "audit_events_reason_check" CHECK ("audit_events"."reason" in ('removed', 'lost', 'replaced', 'account_erased', 'creator_demoted', 'member_removed')),
	CONSTRAINT "audit_events_actor_device_check" CHECK ("audit_events"."actor_device_id" is null or "audit_events"."actor_user_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "workspace_members" DROP CONSTRAINT "workspace_members_pkey";--> statement-breakpoint
ALTER TABLE "workspace_members" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "public_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "key_algorithm" text NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "last_sign_in_at" timestamp with time zone NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "signed_out_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "revocation_reason" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "disabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "sign_in_required_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "device_registration_locked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD COLUMN "id" uuid PRIMARY KEY NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD COLUMN "display_name" text NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD COLUMN "role" text NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD COLUMN "ownership_offered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD COLUMN "removed_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "join_requests_paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_accepted_by_user_id_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_accepted_device_user_fk" FOREIGN KEY ("accepted_device_id","accepted_by_user_id") REFERENCES "public"."devices"("id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_join_requests" ADD CONSTRAINT "workspace_join_requests_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_join_requests" ADD CONSTRAINT "workspace_join_requests_requester_user_id_users_id_fk" FOREIGN KEY ("requester_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_join_requests" ADD CONSTRAINT "workspace_join_requests_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_join_requests" ADD CONSTRAINT "workspace_join_requests_unblocked_by_user_id_users_id_fk" FOREIGN KEY ("unblocked_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_join_requests" ADD CONSTRAINT "workspace_join_requests_requester_device_fk" FOREIGN KEY ("requester_device_id","requester_user_id") REFERENCES "public"."devices"("id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_device_user_fk" FOREIGN KEY ("actor_device_id","actor_user_id") REFERENCES "public"."devices"("id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_identities_identity_provider_subject_key" ON "user_identities" USING btree ("identity_provider","subject") WHERE "user_identities"."subject" is not null;--> statement-breakpoint
CREATE INDEX "workspace_invitations_workspace_id_idx" ON "workspace_invitations" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_invitations_live_member_key" ON "workspace_invitations" USING btree ("member_id") WHERE "workspace_invitations"."accepted_at" is null and "workspace_invitations"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "workspace_join_requests_workspace_id_idx" ON "workspace_join_requests" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_join_requests_pending_key" ON "workspace_join_requests" USING btree ("workspace_id","requester_user_id") WHERE "workspace_join_requests"."decision" is null;--> statement-breakpoint
CREATE INDEX "audit_events_workspace_id_idx" ON "audit_events" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_events_github_delivery_id_key" ON "audit_events" USING btree ("github_delivery_id") WHERE "audit_events"."github_delivery_id" is not null;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_removed_by_user_id_users_id_fk" FOREIGN KEY ("removed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_members_workspace_id_idx" ON "workspace_members" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_members_active_user_key" ON "workspace_members" USING btree ("workspace_id","user_id") WHERE "workspace_members"."user_id" is not null and "workspace_members"."removed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_members_active_owner_key" ON "workspace_members" USING btree ("workspace_id") WHERE "workspace_members"."role" = 'owner' and "workspace_members"."removed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_members_ownership_offer_key" ON "workspace_members" USING btree ("workspace_id") WHERE "workspace_members"."ownership_offered_at" is not null;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_public_key_key" UNIQUE("public_key");--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_id_workspace_id_key" UNIQUE("id","workspace_id");--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_key_algorithm_check" CHECK ("devices"."key_algorithm" in ('ed25519'));--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_public_key_check" CHECK ("devices"."key_algorithm" <> 'ed25519' or "devices"."public_key" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_revocation_reason_check" CHECK ("devices"."revocation_reason" in ('removed', 'lost', 'replaced', 'account_erased'));--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_revocation_check" CHECK (("devices"."revoked_at" is null) = ("devices"."revocation_reason" is null));--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_display_name_length" CHECK (char_length("workspace_members"."display_name") between 1 and 64);--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_role_check" CHECK ("workspace_members"."role" in ('owner', 'admin', 'member'));--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_claim_check" CHECK (("workspace_members"."user_id" is null) = ("workspace_members"."claimed_at" is null));--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_unclaimed_role_check" CHECK ("workspace_members"."user_id" is not null or "workspace_members"."role" = 'member');--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_removal_check" CHECK (("workspace_members"."removed_at" is null) = ("workspace_members"."removed_by_user_id" is null));--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_ownership_offer_check" CHECK ("workspace_members"."ownership_offered_at" is null or ("workspace_members"."user_id" is not null and "workspace_members"."removed_at" is null and "workspace_members"."role" <> 'owner'));