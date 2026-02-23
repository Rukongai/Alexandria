CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(255) NOT NULL,
	"display_name" varchar(255) NOT NULL,
	"password_hash" text NOT NULL,
	"role" varchar(20) DEFAULT 'admin' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"slug" varchar(255) NOT NULL,
	"description" text,
	"user_id" uuid NOT NULL,
	"source_type" varchar(20) NOT NULL,
	"status" varchar(20) DEFAULT 'processing' NOT NULL,
	"original_filename" varchar(500),
	"total_size_bytes" bigint DEFAULT 0 NOT NULL,
	"file_count" integer DEFAULT 0 NOT NULL,
	"file_hash" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "models_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "model_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_id" uuid NOT NULL,
	"filename" varchar(500) NOT NULL,
	"relative_path" text NOT NULL,
	"file_type" varchar(20) NOT NULL,
	"mime_type" varchar(100) NOT NULL,
	"size_bytes" bigint NOT NULL,
	"storage_path" text NOT NULL,
	"hash" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thumbnails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_file_id" uuid NOT NULL,
	"storage_path" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"format" varchar(20) DEFAULT 'webp' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "metadata_field_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"slug" varchar(255) NOT NULL,
	"type" varchar(20) NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_filterable" boolean DEFAULT false NOT NULL,
	"is_browsable" boolean DEFAULT false NOT NULL,
	"config" jsonb,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "metadata_field_definitions_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "model_metadata" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_id" uuid NOT NULL,
	"field_definition_id" uuid NOT NULL,
	"value" text NOT NULL,
	CONSTRAINT "model_metadata_model_field_unique" UNIQUE("model_id","field_definition_id")
);
--> statement-breakpoint
CREATE TABLE "model_tags" (
	"model_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	CONSTRAINT "model_tags_model_id_tag_id_pk" PRIMARY KEY("model_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"slug" varchar(255) NOT NULL,
	CONSTRAINT "tags_name_unique" UNIQUE("name"),
	CONSTRAINT "tags_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "collection_models" (
	"collection_id" uuid NOT NULL,
	"model_id" uuid NOT NULL,
	CONSTRAINT "collection_models_collection_id_model_id_pk" PRIMARY KEY("collection_id","model_id")
);
--> statement-breakpoint
CREATE TABLE "collections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"slug" varchar(255) NOT NULL,
	"description" text,
	"user_id" uuid NOT NULL,
	"parent_collection_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collections_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "models" ADD CONSTRAINT "models_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_files" ADD CONSTRAINT "model_files_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thumbnails" ADD CONSTRAINT "thumbnails_source_file_id_model_files_id_fk" FOREIGN KEY ("source_file_id") REFERENCES "public"."model_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_metadata" ADD CONSTRAINT "model_metadata_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_metadata" ADD CONSTRAINT "model_metadata_field_definition_id_metadata_field_definitions_id_fk" FOREIGN KEY ("field_definition_id") REFERENCES "public"."metadata_field_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_tags" ADD CONSTRAINT "model_tags_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_tags" ADD CONSTRAINT "model_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_models" ADD CONSTRAINT "collection_models_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_models" ADD CONSTRAINT "collection_models_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_parent_collection_id_collections_id_fk" FOREIGN KEY ("parent_collection_id") REFERENCES "public"."collections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "models_slug_idx" ON "models" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "models_user_id_idx" ON "models" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "models_status_idx" ON "models" USING btree ("status");--> statement-breakpoint
CREATE INDEX "models_created_at_idx" ON "models" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "model_files_model_id_idx" ON "model_files" USING btree ("model_id");--> statement-breakpoint
CREATE INDEX "model_files_file_type_idx" ON "model_files" USING btree ("file_type");--> statement-breakpoint
CREATE INDEX "model_files_model_id_file_type_idx" ON "model_files" USING btree ("model_id","file_type");--> statement-breakpoint
CREATE INDEX "thumbnails_source_file_id_idx" ON "thumbnails" USING btree ("source_file_id");--> statement-breakpoint
CREATE INDEX "metadata_field_definitions_slug_idx" ON "metadata_field_definitions" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "metadata_field_definitions_is_default_idx" ON "metadata_field_definitions" USING btree ("is_default");--> statement-breakpoint
CREATE INDEX "metadata_field_definitions_sort_order_idx" ON "metadata_field_definitions" USING btree ("sort_order");--> statement-breakpoint
CREATE INDEX "model_metadata_model_id_idx" ON "model_metadata" USING btree ("model_id");--> statement-breakpoint
CREATE INDEX "model_metadata_field_definition_id_idx" ON "model_metadata" USING btree ("field_definition_id");--> statement-breakpoint
CREATE INDEX "model_metadata_model_id_field_id_idx" ON "model_metadata" USING btree ("model_id","field_definition_id");--> statement-breakpoint
CREATE INDEX "model_tags_model_id_idx" ON "model_tags" USING btree ("model_id");--> statement-breakpoint
CREATE INDEX "model_tags_tag_id_idx" ON "model_tags" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "tags_slug_idx" ON "tags" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "tags_name_idx" ON "tags" USING btree ("name");--> statement-breakpoint
CREATE INDEX "collection_models_collection_id_idx" ON "collection_models" USING btree ("collection_id");--> statement-breakpoint
CREATE INDEX "collection_models_model_id_idx" ON "collection_models" USING btree ("model_id");--> statement-breakpoint
CREATE INDEX "collections_slug_idx" ON "collections" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "collections_user_id_idx" ON "collections" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "collections_parent_collection_id_idx" ON "collections" USING btree ("parent_collection_id");