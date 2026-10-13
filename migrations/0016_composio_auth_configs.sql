-- Composio setups (auth configs) the server made itself, one per app (docs/backend-report.md, "Apps through Composio").
CREATE TABLE "composio_auth_configs" (
	"app" text PRIMARY KEY NOT NULL,
	"auth_config_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
