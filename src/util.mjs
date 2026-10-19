import { MultiAccessError } from "./errors.mjs";

export function textOneLine(value) {
	return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

export function textBlock(value) {
	if (typeof value !== "string") return "";
	return value.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim();
}

export function truncate(text, limit) {
	const value = String(text ?? "");
	if (value.length <= limit) return value;
	return `${value.slice(0, Math.max(0, limit))}\n\n[...truncated ${value.length - limit} chars]`;
}

export function clamp(value, min, max) {
	const number = Number(value);
	if (!Number.isFinite(number)) return min;
	return Math.min(max, Math.max(min, Math.trunc(number)));
}

export function dedupe(values) {
	const seen = new Set();
	const out = [];
	for (const value of values) {
		if (!value || seen.has(value)) continue;
		seen.add(value);
		out.push(value);
	}
	return out;
}

// 域名归一化：去掉协议、路径、端口、通配前缀；保留子域名。
export function normalizeDomain(value) {
	let domain = String(value ?? "").trim().toLowerCase();
	if (!domain) return "";
	domain = domain.replace(/^-+/, "");
	domain = domain.replace(/^https?:\/\//, "").replace(/^\/\//, "");
	domain = domain.split(/[/?#]/)[0];
	domain = domain.replace(/:\d+$/, "");
	domain = domain.replace(/^\*\./, "").replace(/\.$/, "");
	if (!domain || /\s/.test(domain)) return "";
	return domain;
}

export function isoDaysAgo(days, now = Date.now()) {
	return new Date(now - days * 86_400_000).toISOString().slice(0, 10);
}

const PRIVATE_HOST_PATTERNS = [
	/^localhost$/i,
	/\.localhost$/i,
	/^127\./,
	/^10\./,
	/^192\.168\./,
	/^172\.(1[6-9]|2\d|3[01])\./,
	/^169\.254\./,
	/^0\.0\.0\.0$/,
	/^\[?::1\]?$/,
	/^\[?f[cd][0-9a-f]{2}:/i,
];

export function isPrivateHost(hostname) {
	const host = String(hostname ?? "").toLowerCase();
	if (!host) return true;
	if (host === "metadata.google.internal") return true;
	return PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(host));
}

// Fetch 入口的唯一 URL 校验：只允许 http(s)，禁止 URL 内凭据；
// 默认拒绝回环/私网/链路本地地址，内网调试可显式开启 MULTI_ACCESS_ALLOW_PRIVATE=1。
export function assertFetchableUrl(raw, { allowPrivate = false } = {}) {
	let url;
	try {
		url = new URL(String(raw ?? "").trim());
	} catch {
		throw new MultiAccessError(`invalid URL: ${JSON.stringify(String(raw ?? "").slice(0, 200))}`, { kind: "invalid" });
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new MultiAccessError(`unsupported URL scheme "${url.protocol}" (only http/https)`, { kind: "invalid" });
	}
	if (url.username || url.password) {
		throw new MultiAccessError("URL must not contain credentials", { kind: "invalid" });
	}
	if (!allowPrivate && isPrivateHost(url.hostname)) {
		throw new MultiAccessError(`refusing to fetch private or loopback host "${url.hostname}" (set MULTI_ACCESS_ALLOW_PRIVATE=1 to override)`, { kind: "invalid" });
	}
	return url.href;
}

export function redactSecret(text, secret) {
	if (!secret || typeof text !== "string") return text;
	return text.split(secret).join("[redacted]");
}

export function defaultSleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
