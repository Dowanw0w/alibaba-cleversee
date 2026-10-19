import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";

test("loadConfig defaults to CNLiteBasic and deepseek-first order", () => {
	const config = loadConfig({ DEEPSEEK_SEARCH_API_KEY: "d", CLEVERSEE_API_KEY: "c" });
	assert.equal(config.engine, "CNLiteBasic");
	assert.deepEqual(config.providerOrder, ["deepseek", "cleversee"]);
	assert.equal(config.deepseek.apiKey, "d");
	assert.equal(config.cleversee.apiKey, "c");
	assert.equal(config.strictAuth, false);
});

test("loadConfig accepts DEEPSEEK_API_KEY as a fallback", () => {
	const config = loadConfig({ DEEPSEEK_API_KEY: "fallback" });
	assert.equal(config.deepseek.apiKey, "fallback");
});

test("loadConfig rejects unknown engines and providers", () => {
	assert.throws(() => loadConfig({ MULTI_ACCESS_ENGINE: "Turbo" }), (error) => error.kind === "config");
	assert.throws(() => loadConfig({ MULTI_ACCESS_ORDER: "deepseek,bing" }), (error) => error.kind === "config");
});

test("loadConfig supports disabling a provider", () => {
	const config = loadConfig({ MULTI_ACCESS_DISABLE_DEEPSEEK: "1" });
	assert.deepEqual(config.providerOrder, ["cleversee"]);
});

test("loadConfig validates numeric settings", () => {
	assert.throws(() => loadConfig({ MULTI_ACCESS_CACHE_TTL: "-1" }), (error) => error.kind === "config");
	assert.throws(() => loadConfig({ MULTI_ACCESS_DEEPSEEK_QPS: "zero" }), (error) => error.kind === "config");
});

test("loadConfig exposes engine capabilities", () => {
	const config = loadConfig({ MULTI_ACCESS_ENGINE: "GenericAdvanced" });
	assert.equal(config.engineInfo.maxResults, 80);
	assert.equal(config.engineInfo.siteFilters, false);
});
