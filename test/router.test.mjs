import assert from "node:assert/strict";
import test from "node:test";
import { createRouter } from "../src/router.mjs";
import { errorOf, fakeProvider, sampleResult, testConfig } from "./helpers.mjs";

function searchOk(provider, items = [sampleResult()]) {
	return async () => ({ provider, engine: provider === "cleversee" ? "CNLiteBasic" : undefined, results: items, meta: {} });
}

test("router falls back after a payment error", async () => {
	const deepseek = fakeProvider("deepseek", {
		search: async () => {
			throw errorOf("payment", "insufficient balance", { status: 402 });
		},
	});
	const cleversee = fakeProvider("cleversee", { search: searchOk("cleversee") });
	const router = createRouter({ config: testConfig(), providers: { deepseek, cleversee }, now: () => 1_000, sleep: async () => {} });

	const result = await router.search("q", {});
	assert.equal(result.provider, "cleversee");
	assert.equal(result.meta.degraded, false);
	assert.equal(result.meta.attempts[0].kind, "payment");
	assert.ok(result.meta.estimatedCostCny > 0);
});

test("router falls back when the first provider returns zero results", async () => {
	const deepseek = fakeProvider("deepseek", { search: searchOk("deepseek", []) });
	const cleversee = fakeProvider("cleversee", { search: searchOk("cleversee") });
	const router = createRouter({ config: testConfig(), providers: { deepseek, cleversee }, now: () => 1_000, sleep: async () => {} });

	const result = await router.search("q", {});
	assert.equal(result.provider, "cleversee");
	assert.equal(result.meta.attempts[0].outcome, "empty");
});

test("router reports an empty error when every provider returns zero results", async () => {
	const deepseek = fakeProvider("deepseek", { search: searchOk("deepseek", []) });
	const cleversee = fakeProvider("cleversee", { search: searchOk("cleversee", []) });
	const router = createRouter({ config: testConfig(), providers: { deepseek, cleversee }, now: () => 1_000, sleep: async () => {} });

	await assert.rejects(
		router.search("q", {}),
		(error) => error.kind === "empty" && error.attempts.length === 2 && error.attempts.every((attempt) => attempt.outcome === "empty"),
	);
});

test("strict auth mode stops on 401 instead of falling back", async () => {
	let cleverseeCalls = 0;
	const deepseek = fakeProvider("deepseek", {
		search: async () => {
			throw errorOf("auth", "bad key", { status: 401 });
		},
	});
	const cleversee = fakeProvider("cleversee", {
		search: async () => {
			cleverseeCalls += 1;
			return searchOk("cleversee")();
		},
	});
	const router = createRouter({
		config: testConfig({ MULTI_ACCESS_STRICT_AUTH: "1" }),
		providers: { deepseek, cleversee },
		now: () => 1_000,
		sleep: async () => {},
	});

	await assert.rejects(router.search("q", {}), (error) => error.kind === "auth");
	assert.equal(cleverseeCalls, 0);
});

test("non-strict auth mode falls back and marks the result degraded", async () => {
	const deepseek = fakeProvider("deepseek", {
		search: async () => {
			throw errorOf("auth", "bad key", { status: 401 });
		},
	});
	const cleversee = fakeProvider("cleversee", { search: searchOk("cleversee") });
	const router = createRouter({ config: testConfig(), providers: { deepseek, cleversee }, now: () => 1_000, sleep: async () => {} });

	const result = await router.search("q", {});
	assert.equal(result.provider, "cleversee");
	assert.equal(result.meta.degraded, true);
});

