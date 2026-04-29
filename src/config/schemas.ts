import { z } from "zod";
import { ProviderSchema } from "./providers.ts";

export const PeerConfigSchema = z.object({
	url: z.string().url(),
	token: z.string().min(1),
	description: z.string().optional(),
	enabled: z.boolean().default(true),
});

// Operator-tunable permissions. Moved out of ~/.claude/settings.json in v0.20
// PR 6 so the dashboard Settings page is the single authoritative surface for
// tool access control. The runtime applies these at query time via the Agent
// SDK subprocess; nothing else reads them. Keep the enum trimmed to the three
// modes that actually match a real operator intent (default / acceptEdits /
// bypassPermissions). SDK-level modes like `plan` and `dontAsk` stayed off the
// dashboard because nobody has ever asked for them.
export const PermissionsConfigSchema = z
	.object({
		default_mode: z.enum(["default", "acceptEdits", "bypassPermissions"]).default("bypassPermissions"),
		allow: z.array(z.string().min(1)).default([]),
		deny: z.array(z.string().min(1)).default([]),
	})
	.default({});

// Operator-tunable evolution cadence. `reflection_enabled` mirrors the enum at
// `config/evolution.yaml:reflection.enabled`; the two other knobs mirror the
// runtime overlay at `phantom-config/meta/evolution.json`. The phantom-config
// endpoint is responsible for writing the cadence overlay AND updating the
// running EvolutionCadence instance via setCadenceConfig() so changes are
// live without a restart.
export const EvolutionUiConfigSchema = z
	.object({
		reflection_enabled: z.enum(["auto", "always", "never"]).default("auto"),
		cadence_minutes: z.number().int().min(1).max(10080).default(180),
		demand_trigger_depth: z.number().int().min(1).max(1000).default(5),
	})
	.default({});

export const PhantomConfigSchema = z.object({
	// name feeds the email from-address local-part, subject line, HTML body,
	// PWA manifest, browser title, and Slack display name. Restrict to a
	// conservative charset that is safe in every surface: ASCII alphanumerics
	// plus spaces, underscores, dots, and hyphens. Leading character must be
	// alphanumeric so the email local-part sanitizer has something to keep.
	// Prevents CRLF injection in email headers and HTML injection in the body.
	name: z
		.string()
		.min(1)
		.max(64)
		.regex(/^[A-Za-z0-9][A-Za-z0-9 _.-]*$/, {
			message:
				"name must start with a letter or digit and contain only letters, digits, spaces, underscores, dots, and hyphens",
		}),
	domain: z.string().optional(),
	public_url: z.string().url().optional(),
	port: z.number().int().min(1).max(65535).default(3100),
	role: z.string().min(1).default("swe"),
	model: z.string().min(1).default("claude-opus-4-7"),
	// Optional override for the model used by evolution judges. Defaults to `model` when omitted
	// so a single-model deployment "just works". Lets operators run a cheaper model for judging
	// while keeping a more capable model for the primary agent.
	judge_model: z.string().min(1).optional(),
	// Provider selection. Defaults to { type: "anthropic" }, which is identical in behavior to
	// omitting the block entirely and matches every deployment that existed before Phase 2.
	// The effective env vars are computed by buildProviderEnv() in config/providers.ts and
	// merged into the Agent SDK subprocess environment at query() time.
	provider: ProviderSchema,
	effort: z.enum(["low", "medium", "high", "max"]).default("max"),
	max_budget_usd: z.number().min(0).default(0),
	timeout_minutes: z.number().min(1).default(240),
	peers: z.record(z.string(), PeerConfigSchema).optional(),
	// Added in v0.20 PR 6. Both are optional on disk so existing phantom.yaml
	// files without these blocks keep loading; defaults fill in at parse time.
	permissions: PermissionsConfigSchema,
	evolution: EvolutionUiConfigSchema,
});

