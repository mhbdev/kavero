CREATE TABLE "catalog_upload" (
	"id" text PRIMARY KEY,
	"catalog_id" text NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"asset_id" text NOT NULL,
	"mime_type" text NOT NULL,
	"bytes" bigint NOT NULL,
	"hash" text NOT NULL,
	"storage_key" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_upload_bytes_check" CHECK ("bytes" BETWEEN 1 AND 26214400),
	CONSTRAINT "catalog_upload_hash_check" CHECK ("hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE INDEX "catalog_upload_workspace_expiry_idx" ON "catalog_upload" ("workspace_id", "expires_at");
--> statement-breakpoint
CREATE INDEX "catalog_upload_user_idx" ON "catalog_upload" ("user_id", "created_at");
--> statement-breakpoint
ALTER TABLE "catalog_upload" ADD CONSTRAINT "catalog_upload_catalog_id_catalog_id_fkey" FOREIGN KEY ("catalog_id") REFERENCES "catalog"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "catalog_upload" ADD CONSTRAINT "catalog_upload_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "catalog_upload" ADD CONSTRAINT "catalog_upload_workspace_id_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE;
