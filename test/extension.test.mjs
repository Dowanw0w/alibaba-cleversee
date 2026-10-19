import assert from "node:assert/strict";
import test from "node:test";
import { jsonResponse, scriptedFetch } from "./helpers.mjs";

process.env.DEEPSEEK_SEARCH_API_KEY = "test-deepseek-key";
process.env.CLEVERSEE_API_KEY = "test-cleversee-key";

globalThis.fetch = scriptedFetch((call) => {
	if (call.url.endsWith("/v1/tools/search")) {
		return jsonResponse({
			results: [{ title: "Multi Access", url: "https://example.com/multi", snippet: "snippet", summary: "summary", date: "2026-10-19T00:00:00Z", rerank_score: 2.5, authority: 3 }],
		});
	}
	if (call.url.endsWith("/v1/tools/fetch")) {
		return jsonResponse({ title: "Example", content: "# Example\n\nBody" });
	}
	throw new Error(`unexpected URL ${call.url}`);
});

const { default: multiAccessExtension, multiFetchTool, multiSearchTool } = await import("../extension/index.mjs");

test("extension registers two tools and one command", () => {
	const tools = [];
	const commands = [];
	multiAccessExtension({
		registerTool: (tool) => tools.push(tool),
		registerCommand: (name, config) => commands.push({ name, config }),
	});

	assert.deepEqual(tools.map((tool) => tool.name).sort(), ["multi_fetch", "multi_search"]);
	assert.equal(commands.length, 1);
	assert.equal(commands[0].name, "multi-access");

	const search = tools.find((tool) => tool.name === "multi_search");
	assert.deepEqual(search.parameters.required, ["query"]);
	assert.equal(search.annotations.readOnlyHint, true);
	assert.ok(search.promptGuidelines.length > 0);
});

test("multi_search executes DeepSeek and formats results", async () => {
	const result = await multiSearchTool.execute("call-1", { query: "multi access", count: 3 }, undefined);
	const text = result.content[0].text;
	assert.match(text, /multi-access · DeepSeek/);
	assert.match(text, /https:\/\/example\.com\/multi/);
	assert.equal(result.details.provider, "deepseek");
	assert.equal(result.details.results.length, 1);
	assert.equal(result.details.truncated, false);
});

test("multi_fetch executes DeepSeek and returns markdown", async () => {
	const result = await multiFetchTool.execute("call-2", { url: "https://example.com/multi" }, undefined);
	const text = result.content[0].text;
	assert.match(text, /multi-access · DeepSeek/);
	assert.match(text, /# Example/);
	assert.equal(result.details.provider, "deepseek");
});

test("command status and doctor use the same client", async () => {
	const tools = [];
	let command;
	multiAccessExtension({
		registerTool: (tool) => tools.push(tool),
		registerCommand: (name, config) => {
			command = { name, config };
		},
	});

	const messages = [];
	const ctx = { ui: { notify: (message, level) => messages.push({ message, level }) } };

	await command.config.handler("status", ctx);
	assert.match(messages[0].message, /multi-access status/);
	assert.match(messages[0].message, /deepseek: configured/);

	await command.config.handler("doctor", ctx);
	assert.match(messages.at(-1).message, /provider: deepseek/);

	await command.config.handler("clear-cache", ctx);
	assert.match(messages.at(-1).message, /cache cleared/);
});
