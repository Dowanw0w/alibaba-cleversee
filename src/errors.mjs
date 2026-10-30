// 统一错误类型。`kind` 决定路由是否换下一家 provider。
//
// 约定：错误文本会进入日志与工具结果，禁止拼接 API Key、完整 query 或网页正文。
export class MultiAccessError extends Error {
	constructor(message, options = {}) {
		super(String(message), options.cause ? { cause: options.cause } : undefined);
		this.name = "MultiAccessError";
		this.kind = options.kind ?? "unknown";
		this.provider = options.provider ?? null;
		this.status = Number.isFinite(options.status) ? Number(options.status) : 0;
		this.code = options.code ?? null;
		this.attempts = options.attempts ?? null;
	}

	toJSON() {
		return {
			name: this.name,
			message: this.message,
			kind: this.kind,
			provider: this.provider,
			status: this.status,
			code: this.code,
			attempts: this.attempts,
		};
	}
}

// 允许触发「继续尝试下一档」的分类（当前仅 CleverSee readpage basic → scrape）。
// config / no-provider / aborted 属于不可恢复，直接上抛。
const FAILOVER_KINDS = new Set([
	"auth",
	"payment",
	"rate",
	"transient",
	"network",
	"invalid",
	"invalid-response",
	"local-throttle",
	"target",
	"empty",
]);

export function isFailoverKind(kind) {
	return FAILOVER_KINDS.has(kind);
}

export function safeErrorMessage(error) {
	const message = error instanceof Error ? error.message : String(error ?? "");
	return message.replace(/\s+/g, " ").trim().slice(0, 240);
}
