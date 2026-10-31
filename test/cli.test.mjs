import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const BIN = new URL("../bin/alibaba-cleversee.mjs", import.meta.url).pathname;

function run(args) {
	return spawnSync(process.execPath, [BIN, ...args], {
		encoding: "utf8",
		env: { ...process.env, CLEVERSEE_API_KEY: "test-cleversee-key" },
	});
}

for (const args of [["help"], ["--help"], ["-h"]]) {
	test(`cli prints usage for ${args.join(" ")}`, () => {
		const result = run(args);
		assert.equal(result.status, 0);
		assert.match(result.stdout, /Usage:/);
	});
}

test("cli rejects unknown commands with a non-zero exit", () => {
	const result = run(["nope"]);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /unknown command: nope/);
});