export const SlackChannelConfigSchema = z.object({
	enabled: z.boolean().default(false),
	bot_token: z.string().min(1),
	app_token: z.string().min(1),
	default_channel_id: z.string().optional(),
	default_user_id: z.string().optional(),
	owner_user_id: z.string().optional(),
});

export const TelegramChannelConfigSchema = z.object({
	enabled: z.boolean().default(false),
	bot_token: z.string().min(1),
	// P2.4: opt-in for reaction-as-feedback in groups. The bot must be a
	// chat administrator for Telegram to deliver message_reaction updates.
	// Has no effect in 1:1 DMs (no admin role exists). Defaults to false
	// since Phantom Telegram's primary use case is 1:1.
	enable_message_reactions: z.boolean().default(false),
	// P3: Telegram numeric user IDs authorized to interact with the bot.
	// Empty array (default) means no access control — backwards compatible.
	// Find your ID by sending any message to @userinfobot on Telegram.
	// Use the numeric ID, not your @username.
	// P5.5: Validate format to prevent obviously-invalid values (negative, empty, non-numeric).
	owner_user_ids: z.array(
		z.string().regex(/^\d+$/, "Telegram user IDs must be numeric strings (e.g., '123456789')")
	).default([]),
	// P5.5: Optional custom rejection message for non-owners in DMs.
	// Defaults to Phantom's standard message. Useful for forks and private deployments.
	rejection_reply: z.string().optional(),
});

export const EmailChannelConfigSchema = z.object({
	enabled: z.boolean().default(false),
	imap: z.object({
		host: z.string().min(1),
		port: z.number().int().min(1).default(993),
		user: z.string().min(1),
		pass: z.string().min(1),
		tls: z.boolean().default(true),
	}),
	smtp: z.object({
		host: z.string().min(1),
		port: z.number().int().min(1).default(587),
		user: z.string().min(1),
		pass: z.string().min(1),
		tls: z.boolean().default(false),
	}),
	from_address: z.string().email(),
	from_name: z.string().min(1).default("Phantom"),
});

export const WebhookChannelConfigSchema = z.object({
	enabled: z.boolean().default(false),
	secret: z.string().min(16),
	sync_timeout_ms: z.number().int().min(1000).default(25000),
});

export const NextcloudChannelConfigSchema = z
	.object({
		enabled: z.boolean().default(false),
		shared_secret: z.string().min(16),
		talk_server: z.string().min(1),
		room_token: z.string().min(1),
		webhook_path: z.string().default("/nextcloud/webhook"),
		port: z.number().int().min(1).max(65535).default(3200),
		bot_id: z.string().optional(),
		session_window_minutes: z.number().int().min(1).default(30),
	})
	.strict();

export const ChannelsConfigSchema = z.object({
	slack: SlackChannelConfigSchema.optional(),
	telegram: TelegramChannelConfigSchema.optional(),
	email: EmailChannelConfigSchema.optional(),
	webhook: WebhookChannelConfigSchema.optional(),
	nextcloud: NextcloudChannelConfigSchema.optional(),
});

export type ChannelsConfig = z.infer<typeof ChannelsConfigSchema>;

export const MemoryConfigSchema = z.object({
	qdrant: z
		.object({
			url: z.string().url().default("http://localhost:6333"),
		})
		.default({}),
	ollama: z
		.object({
			url: z.string().url().default("http://localhost:11434"),
			model: z.string().min(1).default("nomic-embed-text"),
		})
		.default({}),
	collections: z
		.object({
			episodes: z.string().min(1).default("episodes"),
			semantic_facts: z.string().min(1).default("semantic_facts"),
			procedures: z.string().min(1).default("procedures"),
		})
		.default({}),
	embedding: z
		.object({
			dimensions: z.number().int().positive().default(768),
			batch_size: z.number().int().positive().default(32),
		})
		.default({}),
	context: z
		.object({
			max_tokens: z.number().int().positive().default(50000),
			episode_limit: z.number().int().positive().default(10),
			fact_limit: z.number().int().positive().default(20),
			procedure_limit: z.number().int().positive().default(5),
		})
		.default({}),
});
