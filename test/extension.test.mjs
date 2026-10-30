import assert from "node:assert/strict";
import test from "node:test";
import { jsonResponse, scriptedFetch } from "./helpers.mjs";

process.env.CLEVERSEE_API_KEY = "test-cleversee-key";

globalThis.fetch = scriptedFetch((call) => {
	if (call.url.endsWith("/search/unified")) {
		return jsonResponse({
			pageItems: [
				{
					title: "Multi Access",
					link: "https://example.com/multi",
					snippet: "snippet",
					mainText: "body",
					publishedTime: "2026-10-19T00:00:00+08:00",
					rerankScore: 2.5,
					websiteAuthorityScore: 3,
				},
			],
			requestId: "req-1",
		});
	}
	if (call.url.endsWith("/readpage/basic")) {
		return jsonResponse({ requestId: "rp-1", errorCode: null, data: { statusCode: 200, markdown: "# Example\n\nBody", metadata: { title: "Example" } } });
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
	assert.equal(search.parameters.properties.provider, undefined);
	assert.equal(search.annotations.readOnlyHint, true);
	assert.ok(search.promptGuidelines.length > 0);
});

test("multi_search executes CleverSee and formats results", async () => {
	const result = await multiSearchTool.execute("call-1", { query: "multi access", count: 3 }, undefined);
	const text = result.content[0].text;
	assert.match(text, /multi-access · CleverSee CNLiteBasic/);
	assert.match(text, /https:\/\/example\.com\/multi/);
	assert.equal(result.details.provider, "cleversee");
	assert.equal(result.details.results.length, 1);
	assert.equal(result.details.truncated, false);
});

test("multi_fetch executes ReadPage and returns markdown", async () => {
	const result = await multiFetchTool.execute("call-2", { url: "https://example.com/multi" }, undefined);
	const text = result.content[0].text;
	assert.match(text, /multi-access · CleverSee basic/);
	assert.match(text, /# Example/);
	assert.equal(result.details.provider, "cleversee");
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
	assert.match(messages[0].message, /cleversee: configured/);

	await command.config.handler("doctor", ctx);
	assert.match(messages.at(-1).message, /provider: cleversee/);

	await command.config.handler("clear-cache", ctx);
	assert.match(messages.at(-1).message, /cache cleared/);
});
