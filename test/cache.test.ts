import { test } from "node:test";
import assert from "node:assert/strict";
import { BookCache } from "../src/cache.js";

const parsed = {
  bookId: 1,
  title: "Book",
  author: "Author",
  sections: [],
  totalChars: 1500,
};

test("bounded LRU evicts UTF-16 text without invalidating an operation's snapshot", () => {
  const cache = new BookCache(4000);
  const text = "é".repeat(1500);
  const first = cache.store("one", parsed, [text]);
  assert.strictEqual(cache.get("one"), first);
  cache.store("two", parsed, [text]);
  assert.equal(cache.get("one"), undefined);
  assert.equal(first.texts[0], text);
  assert.throws(() => {
    (first.texts as string[])[0] = "tamper";
  }, TypeError);
  const oversized = cache.store("large", parsed, ["x".repeat(5000)]);
  assert.equal(cache.get("large"), undefined);
  assert.equal(oversized.texts[0].length, 5000);
});
