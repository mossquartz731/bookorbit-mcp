import { LRUCache } from "lru-cache";
import type { ParsedBook } from "./types.js";

/** An operation owns this snapshot even when another request evicts its cache entry. */
export interface BookSnapshot {
  readonly parsed: ParsedBook;
  readonly texts: readonly string[];
}

/** Derived text only. Native LRU eviction bounds retention without a second disk store. */
export class BookCache {
  private readonly entries: LRUCache<string, BookSnapshot>;

  constructor(maxBytes = 64 * 1024 * 1024) {
    this.entries = new LRUCache({
      maxSize: maxBytes,
      sizeCalculation: ({ parsed, texts }) =>
        Math.max(
          1,
          256 +
            2 * JSON.stringify(parsed).length +
            texts.reduce((n, text) => n + 2 * text.length, 0),
        ),
    });
  }

  get(key: string): BookSnapshot | undefined {
    return this.entries.get(key);
  }

  store(key: string, parsed: ParsedBook, texts: readonly string[]): BookSnapshot {
    const snapshot = Object.freeze({
      parsed: Object.freeze({
        ...parsed,
        requiresOcrPages: parsed.requiresOcrPages
          ? Object.freeze([...parsed.requiresOcrPages])
          : undefined,
        sections: Object.freeze(
          parsed.sections.map((section) => Object.freeze({ ...section })),
        ),
      }),
      texts: Object.freeze([...texts]),
    });
    this.entries.set(key, snapshot);
    // Oversized snapshots remain usable by the caller even when the LRU declines them.
    return snapshot;
  }
}
