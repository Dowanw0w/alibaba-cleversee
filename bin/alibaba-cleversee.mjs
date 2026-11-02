#!/usr/bin/env node
import { createCleverSee, ENGINES } from "../src/index.mjs";

const USAGE = `alibaba-cleversee — Aliyun CleverSee search/fetch

Usage:
  alibaba-cleversee search <query> [options]
  alibaba-cleversee fetch <url> [options]
  alibaba-cleversee status
  alibaba-cleversee doctor
  alibaba-cleversee help

Search options:
  -n, --count <1-50>        number of results (default 5)
      --recency <day|week|month|year>
      --include <domains>   comma-separated include list
      --exclude <domains>   comma-separated exclude list
      --content             request page text from the provider
      --engine <name>       CleverSee engine (${Object.keys(ENGINES).join(", ")})

Fetch options:
      --scrape              allow CleverSee browser-rendered fallback
      --refresh             bypass the in-process cache

Global:
      --json                print machine-readable JSON
`;

function splitList(value) {
	if (value === undefined) return undefined;
	return String(value)
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

function parseArgs(argv) {
	const args = [...argv];
	const command = args[0] === undefined || args[0].startsWith("-") ? "help" : args.shift();
	const flags = { _: [] };
	for (let index = 0; index < args.length; index += 1) {
		const token = args[index];
		if (!token.startsWith("-")) {
			flags._.push(token);
			continue;
		}
		const [name, inline] = token.split("=", 2);
		const take = () => {
			if (inline !== undefined) return inline;
			const next = args[index + 1];
			if (next === undefined || next.startsWith("-")) return true;
			index += 1;
			return next;
		};
		switch (name) {
			case "-n":
			case "--count":
				flags.count = Number(take());
				break;
			case "--recency":
				flags.recency = take();
				break;
			case "--include":
				flags.includeDomains = (flags.includeDomains ?? []).concat(splitList(take()));
				break;
			case "--exclude":
				flags.excludeDomains = (flags.excludeDomains ?? []).concat(splitList(take()));
				break;
			case "--content":
				flags.needContent = true;
				break;
			case "--scrape":
				flags.scrape = true;
				break;
			case "--refresh":
				flags.refresh = true;
				break;
			case "--engine":
				flags.engine = take();
				break;
			case "--json":
				flags.json = true;
				break;
			case "-h":
			case "--help":
				flags.help = true;
				break;
			default:
				throw new Error(`unknown flag: ${name}`);
		}
	}
	return { command, flags };
}

function formatSearchHuman(result) {
	const lines = [`provider: ${result.provider}`, `results: ${result.results.length}`, ""];
	result.results.forEach((item, index) => {
		lines.push(`${index + 1}. ${item.title}`);
		lines.push(`   ${item.url}`);
		if (item.snippet) lines.push(`   ${item.snippet}`);
		const facts = [];
		if (item.siteName) facts.push(item.siteName);
		if (item.publishedAt) facts.push(String(item.publishedAt).slice(0, 10));
		if (item.authority !== null) facts.push(`authority=${item.authority}`);
		if (item.score !== null) facts.push(`score=${Number(item.score).toFixed(3)}`);
		if (facts.length > 0) lines.push(`   [${facts.join(" · ")}]`);
		lines.push("");
	});
	const attempts = (result.meta?.attempts ?? []).map((attempt) => `${attempt.provider}=${attempt.outcome === "ok" ? "ok" : attempt.kind ?? attempt.outcome}`);
	if (attempts.length > 0) lines.push(`attempts: ${attempts.join(" → ")}`);
	return lines.join("\n").trim();
}

function formatFetchHuman(result) {
	return [
		`provider: ${result.provider}${result.mode ? `/${result.mode}` : ""}`,
		`url: ${result.url}`,
		result.title ? `title: ${result.title}` : null,
		`chars: ${result.content.length}`,
		result.meta?.cached ? "cached: true" : null,
		"---",
		result.content,
	]
		.filter((line) => line !== null)
		.join("\n");
}

async function main() {
	const { command, flags } = parseArgs(process.argv.slice(2));
	if (command === "help" || flags.help) {
		process.stdout.write(USAGE);
		return;
	}

	const client = createCleverSee({ engine: flags.engine });

	if (command === "status") {
		process.stdout.write(`${JSON.stringify(client.status(), null, 2)}\n`);
		return;
	}

	if (command === "doctor") {
		const started = Date.now();
		const result = await client.search("alibaba-cleversee doctor self test", { count: 1 });
		const first = result.results[0];
		const lines = [
			"alibaba-cleversee doctor",
			`provider: ${result.provider}`,
			`elapsed: ${Date.now() - started}ms`,
			`results: ${result.results.length}`,
			first ? `first: ${first.title} (${first.url})` : "first: -",
		];
		process.stdout.write(`${lines.join("\n")}\n`);
		return;
	}

	if (command === "search") {
		const query = flags._.join(" ").trim();
		if (!query) throw new Error("search requires a query");
		const result = await client.search(query, {
			count: flags.count,
			recency: flags.recency,
			includeDomains: flags.includeDomains,
			excludeDomains: flags.excludeDomains,
			needContent: flags.needContent,
		});
		process.stdout.write(flags.json ? `${JSON.stringify(result, null, 2)}\n` : `${formatSearchHuman(result)}\n`);
		return;
	}

	if (command === "fetch") {
		const url = flags._[0];
		if (!url) throw new Error("fetch requires a URL");
		const result = await client.fetch(url, {
			scrape: flags.scrape,
			refresh: flags.refresh,
		});
		process.stdout.write(flags.json ? `${JSON.stringify(result, null, 2)}\n` : `${formatFetchHuman(result)}\n`);
		return;
	}

	throw new Error(`unknown command: ${command}`);
}

main().catch((error) => {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`alibaba-cleversee: ${message}\n`);
	process.exitCode = 1;
});
