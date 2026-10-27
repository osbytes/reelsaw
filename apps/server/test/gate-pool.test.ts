import { test } from "node:test";
import assert from "node:assert/strict";
import { createProviderGate } from "../src/ai/gate.js";
import { createLogger } from "../src/log.js";

const log = createLogger({ LOG_LEVEL: "silent" });

test("the gate's pool is the sum of the limited providers' caps, 2..16", () => {
  // compat and openai default to 2 each (they may be self-hosted); nothing else is limited
  assert.equal(createProviderGate("", "compat", () => false, log).poolSize(), 4);
  assert.equal(createProviderGate("compat=1,openai=1", "compat", () => false, log).poolSize(), 2);
  assert.equal(createProviderGate("compat=1,openai=0", "compat", () => false, log).poolSize(), 2);
  assert.equal(createProviderGate("compat=8,openai=16,groq=4", "compat", () => false, log).poolSize(), 16);
});
