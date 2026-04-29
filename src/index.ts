import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createReflectiveToolServer } from "./agent/in-process-reflective-tools.ts";
import { createInProcessToolServer } from "./agent/in-process-tools.ts";
import { AgentRuntime } from "./agent/runtime.ts";
import type { RuntimeEvent } from "./agent/runtime.ts";
import { CliChannel } from "./channels/cli.ts";
import { EmailChannel } from "./channels/email.ts";
import { emitFeedback, setFeedbackHandler } from "./channels/feedback.ts";
import { ChannelInteractionRegistry } from "./channels/interaction-adapter.ts";
import { NextcloudChannel } from "./channels/nextcloud.ts";
import { createNextcloudInteractionFactory } from "./channels/nextcloud-interaction.ts";
import { ChannelRouter } from "./channels/router.ts";
import { setActionFollowUpHandler } from "./channels/slack-actions.ts";
import { SlackChannel } from "./channels/slack.ts";
import { createSlackInteractionFactory } from "./channels/slack-interaction.ts";
import { TelegramChannel } from "./channels/telegram.ts";
import { createTelegramInteractionFactory } from "./channels/telegram-interaction.ts";
import { WebhookChannel } from "./channels/webhook.ts";
import { loadChannelsConfig, loadConfig } from "./config/loader.ts";
import { installShutdownHandlers, onShutdown } from "./core/graceful.ts";
import {
	setChannelHealthProvider,
	setChatHandler,
	setEvolutionVersionProvider,
	setEvolutionMetricsProvider,
	setMcpServerProvider,
	setMemoryHealthProvider,
	setOnboardingStatusProvider,
	setPeerHealthProvider,
	setRoleInfoProvider,
	setSchedulerHealthProvider,
	setTriggerDeps,
	setWebhookHandler,
	startServer,
} from "./core/server.ts";
import { closeDatabase, getDatabase } from "./db/connection.ts";
import { runMigrations } from "./db/migrate.ts";
import { createEmailToolServer } from "./email/tool.ts";
import { EvolutionCadence, loadCadenceConfig } from "./evolution/cadence.ts";
import { EvolutionEngine } from "./evolution/engine.ts";
import { EvolutionQueue } from "./evolution/queue.ts";
import type { SessionSummary } from "./evolution/types.ts";
import { PeerHealthMonitor } from "./mcp/peer-health.ts";
import { PeerManager } from "./mcp/peers.ts";
import { PhantomMcpServer } from "./mcp/server.ts";
import { loadMemoryConfig } from "./memory/config.ts";
import { type SessionData, consolidateSession } from "./memory/consolidation.ts";
import { MemoryContextBuilder } from "./memory/context-builder.ts";
import { MemorySystem } from "./memory/system.ts";
import { isFirstRun, isOnboardingInProgress } from "./onboarding/detection.ts";
import { type OnboardingTarget, startOnboarding } from "./onboarding/flow.ts";
import { buildOnboardingPrompt } from "./onboarding/prompt.ts";
import { getOnboardingStatus } from "./onboarding/state.ts";
import { createRoleRegistry } from "./roles/registry.ts";
import type { RoleTemplate } from "./roles/types.ts";
import { Scheduler } from "./scheduler/service.ts";
import { createSchedulerToolServer } from "./scheduler/tool.ts";
import { getSecretRequest } from "./secrets/store.ts";
import { createSecretToolServer } from "./secrets/tools.ts";
import { createBrowserToolServer } from "./ui/browser-mcp.ts";
import { setLoginPageAgentName } from "./ui/login-page.ts";
import { closePreviewResources, createPreviewToolServer, getOrCreatePreviewContext } from "./ui/preview.ts";
import {
	setBootstrapDb,
	setDashboardDb,
	setEvolutionEngine,
	setEvolutionQueue,
	setMemorySystem,
	setPublicDir,
	setSchedulerInstance,
	setSecretSavedCallback,
	setSecretsDb,
} from "./ui/serve.ts";
import { createWebUiToolServer } from "./ui/tools.ts";

