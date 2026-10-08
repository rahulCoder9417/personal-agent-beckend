CREATE TABLE "chat_epochs" (
	"user_id" text NOT NULL,
	"session_key" text NOT NULL,
	"epoch" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"start_key" text,
	CONSTRAINT "chat_epochs_user_id_session_key_pk" PRIMARY KEY("user_id","session_key")
);
