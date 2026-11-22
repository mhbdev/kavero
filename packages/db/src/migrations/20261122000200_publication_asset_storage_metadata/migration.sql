ALTER TABLE "publication_asset" ADD COLUMN "hash" text;
--> statement-breakpoint
ALTER TABLE "publication_asset" ADD COLUMN "bytes" bigint;
--> statement-breakpoint
UPDATE "publication_asset" AS pa
SET "hash" = COALESCE(
	(SELECT ca."hash" FROM "catalog_asset" AS ca WHERE ca."storage_key" = pa."storage_key" LIMIT 1),
	(SELECT asset.value->>'hash'
	 FROM "publication" AS pub, LATERAL jsonb_array_elements(pub."document"->'assets') AS asset(value)
	 WHERE pub."id" = pa."publication_id" AND asset.value->>'id' = pa."asset_id" LIMIT 1),
	pa."storage_key"
),
"bytes" = COALESCE(
	(SELECT ca."bytes" FROM "catalog_asset" AS ca WHERE ca."storage_key" = pa."storage_key" LIMIT 1),
	(SELECT NULLIF(asset.value->>'bytes', '')::bigint
	 FROM "publication" AS pub, LATERAL jsonb_array_elements(pub."document"->'assets') AS asset(value)
	 WHERE pub."id" = pa."publication_id" AND asset.value->>'id' = pa."asset_id" LIMIT 1),
	0
);
--> statement-breakpoint
ALTER TABLE "publication_asset" ALTER COLUMN "hash" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "publication_asset" ALTER COLUMN "bytes" SET DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "publication_asset" ALTER COLUMN "bytes" SET NOT NULL;