test("breaker opens after consecutive failures and half-opens after cooldown", async () => {
	let clock = 1_000;
	let calls = 0;
	const deepseek = fakeProvider("deepseek", {
		search: async () => {
			calls += 1;
			throw errorOf("transient", "boom", { status: 500 });
		},
	});
	const config = testConfig({
		MULTI_ACCESS_DISABLE_CLEVERSEE: "1",
		MULTI_ACCESS_BREAKER_THRESHOLD: "2",
		MULTI_ACCESS_BREAKER_COOLDOWN_MS: "1000",
	});
	const router = createRouter({ config, providers: { deepseek }, now: () => clock, sleep: async () => {} });

	await assert.rejects(router.search("q", {}));
	await assert.rejects(router.search("q", {}));
	assert.equal(calls, 2);

	await assert.rejects(
		router.search("q", {}),
		(error) => error.attempts.some((attempt) => attempt.outcome === "circuit-open"),
	);
	assert.equal(calls, 2);

	clock += 1_001;
	deepseek.search = searchOk("deepseek");
	const result = await router.search("q", {});
	assert.equal(result.provider, "deepseek");
	assert.equal(calls, 2);
});

test("explicit provider skips the failover chain", async () => {
	let cleverseeCalls = 0;
	const deepseek = fakeProvider("deepseek", { search: searchOk("deepseek") });
	const cleversee = fakeProvider("cleversee", {
		search: async () => {
			cleverseeCalls += 1;
			return searchOk("cleversee")();
		},
	});
	const router = createRouter({ config: testConfig(), providers: { deepseek, cleversee }, now: () => 1_000, sleep: async () => {} });

	const result = await router.search("q", { provider: "deepseek" });
	assert.equal(result.provider, "deepseek");
	assert.equal(cleverseeCalls, 0);
});

test("router fetch falls back from DeepSeek to CleverSee ReadPage", async () => {
	const modes = [];
	const deepseek = fakeProvider("deepseek", {
		fetchPage: async () => {
			throw errorOf("target", "404", { status: 404 });
		},
	});
	const cleversee = fakeProvider("cleversee", {
		fetchPage: async (url, options) => {
			modes.push(options.mode);
			return { provider: "cleversee", mode: options.mode, url, title: "T", content: "# T", meta: {} };
		},
	});
	const router = createRouter({ config: testConfig(), providers: { deepseek, cleversee }, now: () => 1_000, sleep: async () => {} });

	const result = await router.fetch("https://example.com/a", {});
	assert.equal(result.provider, "cleversee");
	assert.deepEqual(modes, ["basic"]);
	assert.equal(result.meta.attempts[0].kind, "target");
});

test("router fetch tries the browser-rendered ReadPage when requested", async () => {
	const modes = [];
	const deepseek = fakeProvider("deepseek", {
		fetchPage: async () => {
			throw errorOf("target", "403", { status: 403 });
		},
	});
	const cleversee = fakeProvider("cleversee", {
		fetchPage: async (url, options) => {
			modes.push(options.mode);
			if (options.mode === "basic") throw errorOf("target", "4030");
			return { provider: "cleversee", mode: options.mode, url, title: "", content: "rendered", meta: {} };
		},
	});
	const router = createRouter({ config: testConfig(), providers: { deepseek, cleversee }, now: () => 1_000, sleep: async () => {} });

	const result = await router.fetch("https://example.com/a", { scrape: true });
	assert.deepEqual(modes, ["basic", "scrape"]);
	assert.equal(result.mode, "scrape");
	assert.equal(result.meta.estimatedCostCny, 0.01);
});

test("router fetch aggregates failures", async () => {
	const deepseek = fakeProvider("deepseek", {
		fetchPage: async () => {
			throw errorOf("target", "404", { status: 404 });
		},
	});
	const cleversee = fakeProvider("cleversee", {
		fetchPage: async () => {
			throw errorOf("target", "4030", { status: 403 });
		},
	});
	const router = createRouter({ config: testConfig(), providers: { deepseek, cleversee }, now: () => 1_000, sleep: async () => {} });

	await assert.rejects(
		router.fetch("https://example.com/a", {}),
		(error) => error.kind === "target" && error.attempts.length === 2,
	);
});
