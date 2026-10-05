-- Add normalized pay columns (see src/pay.ts).
-- Idempotent: safe on both existing databases and fresh ones.
ALTER TABLE "job_postings" ADD COLUMN IF NOT EXISTS "pay_min" real;--> statement-breakpoint
ALTER TABLE "job_postings" ADD COLUMN IF NOT EXISTS "pay_max" real;--> statement-breakpoint
ALTER TABLE "job_postings" ADD COLUMN IF NOT EXISTS "pay_currency" text;--> statement-breakpoint
ALTER TABLE "job_postings" ADD COLUMN IF NOT EXISTS "pay_period" text;--> statement-breakpoint
ALTER TABLE "job_postings" ADD COLUMN IF NOT EXISTS "pay_unit_label" text;--> statement-breakpoint
ALTER TABLE "job_postings" ADD COLUMN IF NOT EXISTS "pay_usd_hour" real;--> statement-breakpoint
ALTER TABLE "job_postings" ADD COLUMN IF NOT EXISTS "pay_usd_month" real;--> statement-breakpoint
ALTER TABLE "job_postings" ADD COLUMN IF NOT EXISTS "pay_confidence" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_job_postings_pay_usd_month" ON "job_postings" USING btree ("pay_usd_month");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_job_postings_is_processed" ON "job_postings" USING btree ("is_processed");
