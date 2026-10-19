import { createMultiAccess } from "../src/index.mjs";

const MAX_SEARCH_CHARS = 36_000;
const MAX_FETCH_CHARS = 38_000;
const SNIPPET_CHARS = 400;

const client = createMultiAccess();

function providerOption(value) {
	return value && value !== "auto" ? value : undefined;
}

function attemptsLine(meta) {
	const attempts = meta?.attempts ?? [];
	if (attempts.length === 0) return "";
	return attempts
		.map((attempt) => {
			const detail = attempt.outcome === "ok" ? "ok" : attempt.kind ?? attempt.outcome;
			const mode = attempt.mode ? `/${attempt.mode}` : "";
			return `${attempt.provider}${mode}=${detail}`;
		})
		.join(" → ");
}

function costLabel(meta) {
	const cost = Number(meta?.estimatedCostCny);
	if (!Number.isFinite(cost) || cost <= 0) return "";
	return ` · ~¥${cost.toFixed(4)}`;
}

function truncateBlock(text, limit) {
	if (text.length <= limit) return { text, truncated: false, total: text.length };
	return {
		text: `${text.slice(0, limit)}\n\n[...truncated, ${text.length - limit} chars omitted]`,
		truncated: true,
		total: text.length,
	};
}

function formatSearch(response) {
	const { provider, results, meta } = response;
	const lines = [];
	const providerLabel = provider === "deepseek" ? "DeepSeek" : "CleverSee";
	const degraded = meta?.degraded ? "（降级）" : "";
	lines.push(`multi-access · ${providerLabel}${degraded} · ${results.length} results · ~¥${Number(meta?.estimatedCostCny ?? 0).toFixed(4)}`);
	const trail = attemptsLine(meta);
	if (trail) lines.push(`attempts: ${trail}`);
	lines.push("");

	results.forEach((result, index) => {
		lines.push(`${index + 1}. ${result.title}`);
		lines.push(`   ${result.url}`);
		if (result.snippet) lines.push(`   ${result.snippet.slice(0, SNIPPET_CHARS)}`);
		if (result.summary && result.summary !== result.snippet) {
			lines.push(`   summary: ${result.summary.slice(0, SNIPPET_CHARS)}`);
		}
		const facts = [];
		if (result.siteName) facts.push(result.siteName);
		if (result.publishedAt) facts.push(String(result.publishedAt).slice(0, 10));
		if (result.authority !== null && result.authority !== undefined) facts.push(`authority=${result.authority}`);
		if (result.score !== null && result.score !== undefined) facts.push(`score=${Number(result.score).toFixed(3)}`);
		if (facts.length > 0) lines.push(`   [${facts.join(" · ")}]`);
		if (result.content) lines.push(`   content: ${result.content.length} chars (use multi_fetch for full text)`);
		lines.push("");
	});

	const warnings = meta?.warnings ?? [];
	if (warnings.length > 0) lines.push(`warnings: ${warnings.join("; ")}`);

	const block = truncateBlock(lines.join("\n").trim(), MAX_SEARCH_CHARS);
	return block;
}

function formatFetch(response) {
	const providerLabel = response.provider === "deepseek" ? "DeepSeek" : `CleverSee ${response.mode ?? "basic"}`;
	const degraded = response.meta?.degraded ? "（降级）" : "";
	const head = [
		`multi-access · ${providerLabel}${degraded} · ${response.content.length} chars${costLabel(response.meta)}`,
		`url: ${response.url}`,
		response.title ? `title: ${response.title}` : null,
		response.meta?.cached ? "cached: true" : null,
		"---",
	].filter(Boolean);
	const body = truncateBlock(`${head.join("\n")}\n${response.content}`, MAX_FETCH_CHARS);
	return body;
}

export const multiSearchTool = {
	name: "multi_search",
	label: "Multi-Access Search",
	description:
		"Web search through DeepSeek first, with Aliyun CleverSee as fallback. DeepSeek supports site:/after: query operators; CleverSee adds Chinese-first sources and structured domain/time filters. Returns titles, URLs, snippets and metadata; use multi_fetch for full page text.",
	promptSnippet: "multi_search: DeepSeek-first web search with CleverSee fallback",
	promptGuidelines: [
		"Prefer multi_search for web searches. It routes DeepSeek first and falls back to CleverSee when DeepSeek errors or returns no results.",
		"Pass include_domains/exclude_domains or recency when you need site- or time-scoped results.",
	],
	parameters: {
		type: "object",
		properties: {
			query: { type: "string", description: "Search query. DeepSeek accepts up to 128 characters including generated operators." },
			count: { type: "integer", minimum: 1, maximum: 50, description: "Number of results (default 5)." },
			recency: { type: "string", enum: ["day", "week", "month", "year"], description: "Restrict to recently published pages." },
			include_domains: { type: "array", items: { type: "string" }, description: "Only return results from these domains." },
			exclude_domains: { type: "array", items: { type: "string" }, description: "Exclude results from these domains." },
			need_content: { type: "boolean", description: "Ask the provider to include page text. CleverSee mainText is capped near 3000 chars." },
			provider: { type: "string", enum: ["auto", "deepseek", "cleversee"], description: "Force a provider instead of the configured failover order." },
		},
		required: ["query"],
	},
	annotations: { readOnlyHint: true, openWorldHint: true },

	async execute(_toolCallId, params, signal) {
		const response = await client.search(params.query, {
			count: params.count ?? 5,
			recency: params.recency,
			includeDomains: params.include_domains,
			excludeDomains: params.exclude_domains,
			needContent: Boolean(params.need_content),
			provider: providerOption(params.provider),
			signal,
		});
		const block = formatSearch(response);
		return {
			content: [{ type: "text", text: block.text }],
			details: {
				provider: response.provider,
				results: response.results,
				meta: response.meta,
				truncated: block.truncated,
				totalChars: block.total,
			},
		};
	},
};

