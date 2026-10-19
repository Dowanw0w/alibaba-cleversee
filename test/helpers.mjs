import { loadConfig } from "../src/config.mjs";

export function jsonResponse(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

export function scriptedFetch(handler) {
	const calls = [];
	const impl = async (url, init = {}) => {
		const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
		const call = { url: String(url), method: init.method ?? "GET", body, headers: init.headers ?? {} };
		calls.push(call);
		return handler(call);
	};
	impl.calls = calls;
	return impl;
}

export function testConfig(env = {}) {
	return loadConfig({
		DEEPSEEK_SEARCH_API_KEY: "test-deepseek-key",
		CLEVERSEE_API_KEY: "test-cleversee-key",
		...env,
	});
}

export function fakeProvider(name, overrides = {}) {
	return {
		name,
		configured: true,
		async search() {
			throw new Error(`${name} search not implemented`);
		},
		async fetchPage() {
			throw new Error(`${name} fetch not implemented`);
		},
		...overrides,
	};
}

export function errorOf(kind, message = kind, extra = {}) {
	const error = new Error(message);
	error.kind = kind;
	Object.assign(error, extra);
	return error;
}

export function sampleResult(overrides = {}) {
	return {
		title: "Example",
		url: "https://example.com/a",
		snippet: "snippet",
		summary: "",
		content: "",
		publishedAt: null,
		siteName: null,
		siteIcon: null,
		score: null,
		authority: null,
		provider: "deepseek",
		...overrides,
	};
}
