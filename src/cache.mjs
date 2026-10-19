// 只缓存成功的 fetch 结果，避免对同一 URL 重复计费。
export function createCache({ ttlMs = 0, maxEntries = 100, now = Date.now } = {}) {
	const entries = new Map();

	return {
		get(key) {
			if (ttlMs <= 0) return null;
			const hit = entries.get(key);
			if (!hit) return null;
			if (now() - hit.at > ttlMs) {
				entries.delete(key);
				return null;
			}
			// LRU：命中后移到尾部。
			entries.delete(key);
			entries.set(key, hit);
			return hit.value;
		},
		set(key, value) {
			if (ttlMs <= 0) return;
			entries.delete(key);
			entries.set(key, { at: now(), value });
			while (entries.size > maxEntries) {
				entries.delete(entries.keys().next().value);
			}
		},
		clear() {
			entries.clear();
		},
		get size() {
			return entries.size;
		},
	};
}