async function main(): Promise<void> {
	const startedAt = Date.now();

	console.log("[phantom] Starting...");

	const config = loadConfig();
	console.log(`[phantom] Config loaded: ${config.name} (${config.model}, effort: ${config.effort})`);

	// Set web UI public directory
	setPublicDir(resolve(process.cwd(), "public"));
	setLoginPageAgentName(config.name);

	// Load role system
	const roleRegistry = createRoleRegistry();
	let activeRole: RoleTemplate | null = null;
	const roleId = config.role;
	if (roleRegistry.has(roleId)) {
		activeRole = roleRegistry.getOrThrow(roleId);
		console.log(`[roles] Loaded role: ${activeRole.name} (${activeRole.id})`);
	} else {
		console.log(`[roles] Role '${roleId}' not found in registry, using config role hint`);
	}

	setRoleInfoProvider(() => (activeRole ? { id: activeRole.id, name: activeRole.name } : null));

	const db = getDatabase();
	runMigrations(db);
	setSecretsDb(db);
	setDashboardDb(db);
	setBootstrapDb(db);
	console.log("[phantom] Database ready");

	// Seed working memory file if it does not exist yet
	const wmPath = join(process.cwd(), "data", "working-memory.md");
	if (!existsSync(wmPath)) {
		writeFileSync(wmPath, "# Working Memory\n\nYour personal notes. Update as you learn.\n", "utf-8");
		console.log("[phantom] Seeded working memory file");
	}

	const memoryConfig = loadMemoryConfig();
	const memory = new MemorySystem(memoryConfig);
	await memory.initialize();

	setMemoryHealthProvider(() => memory.healthCheck());
	setMemorySystem(memory);

	// Runtime is created before evolution so we can wire it into the engine.
	// Evolution judges run through the same Agent SDK subprocess as the main
	// agent, which means a single auth path and a single provider switch.
	const runtime = new AgentRuntime(config, db);

	let evolution: EvolutionEngine | null = null;
	let evolutionCadence: EvolutionCadence | null = null;
	try {
		const engine = new EvolutionEngine(undefined, runtime);
		evolution = engine;
		const currentVersion = engine.getCurrentVersion();
		const judgeMode = engine.usesLLMJudges() ? "LLM judges" : "heuristic";
		console.log(`[evolution] Engine initialized (v${currentVersion}, ${judgeMode})`);
		setEvolutionVersionProvider(() => evolution?.getCurrentVersion() ?? 0);
		setEvolutionMetricsProvider(() => evolution?.getMetrics() ?? null);

		// Phase 2: persistent queue + cadence scheduler. The cadence starts
		// here so cron ticks begin immediately after boot. Demand triggers
		// route through `onEnqueue` which fires a drain whenever the queue
		// depth crosses `demandTriggerDepth`.
		const queue = new EvolutionQueue(db);
		const cadenceConfig = loadCadenceConfig(engine.getEvolutionConfig());
		evolutionCadence = new EvolutionCadence(engine, queue, engine.getEvolutionConfig(), cadenceConfig);
		engine.setQueueWiring(queue, () => evolutionCadence?.onEnqueue());
		setEvolutionEngine(engine);
		setEvolutionQueue(queue);
		// The cadence drains the queue out-of-band, so the runtime's in-memory
		// evolved config snapshot must be refreshed from disk after each
		// applied change. Without this callback the queued path would rewrite
		// `phantom-config/` files but the live agent would keep prompting with
		// the boot-time snapshot until the process restarts.
		engine.setOnConfigApplied(() => {
			runtime.setEvolvedConfig(engine.getConfig());
		});
		evolutionCadence.start();
		console.log(
			`[evolution] Cadence started (cadence=${cadenceConfig.cadenceMinutes}min, demand_trigger=${cadenceConfig.demandTriggerDepth})`,
		);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn(`[evolution] Failed to initialize: ${msg}. Running without self-evolution.`);
	}

	if (activeRole) {
		runtime.setRoleTemplate(activeRole);
	}

	if (memory.isReady()) {
		const contextBuilder = new MemoryContextBuilder(memory, memoryConfig);
		runtime.setMemoryContextBuilder(contextBuilder);
	}

	if (evolution) {
		runtime.setEvolvedConfig(evolution.getConfig());
	}

	// Wire feedback to evolution engine
	setFeedbackHandler((signal) => {
		console.log(`[feedback] ${signal.type} from ${signal.source} (${signal.conversationId})`);
		// Feedback signals feed into the next session's evolution context
		if (evolution) {
			const sessionSummary: SessionSummary = {
				session_id: `feedback_${signal.messageTs}`,
				session_key: signal.conversationId,
				user_id: signal.userId,
				user_messages: [],
				assistant_messages: [],
				tools_used: [],
				files_tracked: [],
				outcome: signal.type === "positive" ? "success" : signal.type === "negative" ? "failure" : "success",
				cost_usd: 0,
				started_at: new Date(signal.timestamp).toISOString(),
				ended_at: new Date(signal.timestamp).toISOString(),
			};
			evolution
				.enqueueIfWorthy(sessionSummary)
				.then((enqResult) => {
					// Phase 1 fallback path: when no queue is wired, enqueueIfWorthy
					// runs the pipeline inline and exposes the result so the
					// evolved config can be re-loaded. In production the cadence
					// drains the queue out-of-band and the config reload happens
					// after processBatch completes, not here.
					const applied = enqResult.inlineResult?.changes_applied.length ?? 0;
					if (applied > 0) {
						const updatedConfig = evolution?.getConfig();
						if (updatedConfig) runtime.setEvolvedConfig(updatedConfig);
					}
				})
				.catch((err: unknown) => {
					const errMsg = err instanceof Error ? err.message : String(err);
					console.warn(`[feedback] Evolution from feedback failed: ${errMsg}`);
				});
		}
	});

	let mcpServer: PhantomMcpServer | null = null;
	let scheduler: Scheduler | null = null;
	try {
		mcpServer = new PhantomMcpServer({
			config,
			db,
			startedAt,
			runtime,
			memory: memory.isReady() ? memory : null,
			evolution,
			roleId: activeRole?.id,
		});
		setMcpServerProvider(() => mcpServer);

		// Wire dynamic tool management tools into the agent as in-process MCP tools
		const registry = mcpServer.getDynamicToolRegistry();

		// Wire scheduler into the agent (Slack channel set later after channel init)
		scheduler = new Scheduler({ db, runtime });
		setSchedulerHealthProvider(() => scheduler?.getHealthSummary() ?? null);
		setSchedulerInstance(scheduler, runtime);

		// Pass factories (not singletons) so each query() gets fresh MCP server instances.
		// The underlying registries (DynamicToolRegistry, Scheduler) are singletons.
		// Only the lightweight McpServer wrappers are recreated per query.
		// This prevents "Already connected to a transport" crashes when the scheduler
		// fires a query while a previous session's transport hasn't fully cleaned up.
		const secretsBaseUrl = config.public_url ?? `http://localhost:${config.port}`;
		runtime.setMcpServerFactories({
			"phantom-dynamic-tools": () => createInProcessToolServer(registry),
			"phantom-scheduler": () => createSchedulerToolServer(scheduler as Scheduler),
			"phantom-reflective": () => createReflectiveToolServer(memory.isReady() ? memory : null, db),
			"phantom-web-ui": () => createWebUiToolServer(config.public_url, config.name),
			"phantom-secrets": () => createSecretToolServer({ db, baseUrl: secretsBaseUrl }),
			"phantom-preview": () => createPreviewToolServer(config.port),
			"phantom-browser": () => createBrowserToolServer(() => getOrCreatePreviewContext()),
			...(process.env.RESEND_API_KEY
				? {
						"phantom-email": () =>
							createEmailToolServer({
								agentName: config.name,
								domain: config.domain ?? "ghostwright.dev",
								dailyLimit: Number(process.env.PHANTOM_EMAIL_DAILY_LIMIT) || 50,
							}),
					}
				: {}),
		});
		const emailStatus = process.env.RESEND_API_KEY ? " + email" : "";
		console.log(
			`[mcp] MCP server initialized (dynamic tools + scheduler + reflective + web UI + secrets + preview + browser${emailStatus} wired to agent)`,
		);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn(`[mcp] Failed to initialize MCP server: ${msg}. Running without MCP.`);
	}

	// Peer Phantom connections
	const peerManager = new PeerManager();
	if (config.peers) {
		for (const [name, peerConfig] of Object.entries(config.peers)) {
			if (peerConfig.enabled) {
				peerManager.addPeer(name, peerConfig);
			}
		}
		if (peerManager.count() > 0) {
			console.log(
				`[peers] Loaded ${peerManager.count()} peer(s): ${peerManager
					.getAllPeers()
					.map((p) => p.name)
					.join(", ")}`,
			);
		}
	}

	let peerHealthMonitor: PeerHealthMonitor | null = null;
	if (peerManager.count() > 0) {
		peerHealthMonitor = new PeerHealthMonitor(peerManager);
		peerHealthMonitor.start();
		setPeerHealthProvider(() => peerHealthMonitor?.getHealthSummary() ?? {});
		console.log("[peers] Peer health monitor started");
	}

	const router = new ChannelRouter();

	// Register Slack channel
	let slackChannel: SlackChannel | null = null;
	const channelsConfig = loadChannelsConfig();
	if (channelsConfig?.slack?.enabled && channelsConfig.slack.bot_token && channelsConfig.slack.app_token) {
		slackChannel = new SlackChannel({
			botToken: channelsConfig.slack.bot_token,
			appToken: channelsConfig.slack.app_token,
			defaultChannelId: channelsConfig.slack.default_channel_id,
			ownerUserId: channelsConfig.slack.owner_user_id,
		});
		slackChannel.setPhantomName(config.name);

		// Wire Slack reaction feedback to evolution
		slackChannel.onReaction((event) => {
			emitFeedback({
				type: event.isPositive ? "positive" : "negative",
				conversationId: `slack:${event.channel}:${event.messageTs}`,
				messageTs: event.messageTs,
				userId: event.userId,
				source: "reaction",
				timestamp: Date.now(),
			});
		});

		router.register(slackChannel);
		console.log("[phantom] Slack channel registered");
	}

	// Register Telegram channel
	let telegramChannel: TelegramChannel | null = null;
	if (channelsConfig?.telegram?.enabled && channelsConfig.telegram.bot_token) {
		telegramChannel = new TelegramChannel(
			{
				botToken: channelsConfig.telegram.bot_token,
				enableMessageReactions: channelsConfig.telegram.enable_message_reactions,
				ownerUserIds: channelsConfig.telegram.owner_user_ids,
				rejectionReply: channelsConfig.telegram.rejection_reply,
				sendIntro: channelsConfig.telegram.send_intro,
			},
			db, // P6: Pass database for intro tracking
		);
		router.register(telegramChannel);
		console.log("[phantom] Telegram channel registered");
	}

	// Register Email channel
	let emailChannel: EmailChannel | null = null;
	if (channelsConfig?.email?.enabled) {
		const ec = channelsConfig.email;
		emailChannel = new EmailChannel({
			imap: {
				host: ec.imap.host,
				port: ec.imap.port,
				auth: { user: ec.imap.user, pass: ec.imap.pass },
				tls: ec.imap.tls,
			},
			smtp: {
				host: ec.smtp.host,
				port: ec.smtp.port,
				auth: { user: ec.smtp.user, pass: ec.smtp.pass },
				tls: ec.smtp.tls,
			},
			fromAddress: ec.from_address,
			fromName: ec.from_name,
		});
		router.register(emailChannel);
		console.log("[phantom] Email channel registered");
	}

	// Register Webhook channel
	let webhookChannel: WebhookChannel | null = null;
	if (channelsConfig?.webhook?.enabled && channelsConfig.webhook.secret) {
		webhookChannel = new WebhookChannel({
			secret: channelsConfig.webhook.secret,
			syncTimeoutMs: channelsConfig.webhook.sync_timeout_ms,
		});
		router.register(webhookChannel);
		const wh = webhookChannel;
		setWebhookHandler((req) => wh.handleRequest(req));
		console.log("[phantom] Webhook channel registered");
	}

	// Register Nextcloud channel
	let nextcloudChannel: NextcloudChannel | null = null;
	if (channelsConfig?.nextcloud?.enabled && channelsConfig.nextcloud.shared_secret) {
		nextcloudChannel = new NextcloudChannel({
			sharedSecret: channelsConfig.nextcloud.shared_secret,
			talkServer: channelsConfig.nextcloud.talk_server,
			roomToken: channelsConfig.nextcloud.room_token,
			webhookPath: channelsConfig.nextcloud.webhook_path,
			port: channelsConfig.nextcloud.port,
			botId: channelsConfig.nextcloud.bot_id,
			sessionWindowMinutes: channelsConfig.nextcloud.session_window_minutes,
		}, runtime.sessionStore);
		router.register(nextcloudChannel);
		console.log("[phantom] Nextcloud channel registered");
	}

	// Register CLI channel (fallback for local dev)
	if (!slackChannel && !telegramChannel) {
		const cli = new CliChannel();
		router.register(cli);
	}

	// Register Web Chat channel (health/discovery only, hot path bypasses router)
	const { WebChatChannel } = await import("./channels/web.ts");
	const webChannel = new WebChatChannel();
	router.register(webChannel);

	// Wire chat HTTP handler
	const { ChatSessionStore } = await import("./chat/session-store.ts");
	const { ChatMessageStore } = await import("./chat/message-store.ts");
	const { ChatEventLog } = await import("./chat/event-log.ts");
	const { ChatAttachmentStore } = await import("./chat/attachment-store.ts");
	const { StreamBus } = await import("./chat/stream-bus.ts");
	const { createChatHandler } = await import("./chat/http.ts");
	const { startSweepInterval } = await import("./chat/sweep.ts");
	const { SessionFocusMap } = await import("./chat/notifications/focus.ts");
	const { getOrCreateVapidKeys } = await import("./chat/notifications/vapid.ts");
	const { NotificationTriggerService } = await import("./chat/notifications/triggers.ts");

	const chatSessionStore = new ChatSessionStore(db);
	const chatMessageStore = new ChatMessageStore(db);
	const chatEventLog = new ChatEventLog(db);
	const chatAttachmentStore = new ChatAttachmentStore(db);
	const chatStreamBus = new StreamBus();

	// Initialize push notification subsystem
	const focusMap = new SessionFocusMap();
	let vapidKeys: Awaited<ReturnType<typeof getOrCreateVapidKeys>> | null = null;
	let notificationTriggers: InstanceType<typeof NotificationTriggerService> | null = null;
	try {
		vapidKeys = await getOrCreateVapidKeys(db);
		notificationTriggers = new NotificationTriggerService({
			db,
			vapidKeys,
			focusMap,
			ownerEmail: process.env.OWNER_EMAIL,
		});
		console.log("[push] Web Push notifications initialized");
	} catch (err: unknown) {
		const pushMsg = err instanceof Error ? err.message : String(err);
		console.warn(`[push] Failed to initialize: ${pushMsg}. Running without push notifications.`);
	}

	const chatHandlerFn = createChatHandler({
		runtime,
		sessionStore: chatSessionStore,
		messageStore: chatMessageStore,
		eventLog: chatEventLog,
		attachmentStore: chatAttachmentStore,
		streamBus: chatStreamBus,
		db,
		vapidKeys: vapidKeys ?? undefined,
		focusMap,
		ownerEmail: process.env.OWNER_EMAIL,
		agentName: config.name,
		notificationTriggers: notificationTriggers ?? undefined,
		getBootstrapData: () => ({
			agent_name: config.name,
			evolution_gen: evolution?.getCurrentVersion() ?? 0,
			memory_count: 0,
			slack_status: slackChannel?.isConnected() ?? false,
		}),
	});
	setChatHandler(chatHandlerFn);
	console.log("[phantom] Web Chat channel registered");

	// Chat sweep interval (hourly cleanup)
	const sweepTimer = startSweepInterval({
		sessionStore: chatSessionStore,
		eventLog: chatEventLog,
		attachmentStore: chatAttachmentStore,
	});

	// Wire channel health into HTTP server
	setChannelHealthProvider(() => {
		const health: Record<string, boolean> = {};
		if (slackChannel) health.slack = slackChannel.isConnected();
		if (telegramChannel) health.telegram = telegramChannel.isConnected();
		if (emailChannel) health.email = emailChannel.isConnected();
		if (webhookChannel) health.webhook = webhookChannel.isConnected();
		if (nextcloudChannel) health.nextcloud = nextcloudChannel.isConnected();
		return health;
	});

	// Wire action follow-up handler (button clicks -> agent)
	setActionFollowUpHandler(async (params) => {
		const followUpText = params.actionPayload
			? `User clicked "${params.actionLabel}". Context: ${params.actionPayload}`
			: `User clicked "${params.actionLabel}". Please follow up accordingly.`;

		await runtime.handleMessage("slack", params.conversationId, followUpText);
	});

	// Onboarding detection
	const configDir = evolution?.getEvolutionConfig().paths.config_dir ?? "phantom-config";
	const needsOnboarding = isFirstRun(configDir) || isOnboardingInProgress(db);
	if (needsOnboarding && activeRole) {
		const onboardingPrompt = buildOnboardingPrompt(activeRole, config.name);
		runtime.setOnboardingPrompt(onboardingPrompt);
		console.log("[onboarding] Onboarding prompt injected into agent runtime");
	}

	setOnboardingStatusProvider(() => getOnboardingStatus(db).status);

	// Build the channel interaction registry. Each factory inspects an
	// inbound message and either returns an adapter (handling status
	// reactions, progress streams, typing, etc.) or null to opt out.
	// Phase 1 of the Telegram parity plan: this replaces the per-channel
	// `if (isSlack) / if (isNextcloud) / if (isTelegram)` ladder that
	// used to live inside router.onMessage.
	const interactionRegistry = new ChannelInteractionRegistry();
	interactionRegistry.register(createSlackInteractionFactory(slackChannel));
	interactionRegistry.register(createNextcloudInteractionFactory(nextcloudChannel));
	interactionRegistry.register(createTelegramInteractionFactory(telegramChannel));

	const conversationMessages = new Map<string, { user: string[]; assistant: string[] }>();

	router.onMessage(async (msg) => {
		const sessionStartedAt = new Date().toISOString();
		const convKey = `${msg.channelId}:${msg.conversationId}`;

		const existing = conversationMessages.get(convKey) ?? { user: [], assistant: [] };
		existing.user.push(msg.text);
		conversationMessages.set(convKey, existing);

		// Build per-channel interaction adapters. Each adapter handles its own
		// status reactions, progress streams, typing, and (optionally) response
		// delivery. The orchestration below is uniform across all channels.
		const interactions = interactionRegistry.buildFor(msg);

		// Phase 1: onTurnStart hooks (e.g., Slack progress.start, Telegram typing).
		await Promise.all(interactions.map((i) => i.onTurnStart?.()));

		// Fix #11: Track error events instead of text sniffing
		let hadErrorEvent = false;
		let response: AgentResponse;

		// Fix #C: the per-adapter dispose() in the cleanup block ensures any
		// in-flight reactions/typing/progress is cleared even on throw.
		response = await runtime.handleMessage(msg.channelId, msg.conversationId, msg.text, (event: RuntimeEvent) => {
			switch (event.type) {
				case "init":
					console.log(`\n[phantom] Session: ${event.sessionId}`);
					break;
				case "error":
					hadErrorEvent = true;
					break;
			}
			// Fan every event to every adapter that wants to listen.
			for (const i of interactions) i.onRuntimeEvent?.(event);
		});

		// Track assistant messages
		if (response.text) existing.assistant.push(response.text);

		// Fix #11+#D: combined error signal (event flag + text sniff)
		const isError = hadErrorEvent || response.text.startsWith("Error:");

		// Phase 2: onTurnEnd hooks (e.g., Slack setDone/setError, Telegram stopTyping).
		// Adapters use this to emit terminal status reactions and stop typing.
		// Status reactions are the canonical "agent is done" signal — fan to each.
		for (const i of interactions) {
			if (i.statusReactions) {
				if (isError) await i.statusReactions.setError();
				else await i.statusReactions.setDone();
			}
		}
		await Promise.all(interactions.map((i) => i.onTurnEnd?.({ text: response.text, isError })));

		// Phase 3: response delivery. Each adapter's deliverResponse can claim
		// the response (returns true). If any does, skip the router.send fallback.
		let claimed = false;
		for (const i of interactions) {
			if (i.deliverResponse) {
				const result = await i.deliverResponse({ text: response.text, isError });
				if (result) claimed = true;
			}
		}
		if (!claimed) {
			// Default delivery: route through ChannelRouter.send. Nextcloud needs
			// the original message ID as replyToId for threading; other channels
			// ignore replyToId.
			const nextcloudMessageId = msg.channelId === "nextcloud"
				? (msg.metadata?.nextcloudMessageId as number | undefined)
				: undefined;
			const replyToId = nextcloudMessageId !== undefined ? String(nextcloudMessageId) : undefined;
			await router.send(msg.channelId, msg.conversationId, {
				text: response.text,
				threadId: msg.threadId,
				replyToId,
			});
		}

		if (response.cost.totalUsd > 0) {
			console.log(
				`[phantom] Cost: $${response.cost.totalUsd.toFixed(4)} | ` +
					`${response.cost.inputTokens} in / ${response.cost.outputTokens} out | ` +
					`${(response.durationMs / 1000).toFixed(1)}s`,
			);
		}

		const trackedFiles = runtime.getLastTrackedFiles();

		// Memory consolidation (non-blocking)
		if (memory.isReady()) {
			const sessionData: SessionData = {
				sessionId: response.sessionId,
				sessionKey: convKey,
				userId: msg.senderId,
				userMessages: existing.user,
				assistantMessages: existing.assistant,
				toolsUsed: [],
				filesTracked: trackedFiles,
				startedAt: sessionStartedAt,
				endedAt: new Date().toISOString(),
				costUsd: response.cost.totalUsd,
				outcome: isError ? "failure" : "success", // Fix #11+#D: Use combined error signal
			};

			// Phase 3 simplified memory consolidation: the Phase 1+2 LLM judge
			// path is gone with the rest of the judges directory. Heuristic
			// extraction ships every session regardless. The reflection
			// subprocess manages `phantom-config/` memory files on the
			// cadence, which is the new learning loop; memory/consolidation
			// here is only the vector-memory episode/fact extractor.
			consolidateSession(memory, sessionData)
				.then((result) => {
					if (result.episodesCreated > 0 || result.factsExtracted > 0) {
						console.log(
							`[memory] Consolidated: ${result.episodesCreated} episodes, ` +
								`${result.factsExtracted} facts (${result.durationMs}ms)`,
						);
					}
				})
				.catch((err: unknown) => {
					const errMsg = err instanceof Error ? err.message : String(err);
					console.warn(`[memory] Consolidation failed: ${errMsg}`);
				});
		}

		// Evolution pipeline (non-blocking)
		if (evolution) {
			const sessionSummary: SessionSummary = {
				session_id: response.sessionId,
				session_key: convKey,
				user_id: msg.senderId,
				user_messages: existing.user,
				assistant_messages: existing.assistant,
				tools_used: [],
				files_tracked: trackedFiles,
				outcome: isError ? "failure" : "success", // Fix #11+#D: Use combined error signal
				cost_usd: response.cost.totalUsd,
				started_at: sessionStartedAt,
				ended_at: new Date().toISOString(),
			};

			evolution
				.enqueueIfWorthy(sessionSummary)
				.then((enqResult) => {
					const applied = enqResult.inlineResult?.changes_applied.length ?? 0;
					if (applied > 0) {
						const updatedConfig = evolution?.getConfig();
						if (updatedConfig) {
							runtime.setEvolvedConfig(updatedConfig);
						}
					}
				})
				.catch((err: unknown) => {
					const errMsg = err instanceof Error ? err.message : String(err);
					console.warn(`[evolution] Post-session evolution failed: ${errMsg}`);
				});
		}

		// Clean up
		for (const i of interactions) i.dispose?.();
	});

	const server = startServer(config, startedAt);

	installShutdownHandlers();
	onShutdown("HTTP server", async () => {
		server.stop();
	});
	onShutdown("MCP server", async () => {
		if (mcpServer) await mcpServer.close();
	});
	onShutdown("Scheduler", async () => {
		if (scheduler) scheduler.stop();
	});
	onShutdown("Evolution cadence", async () => {
		evolutionCadence?.stop();
	});
	onShutdown("Preview browser", async () => {
		await closePreviewResources();
	});
	onShutdown("Peer health monitor", async () => {
		if (peerHealthMonitor) peerHealthMonitor.stop();
	});
	onShutdown("Memory system", async () => {
		await memory.close();
	});
	onShutdown("Channels", async () => {
		await router.disconnectAll();
	});
	onShutdown("Chat sweep", async () => {
		clearInterval(sweepTimer);
	});
	onShutdown("Database", async () => {
		closeDatabase();
	});

	await router.connectAll();

	// First-run email trigger when Slack is not configured
	if (!slackChannel) {
		const { handleFirstRun } = await import("./chat/first-run.ts");
		handleFirstRun(db, config).catch((err: unknown) => {
			const firstRunMsg = err instanceof Error ? err.message : String(err);
			console.warn(`[first-run] Failed: ${firstRunMsg}`);
		});
	}

	// Wire Slack into scheduler and /trigger now that channels are connected.
	// The owner_user_id gate was removed in Phase 2.5 (C3): channel-id and
	// user-id delivery targets do not need the owner; only target="owner"
	// does, and the scheduler's delivery path records a loud "dropped" status
	// in that specific case instead of silently no-oping every job.
	if (scheduler && slackChannel) {
		scheduler.setSlackChannel(slackChannel, channelsConfig?.slack?.owner_user_id ?? null);
	}
	if (scheduler) {
		if (notificationTriggers) {
			const nt = notificationTriggers;
			scheduler.onJobComplete((jobName, status) => {
				nt.onScheduledJobResult(jobName, status).catch((err: unknown) => {
					const msg = err instanceof Error ? err.message : String(err);
					console.warn(`[push] Scheduler trigger failed: ${msg}`);
				});
			});
		}
		await scheduler.start();
	}

	// Wire /trigger endpoint
	setTriggerDeps({
		runtime,
		slackChannel: slackChannel ?? undefined,
		ownerUserId: channelsConfig?.slack?.owner_user_id,
	});

	// Wire secret save notification: when the user saves credentials via the form,
	// wake the agent in the original Slack thread so it can respond naturally.
	// This follows the scheduler pattern: route a synthetic message through the runtime.
	setSecretSavedCallback(async (requestId, secretNames) => {
		const request = getSecretRequest(db, requestId);
		if (!request?.notifyChannelId || !request.notifyThread) return;

		const conversationId = `slack:${request.notifyChannelId}:${request.notifyThread}`;
		const prompt = `The user just saved credentials via the secure form: ${secretNames.join(", ")}. Use phantom_get_secret to retrieve them and continue with the task you were working on.`;

		// Non-blocking: wake the agent, let it decide what to say (Cardinal Rule)
		runtime.handleMessage("slack", conversationId, prompt).catch((err: unknown) => {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`[secrets] Failed to wake agent after secret save: ${msg}`);
		});
	});

	// Post onboarding intro after channels are connected
	if (isFirstRun(configDir) && activeRole && slackChannel) {
		const ownerUserId = channelsConfig?.slack?.owner_user_id;
		const defaultChannel = channelsConfig?.slack?.default_channel_id;
		const defaultUser = channelsConfig?.slack?.default_user_id;

		// DM the owner first (primary path), fall back to channel or default_user_id
		let target: OnboardingTarget | null = null;
		if (ownerUserId) {
			target = { type: "dm", userId: ownerUserId };
		} else if (defaultUser) {
			target = { type: "dm", userId: defaultUser };
		} else if (defaultChannel) {
			target = { type: "channel", channelId: defaultChannel };
		}

		if (target) {
			const slackClient = slackChannel.getClient();
			const profile = await startOnboarding(slackChannel, target, config.name, activeRole, db, slackClient);

			// Inject owner profile into onboarding prompt for personalized agent conversation
			if (profile && needsOnboarding) {
				const personalizedPrompt = buildOnboardingPrompt(activeRole, config.name, profile);
				runtime.setOnboardingPrompt(personalizedPrompt);
			}

			// Also post to channel if owner DM was sent and channel is configured
			if (target.type === "dm" && defaultChannel) {
				const channelIntro = `Hey team, I'm ${config.name}. I just joined as a ${activeRole.name} co-worker. I'll be working with ${profile?.name ?? "the team"} - feel free to @mention me if you need anything.`;
				await slackChannel.postToChannel(defaultChannel, channelIntro);
				console.log(`[onboarding] Also posted introduction to channel ${defaultChannel}`);
			}
		} else {
			console.warn("[onboarding] No owner, default user, or channel configured, skipping intro message");
		}
	}

	console.log(`[phantom] ${config.name} is ready.`);
}

main().catch((err: unknown) => {
	const msg = err instanceof Error ? err.message : String(err);
	console.error(`[phantom] Fatal: ${msg}`);
	process.exit(1);
});
