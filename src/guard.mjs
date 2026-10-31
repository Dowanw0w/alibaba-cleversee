import { CleverSeeError } from "./errors.mjs";
import { defaultSleep } from "./util.mjs";

// 令牌桶限速：等待超过上限时抛 local-throttle 错误，交给路由切换。
// 使用独立 kind：本地排队超时是调用方并发造成的，不能计入熔断（否则一波并发
// 就能把健康的上游熔断），也不应与上游 429 的 rate 混为一谈。
export function createLimiter({ qps, maxWaitMs = 1_500, now = Date.now, sleep = defaultSleep } = {}) {
	const capacity = Math.max(1, qps);
	const refillPerMs = capacity / 1000;
	let tokens = capacity;
	let last = now();

	function refill(at) {
		const elapsed = Math.max(0, at - last);
		tokens = Math.min(capacity, tokens + elapsed * refillPerMs);
		last = at;
	}

	return {
		async acquire() {
			const at = now();
			refill(at);
			if (tokens >= 1) {
				tokens -= 1;
				return;
			}
			const waitMs = Math.ceil((1 - tokens) / refillPerMs);
			if (waitMs > maxWaitMs) {
				throw new CleverSeeError(`rate limit wait ${waitMs}ms exceeds ${maxWaitMs}ms`, { kind: "local-throttle" });
			}
			await sleep(waitMs);
			refill(now());
			tokens = Math.max(0, tokens - 1);
		},
	};
}

// 熔断器：连续失败达到阈值后 open，cooldown 后放一个 half-open 探针。
export function createBreaker({ threshold = 3, cooldownMs = 120_000 } = {}) {
	let failures = 0;
	let openedAt = 0;
	let halfOpen = false;

	return {
		canAttempt(now = Date.now()) {
			if (openedAt === 0) return true;
			if (now - openedAt < cooldownMs) return false;
			if (halfOpen) return false;
			halfOpen = true;
			return true;
		},
		recordSuccess() {
			failures = 0;
			openedAt = 0;
			halfOpen = false;
		},
		recordFailure(now = Date.now()) {
			failures += 1;
			if (failures >= threshold) {
				openedAt = now;
				halfOpen = false;
			}
		},
		state(now = Date.now()) {
			if (openedAt === 0) return { state: "closed", failures };
			if (now - openedAt >= cooldownMs) return { state: "half-open", failures };
			return { state: "open", failures, retryInMs: cooldownMs - (now - openedAt) };
		},
	};
}