export const multiFetchTool = {
	name: "multi_fetch",
	label: "Multi-Access Fetch",
	description:
		"Fetch one web page and return Markdown. DeepSeek Fetch is tried first; Aliyun CleverSee ReadPage is the fallback (readpage covers static pages and, when enabled, browser-rendered pages). Successful fetches are cached briefly in-process.",
	promptSnippet: "multi_fetch: DeepSeek-first page fetch with CleverSee ReadPage fallback",
	promptGuidelines: ["Use multi_fetch when you already have a URL and need its readable content."],
	parameters: {
		type: "object",
		properties: {
			url: { type: "string", description: "HTTP(S) URL to fetch. Private/loopback hosts are refused unless explicitly allowed." },
			scrape: { type: "boolean", description: "Allow the CleverSee browser-rendered fallback (slower, higher cost)." },
			refresh: { type: "boolean", description: "Bypass the in-process cache." },
			provider: { type: "string", enum: ["auto", "deepseek", "cleversee"], description: "Force a provider instead of the configured failover order." },
		},
		required: ["url"],
	},
	annotations: { readOnlyHint: true, openWorldHint: true },

	async execute(_toolCallId, params, signal) {
		const response = await client.fetch(params.url, {
			scrape: params.scrape,
			refresh: params.refresh,
			provider: providerOption(params.provider),
			signal,
		});
		const block = formatFetch(response);
		return {
			content: [{ type: "text", text: block.text }],
			details: {
				provider: response.provider,
				url: response.url,
				title: response.title,
				meta: response.meta,
				truncated: block.truncated,
				totalChars: block.total,
			},
		};
	},
};

function formatStatus(status) {
	const lines = ["multi-access status", `order: ${status.order.join(" → ")}`, `cleversee engine: ${status.engine}`];
	for (const [name, info] of Object.entries(status.providers)) {
		lines.push(`${name}: ${info.configured ? "configured" : "MISSING KEY"}`);
	}
	if (status.circuits.length > 0) {
		lines.push("circuits:");
		for (const circuit of status.circuits) {
			const retry = circuit.retryInMs ? ` retryIn=${Math.ceil(circuit.retryInMs / 1000)}s` : "";
			lines.push(`  ${circuit.provider}:${circuit.capability}${circuit.mode ? `/${circuit.mode}` : ""} ${circuit.state}${retry}`);
		}
	}
	lines.push(`cache: ${status.cache.entries} entries / ttl ${status.cache.ttlSeconds}s`);
	lines.push(`strictAuth: ${status.reads.strictAuth} · allowPrivate: ${status.reads.allowPrivate} · scrape: ${status.reads.cleverseeScrape}`);
	return lines.join("\n");
}

async function runDoctor() {
	const started = Date.now();
	const response = await client.search("multi-access doctor self test", { count: 1, needContent: false });
	const elapsed = Date.now() - started;
	const first = response.results[0];
	return [
		`multi-access doctor`,
		`provider: ${response.provider}`,
		`elapsed: ${elapsed}ms`,
		`results: ${response.results.length}`,
		first ? `first: ${first.title} (${first.url})` : "first: -",
		`attempts: ${attemptsLine(response.meta) || "-"}`,
	].join("\n");
}

export default function multiAccessExtension(pi) {
	pi.registerTool(multiSearchTool);
	pi.registerTool(multiFetchTool);

	pi.registerCommand("multi-access", {
		description: "Multi-access status, doctor, or cache control (DeepSeek + CleverSee)",
		handler: async (args, ctx) => {
			const command = String(args ?? "").trim().split(/\s+/)[0] || "status";
			const notify = (message, level = "info") => {
				if (ctx?.ui?.notify) ctx.ui.notify(message, level);
			};
			try {
				if (command === "status") {
					notify(formatStatus(client.status()));
					return;
				}
				if (command === "doctor") {
					notify(await runDoctor());
					return;
				}
				if (command === "clear-cache") {
					client.clearCache();
					notify("multi-access cache cleared");
					return;
				}
				notify("usage: /multi-access status | doctor | clear-cache", "warning");
			} catch (error) {
				notify(`multi-access ${command} failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
