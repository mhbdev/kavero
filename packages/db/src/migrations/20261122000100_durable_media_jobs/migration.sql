CREATE TABLE "media_job" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"purpose" text NOT NULL,
	"prompt" text NOT NULL,
	"aspect_ratio" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"storage_key" text,
	"poster_storage_key" text,
	"gif_storage_key" text,
	"mime_type" text,
	"bytes" integer,
	"storage_bytes" integer DEFAULT 0 NOT NULL,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp,
	"lease_until" timestamp,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "media_job_purpose_check" CHECK ("purpose" IN ('image', 'video')),
	CONSTRAINT "media_job_status_check" CHECK ("status" IN ('queued', 'generating', 'done', 'error')),
	CONSTRAINT "media_job_provider_check" CHECK ("provider" IN ('anthropic', 'openrouter', 'openai', 'openai-compatible', 'google', 'ai-gateway')),
	CONSTRAINT "media_job_bytes_check" CHECK ("bytes" IS NULL OR "bytes" BETWEEN 0 AND 26214400),
	CONSTRAINT "media_job_storage_bytes_check" CHECK ("storage_bytes" BETWEEN 0 AND 78643200),
	CONSTRAINT "media_job_attempts_check" CHECK ("attempts" BETWEEN 0 AND 3)
);
--> statement-breakpoint
CREATE INDEX "media_job_user_created_idx" ON "media_job" ("user_id", "created_at");
--> statement-breakpoint
CREATE INDEX "media_job_workspace_status_idx" ON "media_job" ("workspace_id", "status");
--> statement-breakpoint
CREATE INDEX "media_job_expiry_idx" ON "media_job" ("expires_at");
--> statement-breakpoint
ALTER TABLE "media_job" ADD CONSTRAINT "media_job_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "media_job" ADD CONSTRAINT "media_job_workspace_id_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE;
