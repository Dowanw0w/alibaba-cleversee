import assert from "node:assert/strict";
import test from "node:test";
import { createRouter } from "../src/router.mjs";
import { errorOf, fakeProvider, sampleResult, testConfig } from "./helpers.mjs";

function searchOk(items = [sampleResult()]) {
	return async () => ({ provider: "cleversee", engine: "CNLiteBasic", results: items, meta: {} });
}

function cleverseeOnly(overrides = {}) {
	return { cleversee: fakeProvider("cleversee", overrides) };
}

test("router returns CleverSee results with a cost estimate", async () => {
	const providers = cleverseeOnly({ search: searchOk() });
	const router = createRouter({ config: testConfig(), providers, now: () => 1_000, sleep: async () => {} });

	const result = await router.search("q", {});
	assert.equal(result.provider, "cleversee");
	assert.equal(result.meta.attempts[0].outcome, "ok");
	assert.equal(result.meta.estimatedCostCny, 0.008);
});

test("router reports empty results as an empty error", async () => {
	const providers = cleverseeOnly({ search: searchOk([]) });
	const router = createRouter({ config: testConfig(), providers, now: () => 1_000, sleep: async () => {} });

	await assert.rejects(
		router.search("q", {}),
		(error) => error.kind === "empty" && error.attempts.length === 1 && error.attempts[0].outcome === "empty",
	);
});

test("auth errors surface with their own kind and attempts", async () => {
	const providers = cleverseeOnly({
		search: async () => {
			throw errorOf("auth", "bad key", { status: 401 });
		},
	});
	const router = createRouter({ config: testConfig(), providers, now: () => 1_000, sleep: async () => {} });

	await assert.rejects(
		router.search("q", {}),
		(error) => error.kind === "auth" && error.status === 401 && error.attempts[0].kind === "auth",
	);
});

test("config errors are not turned into aggregated errors", async () => {
	const router = createRouter({ config: testConfig(), providers: cleverseeOnly(), now: () => 1_000, sleep: async () => {} });
	await assert.rejects(router.search("q", { provider: "deepseek" }), (error) => error.kind === "config");
});

test("breaker opens after consecutive failures and half-opens after cooldown", async () => {
	let clock = 1_000;
	let calls = 0;
	const providers = cleverseeOnly({
		search: async () => {
			calls += 1;
			throw errorOf("transient", "boom", { status: 500 });
		},
	});
	const config = testConfig({ MULTI_ACCESS_BREAKER_THRESHOLD: "2", MULTI_ACCESS_BREAKER_COOLDOWN_MS: "1000" });
	const router = createRouter({ config, providers, now: () => clock, sleep: async () => {} });

	await assert.rejects(router.search("q", {}), (error) => error.kind === "transient");
	await assert.rejects(router.search("q", {}), (error) => error.kind === "transient");
	assert.equal(calls, 2);

	await assert.rejects(
		router.search("q", {}),
		(error) => error.attempts.some((attempt) => attempt.outcome === "circuit-open"),
	);
	assert.equal(calls, 2);

	clock += 1_001;
	providers.cleversee.search = searchOk();
	const result = await router.search("q", {});
	assert.equal(result.provider, "cleversee");
	assert.equal(calls, 2);
});

test("target errors do not open the fetch breaker", async () => {
	let calls = 0;
	const providers = cleverseeOnly({
		fetchPage: async (url, options) => {
			calls += 1;
			if (url === "https://good.example/ok") {
				return { provider: "cleversee", mode: options.mode, url, title: "ok", content: "# ok", meta: {} };
			}
			throw errorOf("target", "ReadPage 404", { status: 404 });
		},
	});
	const config = testConfig({ MULTI_ACCESS_BREAKER_THRESHOLD: "2" });
	const router = createRouter({ config, providers, now: () => 1_000, sleep: async () => {} });

	for (let index = 0; index < 3; index += 1) {
		await assert.rejects(router.fetch(`https://dead.example/${index}`, {}), (error) => error.kind === "target");
	}
	assert.equal(calls, 3);
	assert.ok(router.status().circuits.every((circuit) => circuit.state === "closed"));

	const result = await router.fetch("https://good.example/ok", {});
	assert.equal(result.provider, "cleversee");
	assert.equal(calls, 4);
});

test("local throttling does not open the breaker", async () => {
	let clock = 1_000;
	const providers = cleverseeOnly({ search: searchOk() });
	// qps=1 且 maxWait=0：每分钟只能放过 1 次，其余在本地排队即失败。
	const config = testConfig({ MULTI_ACCESS_CLEVERSEE_QPS: "1", MULTI_ACCESS_LIMITER_MAX_WAIT_MS: "0", MULTI_ACCESS_BREAKER_THRESHOLD: "2" });
	const router = createRouter({ config, providers, now: () => clock, sleep: async () => {} });

	const first = await router.search("q", {});
	assert.equal(first.provider, "cleversee");

	for (let index = 0; index < 3; index += 1) {
		await assert.rejects(router.search("q", {}), (error) => error.kind === "local-throttle");
	}
	assert.ok(router.status().circuits.every((circuit) => circuit.state === "closed"));

	clock += 1_000;
	const recovered = await router.search("q", {});
	assert.equal(recovered.provider, "cleversee");
});

test("router fetch uses ReadPage basic by default", async () => {
	const modes = [];
	const providers = cleverseeOnly({
		fetchPage: async (url, options) => {
			modes.push(options.mode);
			return { provider: "cleversee", mode: options.mode, url, title: "T", content: "# T", meta: {} };
		},
	});
	const router = createRouter({ config: testConfig(), providers, now: () => 1_000, sleep: async () => {} });

	const result = await router.fetch("https://example.com/a", {});
	assert.deepEqual(modes, ["basic"]);
	assert.equal(result.meta.estimatedCostCny, 0.002);
});

test("router fetch tries the browser-rendered ReadPage when requested", async () => {
	const modes = [];
	const providers = cleverseeOnly({
		fetchPage: async (url, options) => {
			modes.push(options.mode);
			if (options.mode === "basic") throw errorOf("target", "4030");
			return { provider: "cleversee", mode: options.mode, url, title: "", content: "rendered", meta: {} };
		},
	});
	const router = createRouter({ config: testConfig(), providers, now: () => 1_000, sleep: async () => {} });

	const result = await router.fetch("https://example.com/a", { scrape: true });
	assert.deepEqual(modes, ["basic", "scrape"]);
	assert.equal(result.mode, "scrape");
	assert.equal(result.meta.estimatedCostCny, 0.01);
});

test("router fetch reports the last failure with both attempts", async () => {
	const providers = cleverseeOnly({
		fetchPage: async () => {
			throw errorOf("target", "4030", { status: 403 });
		},
	});
	const router = createRouter({ config: testConfig(), providers, now: () => 1_000, sleep: async () => {} });

	await assert.rejects(
		router.fetch("https://example.com/a", { scrape: true }),
		(error) => error.kind === "target" && error.attempts.length === 2 && error.attempts.every((attempt) => attempt.outcome === "error"),
	);
});
