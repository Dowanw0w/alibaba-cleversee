import { MultiAccessError } from "./errors.mjs";
import { redactSecret } from "./util.mjs";

// 统一 JSON 请求：超时 + 上游取消合并，网络/超时错误分类。
export async function requestJson(url, options = {}) {
	const {
		method = "GET",
		headers = {},
		body,
		timeoutMs = 15_000,
		signal,
		fetchImpl = globalThis.fetch,
		secret = "",
	} = options;

	const timeout = AbortSignal.timeout(timeoutMs);
	const composed = signal ? AbortSignal.any([timeout, signal]) : timeout;

	let response;
	try {
		response = await fetchImpl(url, {
			method,
			headers: { "Content-Type": "application/json", ...headers },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: composed,
		});
	} catch (error) {
		if (signal?.aborted) {
			throw new MultiAccessError("request aborted by caller", { kind: "aborted", cause: error });
		}
		const name = error instanceof Error ? error.name : "";
		const message = redactSecret(error instanceof Error ? error.message : String(error), secret);
		const timedOut = /timeout|timed out/i.test(`${name} ${message}`);
		throw new MultiAccessError(`${timedOut ? "request timed out" : "network error"}: ${message}`, {
			kind: timedOut ? "transient" : "network",
			cause: error,
		});
	}

	const raw = redactSecret(await response.text(), secret);
	let data = null;
	if (raw) {
		try {
			data = JSON.parse(raw);
		} catch {
			data = null;
		}
	}
	return { status: response.status, ok: response.ok, data, raw };
}
