import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";

test("loadConfig defaults to CNLiteBasic with CleverSee as the only provider", () => {
	const config = loadConfig({ CLEVERSEE_API_KEY: "c" });
	assert.equal(config.engine, "CNLiteBasic");
	assert.deepEqual(config.providerOrder, ["cleversee"]);
	assert.equal(config.cleversee.apiKey, "c");
	assert.equal(config.cleversee.engine, "CNLiteBasic");
	assert.equal(config.allowPrivate, false);
});

test("loadConfig rejects unknown engines", () => {
	assert.throws(() => loadConfig({ MULTI_ACCESS_ENGINE: "Turbo" }), (error) => error.kind === "config");
});

test("loadConfig propagates the engine into the CleverSee provider config", () => {
	const config = loadConfig({ MULTI_ACCESS_ENGINE: "CNAuto" });
	assert.equal(config.engine, "CNAuto");
	assert.equal(config.cleversee.engine, "CNAuto");
	assert.equal(config.engineInfo.maxResults, 10);
});

test("loadConfig validates numeric settings", () => {
	assert.throws(() => loadConfig({ MULTI_ACCESS_CACHE_TTL: "-1" }), (error) => error.kind === "config");
	assert.throws(() => loadConfig({ MULTI_ACCESS_CLEVERSEE_QPS: "zero" }), (error) => error.kind === "config");
	assert.throws(() => loadConfig({ MULTI_ACCESS_LIMITER_MAX_WAIT_MS: "1.5" }), (error) => error.kind === "config");
});

test("loadConfig exposes engine capabilities", () => {
	const config = loadConfig({ MULTI_ACCESS_ENGINE: "GenericAdvanced" });
	assert.equal(config.engineInfo.maxResults, 80);
	assert.equal(config.engineInfo.siteFilters, false);
});
