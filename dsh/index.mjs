/**
 * DeepSeek Harness (DSH) plugin for Alibaba Cloud CleverSee (开析).
 *
 * The Pi package exposes two dedicated tools (`cleversee_search` /
 * `cleversee_fetch`). DSH already owns the model-facing web contract through
 * `ctx.web` + `web_search` / `web_fetch`, so this plugin registers CleverSee as
 * a search provider and a fetch provider instead of adding a second tool
 * vocabulary. The built-in tools then route to CleverSee, keeping DSH's
 * citations, truncation, timeout and error rendering unchanged.
 *
 * Zero runtime dependencies: the core client (`../src`) uses Node built-ins only.
 *
 * @module @dowanw0w/alibaba-cleversee/dsh
 */

import { createCleverSee } from "../src/index.mjs";

/** Cordis plugin name used by loader diagnostics. */
export const name = "web-cleversee";

/** The web seam this provider registers into. */
export const inject = ["web"];

const SEARCH_PROVIDER_ID = "cleversee";
const FETCH_PROVIDER_ID = "cleversee";
const DEFAULT_API_KEY_ENV = "CLEVERSEE_API_KEY";

/** Values the DSH launcher copied from the inherited env / `.env` layers. */
function launchEnvValue(ctx, key) {
	try {
		return ctx.get?.("launchEnvironment")?.get?.(key)?.value;
	} catch {
		return undefined;
	}
}

function resolveApiKey(ctx, settings) {
	if (settings.apiKey) return settings.apiKey;
	return launchEnvValue(ctx, settings.apiKeyEnv) || process.env[settings.apiKeyEnv] || "";
}

function toWebSource(item) {
	const source = { url: item.url };
	if (item.title) source.title = item.title;
	const snippet = item.snippet || item.summary || (item.content ? item.content.slice(0, 400) : "");
	if (snippet) source.snippet = snippet;
	if (item.publishedAt) source.publishedAt = String(item.publishedAt).slice(0, 32);
	return source;
}

/** Wrap an upstream failure in the seam's provider-error shape. */
function providerError(action, error) {
	const kind = typeof error?.kind === "string" && error.kind ? ` [${error.kind}]` : "";
	const wrapped = new Error(`CleverSee ${action} failed${kind}: ${error?.message ?? String(error)}`);
	wrapped.code = "WEB_PROVIDER_ERROR";
	wrapped.cause = error;
	return wrapped;
}

/**
 * Register both CleverSee providers with `ctx.web`.
 *
 * @param ctx - Cordis context carrying the `web` service.
 * @param config - `{ apiKey?, apiKeyEnv?, engine?, scrape?, fetch?, searchTimeoutMs? }`.
 */
export function apply(ctx, config = {}) {
	const settings = {
		apiKey: typeof config.apiKey === "string" ? config.apiKey.trim() : "",
		apiKeyEnv:
			typeof config.apiKeyEnv === "string" && config.apiKeyEnv.trim()
				? config.apiKeyEnv.trim()
				: DEFAULT_API_KEY_ENV,
		engine: typeof config.engine === "string" && config.engine.trim() ? config.engine.trim() : undefined,
		scrape: config.scrape === true,
		fetch: config.fetch !== false,
		searchTimeoutMs: Number.isInteger(config.searchTimeoutMs) ? config.searchTimeoutMs : undefined,
	};

	let client;
	const hasKey = () => resolveApiKey(ctx, settings).length > 0;

	/** Cheap local construction: one client per key/config, never per call. */
	const getClient = () => {
		const apiKey = resolveApiKey(ctx, settings);
		if (!apiKey) {
			const error = new Error(
				`CleverSee API key is not configured: set ${settings.apiKeyEnv} in the launching environment or ~/.dsh/.env`,
			);
			error.code = "WEB_PROVIDER_ERROR";
			throw error;
		}
		if (!client) {
			const env = { ...process.env, [settings.apiKeyEnv]: apiKey };
			if (settings.scrape) env.CLEVERSEE_SCRAPE = "1";
			client = createCleverSee({ env, engine: settings.engine });
		}
		return client;
	};

	ctx.web.registerSearchProvider({
		id: SEARCH_PROVIDER_ID,
		available: hasKey,
		async search(request, signal) {
			try {
				const response = await getClient().search(request.query, {
					count: request.maxResults ?? 8,
					timeoutMs: settings.searchTimeoutMs,
					signal,
				});
				return {
					sources: response.results.map(toWebSource),
					truncated: false,
				};
			} catch (error) {
				throw providerError("search", error);
			}
		},
	});

	if (settings.fetch) {
		ctx.web.registerFetchProvider({
			id: FETCH_PROVIDER_ID,
			available: hasKey,
			async fetch(request, signal) {
				try {
					const response = await getClient().fetch(request.url, {
						scrape: settings.scrape,
						signal,
					});
					return {
						url: response.url,
						statusCode: 200,
						body: { kind: "text", content: response.content },
						truncated: false,
					};
				} catch (error) {
					throw providerError("fetch", error);
				}
			},
		});
	}
}
