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
	assert.throws(() => loadConfig({ CLEVERSEE_ENGINE: "Turbo" }), (error) => error.kind === "config");
});

test("loadConfig propagates the engine into the CleverSee provider config", () => {
	const config = loadConfig({ CLEVERSEE_ENGINE: "CNAuto" });
	assert.equal(config.engine, "CNAuto");
	assert.equal(config.cleversee.engine, "CNAuto");
	assert.equal(config.engineInfo.maxResults, 10);
});

test("loadConfig validates numeric settings", () => {
	assert.throws(() => loadConfig({ CLEVERSEE_CACHE_TTL: "-1" }), (error) => error.kind === "config");
	assert.throws(() => loadConfig({ CLEVERSEE_QPS: "zero" }), (error) => error.kind === "config");
	assert.throws(() => loadConfig({ CLEVERSEE_LIMITER_MAX_WAIT_MS: "1.5" }), (error) => error.kind === "config");
});

test("loadConfig exposes engine capabilities", () => {
	const config = loadConfig({ CLEVERSEE_ENGINE: "GenericAdvanced" });
	assert.equal(config.engineInfo.maxResults, 80);
	assert.equal(config.engineInfo.siteFilters, false);
});

test("loadConfig sizes the client timeout above the upstream page budget", () => {
	const config = loadConfig({ CLEVERSEE_API_KEY: "c" });
	assert.equal(config.cleversee.pageTimeoutMs, 20_000);
	assert.equal(config.cleversee.readPageTimeoutMs, 25_000);
	assert.equal(config.cleversee.scrapeTimeoutMs, 30_000);
	assert.equal(config.cleversee.fetchRetries, 1);
});

test("loadConfig allows raising the page budget and disabling retries", () => {
	const config = loadConfig({ CLEVERSEE_API_KEY: "c", CLEVERSEE_PAGE_TIMEOUT_MS: "45000", CLEVERSEE_FETCH_RETRIES: "0" });
	assert.equal(config.cleversee.pageTimeoutMs, 45_000);
	assert.equal(config.cleversee.readPageTimeoutMs, 50_000);
	assert.equal(config.cleversee.scrapeTimeoutMs, 55_000);
	assert.equal(config.cleversee.fetchRetries, 0);
});

test("loadConfig rejects an out-of-range page budget", () => {
	assert.throws(() => loadConfig({ CLEVERSEE_PAGE_TIMEOUT_MS: "999" }), (error) => error.kind === "config");
	assert.throws(() => loadConfig({ CLEVERSEE_PAGE_TIMEOUT_MS: "0" }), (error) => error.kind === "config");
});
