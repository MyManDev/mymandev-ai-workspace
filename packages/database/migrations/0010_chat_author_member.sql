ALTER TABLE "messages" ADD COLUMN "author_member_id" uuid;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_id_user_id_key" UNIQUE("id","user_id");