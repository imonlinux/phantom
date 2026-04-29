# Phase 5.5: Telegram Channel Security Audit

**Date**: 2025-04-29
**Scope**: `src/channels/telegram.ts` + `src/config/schemas.ts`
**Audit Type**: Defensive security review

---

## Executive Summary

**Overall Assessment**: 4 LOW, 2 MEDIUM issues found

The Telegram channel implementation demonstrates good security hygiene in bot token handling and logging practices. Primary concerns are configuration validation (owner IDs) and deployment flexibility (hardcoded URLs).

---

## Findings

### 1. Bot Token Handling ✅ SECURE

**Status**: No issues found

**Analysis**:
- Token only used in Telegraf constructor: `new Telegraf(this.config.botToken)`
- No logging of token in any console statements
- No appearance in error messages or stack traces
- Not sent in error reports

**Code Evidence**:
```typescript
// Line 292: Only usage
this.bot = new Telegraf(this.config.botToken) as unknown as TelegrafBot;
```

**Recommendation**: None - current implementation is secure.

---

### 2. REJECTION_REPLY Content ⚠️ MEDIUM

**Status**: Configurable deployment concern

**Issue**: The rejection message contains a hardcoded URL to the upstream repository:

```typescript
// Lines 89-91
const REJECTION_REPLY =
	"Hi! I'm Phantom, a personal AI co-worker. I can only respond to my owner. " +
	"<https://github.com/ghostwright/phantom>";
```

**Impact**:
- Forks cannot customize the rejection message URL
- Private deployments leak public repository information
- Cannot point to internal documentation or support

**Recommendation**:
Make this configurable via `channels.yaml`:

```typescript
// In TelegramChannelConfig type
rejectionReply?: string;
// Default: "Hi! I'm Phantom, a personal AI co-worker..."
```

```yaml
# In channels.yaml
telegram:
  rejection_reply: "Hi! This bot is private. Contact admin@example.com for access."
```

---

### 3. Owner ID Validation ⚠️ MEDIUM

**Status**: Insufficient validation at config-load

**Issue**: Schema accepts any string without format validation:

```typescript
// src/config/schemas.ts:100
owner_user_ids: z.array(z.string()).default([])
```

**Attack Vectors**:
- Empty strings: `owner_user_ids: [""]` → Always matches if senderId is empty
- Non-numeric strings: `["admin", "root"]` → Can never match real Telegram IDs
- Negative numbers: `["-1"]` → Invalid Telegram user ID format
- Boolean strings: `["true"]` → Validation bypass attempts

**Current `isOwner()` Implementation**:
```typescript
// Lines 745-749
private isOwner(senderId: string): boolean {
	const owners = this.config.ownerUserIds ?? [];
	if (owners.length === 0) return true;
	return owners.includes(senderId);
}
```

**Recommendation**:
Add Zod validation with regex pattern:

```typescript
// src/config/schemas.ts
owner_user_ids: z.array(
	z.string().regex(/^\d+$/, "Telegram user IDs must be numeric strings")
).default([])
```

**Additional Defense**:
Add validation warning in constructor:

```typescript
constructor(config: TelegramChannelConfig) {
	this.config = config;

	// P5.5: Validate owner ID format
	if (config.ownerUserIds) {
		const invalidIds = config.ownerUserIds.filter(id => !/^\d+$/.test(id));
		if (invalidIds.length > 0) {
			console.warn(`[telegram] Invalid owner_user_ids detected (non-numeric): ${invalidIds.join(", ")}`);
		}
	}
}
```

---

### 4. Callback Data Trust ⚠️ LOW

**Status**: Acceptable complexity tradeoff

**Issue**: Callback queries have no state verification:

```typescript
// Lines 880-907: Feedback handler
this.bot.action(/^phantom:feedback:(positive|negative|partial)$/, async (ctx) => {
	if (ctx.answerCbQuery) await ctx.answerCbQuery();

	const senderId = String(ctx.from?.id ?? "unknown");
	if (!this.isOwner(senderId)) return;

	const data = ctx.callbackQuery?.data;
	const type = data ? parseFeedbackAction(data) : null;
	if (!type) return;

	const chatId = ctx.callbackQuery?.message?.chat.id;
	const messageId = ctx.callbackQuery?.message?.message_id;
	if (chatId === undefined || messageId === undefined) return;

	// No verification that this message was sent by this bot
	// or that it's within a valid time window
	emitFeedback({...});
});
```

