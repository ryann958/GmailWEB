import assert from "node:assert/strict";
import test from "node:test";
import { generateRandomText, GENERATED_TEXT_PATTERN } from "../generations.js";

test("generated text has a random alphanumeric prefix and the required suffix", () => {
  for (let index = 0; index < 100; index += 1) {
    const value = generateRandomText();
    const [prefix, suffix] = value.split("@");
    assert.match(value, GENERATED_TEXT_PATTERN);
    assert.match(prefix, /^[A-Za-z0-9]{20}$/);
    assert.match(prefix, /[A-Za-z]/);
    assert.match(prefix, /\d/);
    assert.equal(suffix, "ryann.com");
  }
});
