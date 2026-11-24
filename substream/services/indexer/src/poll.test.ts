import assert from "node:assert/strict";
import test from "node:test";

import { advanceCursor, collectPages, isCursorOutOfRangeError } from "./poll";

test("advanceCursor rejects missing, empty, and repeated cursors", () => {
  assert.equal(advanceCursor(undefined, "   "), undefined);
  assert.equal(advanceCursor("old", "old"), undefined);
  assert.equal(advanceCursor("old", "  new  "), "new");
  assert.equal(advanceCursor(undefined, undefined), undefined);
});

test("collectPages keeps the newest cursor on a short final page", async () => {
  const requests: Array<string | undefined> = [];
  const pages = [
    { events: [1, 2], cursor: "cursor-1" },
    { events: [3], cursor: "cursor-2" },
  ];

  const result = await collectPages(
    async (cursor) => {
      requests.push(cursor);
      return pages[requests.length - 1];
    },
    { pageSize: 2, maxPages: 10 },
  );

  assert.deepEqual(requests, [undefined, "cursor-1"]);
  assert.deepEqual(result.events, [1, 2, 3]);
  assert.equal(result.cursor, "cursor-2");
});

test("collectPages stops when a full page does not advance the cursor", async () => {
  let stalled = 0;
  const result = await collectPages(
    async () => ({ events: [1, 2], cursor: "same" }),
    {
      startCursor: "same",
      pageSize: 2,
      maxPages: 10,
      onStalled: () => {
        stalled += 1;
      },
    },
  );

  assert.deepEqual(result.events, [1, 2]);
  assert.equal(result.cursor, "same");
  assert.equal(stalled, 1);
});

test("only cursor-range errors trigger re-anchoring", () => {
  assert.equal(
    isCursorOutOfRangeError(new Error("cursor is outside the retention window")),
    true,
  );
  assert.equal(
    isCursorOutOfRangeError(new Error("invalid cursor")),
    true,
  );
  assert.equal(isCursorOutOfRangeError(new Error("RPC timeout")), false);
  assert.equal(isCursorOutOfRangeError(new Error("500 Internal Server Error")), false);
  assert.equal(isCursorOutOfRangeError(new Error("ledger cursor request failed")), false);
});