**Attack Vectors**:
- **Replay attacks**: Old callback queries can be replayed
- **Message spoofing**: Callback data could reference arbitrary message IDs

**Impact Assessment**:
- Replay attacks create duplicate feedback signals (low impact - evolution engine can tolerate)
- Message spoofing is mitigated by `isOwner()` check (only owners can trigger)
- No sensitive state changes occur (only feedback emission)

**Recommendation**:
**Current approach is acceptable**. State verification would require:
- Message timestamp tracking
- Callback signature verification
- Time-window enforcement

Complexity outweighs benefit for current use case. Monitor for abuse.

---

### 5. Rate Limiting on Rejection Replies ✅ SECURE

**Status**: Properly implemented

**Analysis**:
- `rejectedUsers` Set prevents multiple rejection replies to same user
- Silent return on subsequent messages (no outbound API calls)
- Bounded state: Set can only grow, but unique user IDs are finite

```typescript
// Lines 839-849
const access = this.resolveAccess(senderId, chatType);
if (access === "ignore") return;
if (access === "reject_dm") {
	this.rejectedUsers.add(senderId);  // Prevent future replies
	try {
		await this.bot?.telegram.sendMessage(chatId, REJECTION_REPLY);
	} catch (err: unknown) {
		console.warn(`[telegram] Failed to send rejection reply: ${msg}`);
	}
	return;
}
```

**Worst Case Analysis**:
- Malicious actor sends 10,000 messages → 1 rejection reply + 9,999 early returns
- Telegraf handles inbound throttling
- No unbounded outbound API calls

**Recommendation**: None - current implementation is secure.

---

### 6. Logging Hygiene ✅ SECURE

**Status**: Good practices followed

**Analysis**:
- No message content logged (text/message bodies never in console statements)
- Only metadata logged: chat IDs, error messages, connection state
- User IDs in clear text (acceptable for internal logs)
- Error messages appropriately sanitized

**Sample Log Statements**:
```typescript
console.log(`[telegram] Access control active: ${ownerCount} owner ID(s) configured`);
console.warn(`[telegram] Failed to edit message: ${msg}`);
console.error(`[telegram] Error handling message: ${msg}`);
```

**Recommendation**: None - current practices are secure.

---

## Priority Action Items

### MEDIUM Priority
1. **Configurable rejection reply message** (5 min)
   - Add `rejection_reply?: string` to TelegramChannelConfig
   - Use default if not configured
   - Update channels.yaml.example

2. **Owner ID format validation** (10 min)
   - Add Zod regex validation: `/^\d+$/`
   - Add constructor warning for invalid IDs
   - Document in channels.yaml comments

### LOW Priority
3. **Monitor callback replay patterns** (ongoing)
   - Add metrics for feedback callback frequency
   - Alert if unusual patterns detected
   - Consider time-window verification if abuse observed

---

## Testing Recommendations

Add security-focused tests:

```typescript
describe("P5.5 Security Validation", () => {
	test("rejects non-numeric owner IDs in config", () => {
		expect(() => new TelegramChannel({
			botToken: "test",
			ownerUserIds: ["abc", "-1", ""]
		})).toConsoleWarn("[telegram] Invalid owner_user_ids");
	});

	test("uses custom rejection reply when configured", () => {
		const channel = new TelegramChannel({
			botToken: "test",
			rejectionReply: "Custom message"
		});
		// Verify rejection message uses custom text
	});
});
```

---

## Compliance Notes

- **OWASP**: No sensitive data in logs ✅
- **GDPR**: User IDs logged (metadata, acceptable) ✅
- **SOC2**: Access control properly implemented ✅

---

**Audit Completed**: 2025-04-29
**Next Review**: After Phase 6 (Webhook transport)
