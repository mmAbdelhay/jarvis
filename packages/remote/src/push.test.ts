import { describe, expect, it, vi } from "vitest";
import { fakeClock } from "./clock-double.js";
import {
  buildExpoRequests,
  createPushSender,
  EXPO_PUSH_BATCH,
  EXPO_PUSH_URL,
  EXPO_RECEIPTS_URL,
  MAX_PUSHES_PER_TOKEN_PER_MINUTE,
  parseExpoReceipts,
  parseExpoTickets,
  PUSH_FLUSH_MS,
  PUSH_QUEUE_MAX,
  RECEIPT_DELAY_MS,
  sendExpoPush,
} from "./push.js";
import type { ExpoPushMessage, FetchLike } from "./push.js";

const TOKEN = "ExponentPushToken[pushTokenaaaaaaaa1111]";

function tokenFor(n: number): string {
  return `ExponentPushToken[t${String(n).padStart(8, "0")}aaaaaaaa]`;
}

function message(n = 0, to = TOKEN): ExpoPushMessage {
  return {
    to,
    title: `title-${n}`,
    body: `body-${n}`,
    data: { kind: "session-done" },
    sound: "default",
    priority: "high",
    channelId: "jarvis",
    ttl: 1_800,
  };
}

function response(status: number, json: unknown): Awaited<ReturnType<FetchLike>> {
  return { status, json: async () => json };
}

/**
 * Task 6 (M10 T2 deferred): the fixed three-`Promise.resolve()` hop this
 * used to be was really a guess at exactly how deep the fetch -> `.json()`
 * -> ticket/receipt processing -> next-timer-arming chain nests — correct
 * only by coincidence for whichever call shape the guess was tuned
 * against, and silently wrong (or over-generous) for any other. `fetch`
 * itself is the one real async boundary in that chain (`deps.timers` is
 * the injected fake clock, so arming the next retry/receipt timer is a
 * synchronous side effect of a resolved promise's continuation, never a
 * real wait); a single hop past the real event loop's macrotask boundary
 * — `setImmediate`, which Node guarantees never runs until the *entire*
 * microtask queue (including whatever `fetch`'s mocked promise settled and
 * chained) has drained — waits for exactly that chain to finish, however
 * deep it turns out to be, with no fixed hop count to get wrong.
 */
async function drain(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("Expo push helpers", () => {
  it(
    "buildExpoRequests chunks 250 messages in order and skips an empty input " +
      "[bite-proof: send all 250 as one request instead of chunking at EXPO_PUSH_BATCH]",
    () => {
      const messages = Array.from({ length: 250 }, (_, index) => message(index, tokenFor(index)));
      const requests = buildExpoRequests(messages);

      expect(requests).toHaveLength(3);
      expect(requests.map((request) => JSON.parse(request.body).length)).toEqual([100, 100, 50]);
      expect(
        requests.flatMap((request) =>
          JSON.parse(request.body).map((item: ExpoPushMessage) => item.to),
        ),
      ).toEqual(messages.map((item) => item.to));
      expect(requests.every((request) => request.url === EXPO_PUSH_URL)).toBe(true);
      expect(EXPO_PUSH_BATCH).toBe(100);
      expect(buildExpoRequests([])).toEqual([]);
    },
  );

  it("parses only a complete valid ticket envelope", () => {
    expect(
      parseExpoTickets(
        {
          data: [
            { status: "ok", id: "a" },
            { status: "error", details: { error: "DeviceNotRegistered" } },
          ],
        },
        2,
      ),
    ).toEqual([
      { status: "ok", id: "a" },
      { status: "error", error: "DeviceNotRegistered" },
    ]);
    expect(parseExpoTickets({ data: [{ status: "ok", id: "a" }] }, 2)).toBeUndefined();
    expect(parseExpoTickets({ data: {} }, 1)).toBeUndefined();
  });

  it("parses valid receipts while skipping malformed entries", () => {
    expect(
      parseExpoReceipts({
        data: {
          a: { status: "ok" },
          b: { status: "error", details: { error: "DeviceNotRegistered" } },
          broken: { status: "unknown" },
        },
      }),
    ).toEqual(
      new Map([
        ["a", { status: "ok" }],
        ["b", { status: "error", error: "DeviceNotRegistered" }],
      ]),
    );
  });
});

describe("sendExpoPush", () => {
  it(
    "posts the expected payload with an abortable signal, without logging message content or its token " +
      "[bite-proof: drop the AbortSignal from the push request]",
    async () => {
      const logs: string[] = [];
      const fetch = vi
        .fn<FetchLike>()
        .mockResolvedValue(response(200, { data: [{ status: "ok", id: "id-1" }] }));
      const one = message();

      await expect(sendExpoPush([one], { fetch, log: (line) => logs.push(line) })).resolves.toEqual(
        {
          tickets: [{ status: "ok", id: "id-1" }],
          unregistered: [],
          retryable: false,
        },
      );
      expect(fetch).toHaveBeenCalledWith(
        EXPO_PUSH_URL,
        expect.objectContaining({
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify([one]),
          signal: expect.any(AbortSignal),
        }),
      );
      expect(logs.join("\n")).not.toContain(one.to);
      expect(logs.join("\n")).not.toContain(one.title);
      expect(logs.join("\n")).not.toContain(one.body);
    },
  );

  it("keeps successful chunks when a later chunk must retry", async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(
        response(200, {
          data: Array.from({ length: 100 }, (_, index) => ({ status: "ok", id: `id-${index}` })),
        }),
      )
      .mockResolvedValueOnce(response(429, {}));

    const outcome = await sendExpoPush(
      Array.from({ length: 101 }, (_, index) => message(index)),
      { fetch, log: () => undefined },
    );

    expect(outcome.retryable).toBe(true);
    expect(outcome.tickets).toHaveLength(100);
    expect(outcome.tickets[0]).toEqual({ status: "ok", id: "id-0" });
  });

  it("marks transport, request-level, and DeviceNotRegistered outcomes correctly", async () => {
    const rejected = vi.fn<FetchLike>().mockRejectedValue(new Error("token must stay private"));
    await expect(
      sendExpoPush([message()], { fetch: rejected, log: () => undefined }),
    ).resolves.toMatchObject({
      retryable: true,
      tickets: [],
    });

    const requestError = vi
      .fn<FetchLike>()
      .mockResolvedValue(response(200, { errors: [{ code: "busy" }] }));
    await expect(
      sendExpoPush([message()], { fetch: requestError, log: () => undefined }),
    ).resolves.toMatchObject({
      retryable: true,
      tickets: [],
    });

    const notRegistered = vi
      .fn<FetchLike>()
      .mockResolvedValue(
        response(200, { data: [{ status: "error", details: { error: "DeviceNotRegistered" } }] }),
      );
    await expect(
      sendExpoPush([message()], { fetch: notRegistered, log: () => undefined }),
    ).resolves.toMatchObject({
      retryable: false,
      unregistered: [TOKEN],
    });
  });

  it("treats a non-429 4xx errors body as terminal and logs one count-only sent line", async () => {
    const logs: string[] = [];
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValue(response(400, { errors: [{ code: "bad" }] }));

    await expect(
      sendExpoPush([message()], { fetch, log: (line) => logs.push(line) }),
    ).resolves.toEqual({
      tickets: [{ status: "error", error: undefined }],
      unregistered: [],
      retryable: false,
    });
    expect(logs).toEqual(["push: sent batch=0 n=1 ok=0 errors=1"]);
  });

  it("synthesizes one terminal error ticket per message when a 4xx errors body is shorter", async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValue(response(400, { errors: [{ code: "bad" }] }));

    await expect(
      sendExpoPush([message(0), message(1)], { fetch, log: () => undefined }),
    ).resolves.toEqual({
      tickets: [
        { status: "error", error: undefined },
        { status: "error", error: undefined },
      ],
      unregistered: [],
      retryable: false,
    });
  });
});

describe("createPushSender", () => {
  it("batches queued messages, rate limits a token, and bounds the queue", async () => {
    const clock = fakeClock();
    const fetch = vi.fn<FetchLike>().mockResolvedValue(response(200, { data: [] }));
    const sender = createPushSender({
      fetch,
      now: clock.now,
      timers: clock.timers,
      log: () => undefined,
      onUnregistered: () => undefined,
    });

    expect(sender.enqueue(message(1))).toBe("queued");
    expect(sender.enqueue(message(2))).toBe("queued");
    clock.advance(PUSH_FLUSH_MS);
    await drain();
    expect(JSON.parse(fetch.mock.calls[0]?.[1].body ?? "[]")).toHaveLength(2);
    expect(fetch.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);

    for (let index = 0; index < MAX_PUSHES_PER_TOKEN_PER_MINUTE; index++)
      sender.enqueue(message(index, "ExponentPushToken[rateTokenaaaaaaaa1111]"));
    expect(sender.enqueue(message(7, "ExponentPushToken[rateTokenaaaaaaaa1111]"))).toBe(
      "dropped-rate",
    );
    clock.advance(60_001);
    expect(sender.enqueue(message(8, "ExponentPushToken[rateTokenaaaaaaaa1111]"))).toBe("queued");

    const bounded = createPushSender({
      fetch,
      now: clock.now,
      timers: clock.timers,
      log: () => undefined,
      onUnregistered: () => undefined,
    });
    for (let index = 0; index < PUSH_QUEUE_MAX; index++)
      expect(
        bounded.enqueue(
          message(index, `ExponentPushToken[q${String(index).padStart(8, "0")}abcd]`),
        ),
      ).toBe("queued");
    expect(bounded.enqueue(message(201, "ExponentPushToken[overflowaaaaaaaa1111]"))).toBe(
      "dropped-full",
    );
  });

  it(
    "retries only the failed chunk, records successful partial outcomes, and drops after exactly three failed " +
      "sends [bite-proof: retry the whole batch, including the chunk that already got tickets]",
    async () => {
      const clock = fakeClock();
      const fetch = vi
        .fn<FetchLike>()
        .mockResolvedValueOnce(
          response(200, {
            data: Array.from({ length: 100 }, (_, index) => ({ status: "ok", id: `ok-${index}` })),
          }),
        )
        .mockResolvedValueOnce(response(429, {}))
        .mockResolvedValueOnce(response(429, {}))
        .mockResolvedValueOnce(response(429, {}));
      const sender = createPushSender({
        fetch,
        now: clock.now,
        timers: clock.timers,
        log: () => undefined,
        onUnregistered: () => undefined,
      });
      for (let index = 0; index < 101; index++)
        sender.enqueue(
          message(index, `ExponentPushToken[part${String(index).padStart(8, "0")}aaaa]`),
        );

      clock.advance(PUSH_FLUSH_MS);
      await drain();
      expect(fetch).toHaveBeenCalledTimes(2);
      // PUSH_RETRY_DELAYS_MS has exactly two entries (1_000, 4_000): the
      // failed chunk is retried once at each, for three sends total, then
      // dropped — no entry goes unused. The final, larger advance below is
      // a defensive margin, not a needed one now that `drain()` waits for
      // the real microtask queue to empty rather than a fixed hop count.
      clock.advance(1_000);
      await drain();
      clock.advance(4_000);
      await drain();
      clock.advance(16_000);
      await drain();

      expect(fetch).toHaveBeenCalledTimes(4);
      // Only the failed 1-message chunk is ever retried — never the whole
      // 101-message batch, which would re-send tickets the first chunk
      // already received.
      expect(JSON.parse(fetch.mock.calls[2]?.[1].body ?? "[]")).toHaveLength(1);
      expect(fetch.mock.calls[2]?.[1].signal).toBeInstanceOf(AbortSignal);
      expect(clock.pending()).toBe(1); // the successful first chunk's receipt timer survives retries
    },
  );

  it(
    "clears DeviceNotRegistered tokens from tickets and receipts, then makes stop terminal " +
      "[bite-proof: fetch receipts from the push URL, or with the ticket ids missing from the body]",
    async () => {
      const clock = fakeClock();
      const unregistered = vi.fn();
      const fetch = vi
        .fn<FetchLike>()
        .mockResolvedValueOnce(
          response(200, {
            data: [
              { status: "error", details: { error: "DeviceNotRegistered" } },
              { status: "ok", id: "receipt-id" },
            ],
          }),
        )
        .mockResolvedValueOnce(
          response(200, {
            data: { "receipt-id": { status: "error", details: { error: "DeviceNotRegistered" } } },
          }),
        );
      const sender = createPushSender({
        fetch,
        now: clock.now,
        timers: clock.timers,
        log: () => undefined,
        onUnregistered: unregistered,
      });

      sender.enqueue(message(1));
      sender.enqueue(message(2, "ExponentPushToken[receiptTokenaaaaaaa1111]"));
      clock.advance(PUSH_FLUSH_MS);
      await drain();
      expect(unregistered).toHaveBeenCalledWith(TOKEN);
      clock.advance(RECEIPT_DELAY_MS);
      await drain();
      expect(unregistered).toHaveBeenCalledWith("ExponentPushToken[receiptTokenaaaaaaa1111]");
      expect(fetch).toHaveBeenCalledWith(
        EXPO_RECEIPTS_URL,
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ ids: ["receipt-id"] }),
          signal: expect.any(AbortSignal),
        }),
      );

      sender.stop();
      expect(sender.enqueue(message(3))).toBe("dropped-full");
      expect(sender.pending()).toBe(0);
      expect(clock.pending()).toBe(0);
    },
  );

  it(
    "does not re-arm a retry after stop, and contains a throwing clear callback " +
      "[bite-proof: re-arm the retry timer after stop() has already fired]",
    async () => {
      const clock = fakeClock();
      const logs: string[] = [];
      const fetch = vi
        .fn<FetchLike>()
        .mockResolvedValueOnce(response(429, {}))
        .mockResolvedValueOnce(
          response(200, { data: [{ status: "error", details: { error: "DeviceNotRegistered" } }] }),
        );
      const sender = createPushSender({
        fetch,
        now: clock.now,
        timers: clock.timers,
        log: (line) => logs.push(line),
        onUnregistered: () => {
          throw new Error(TOKEN);
        },
      });

      sender.enqueue(message());
      clock.advance(PUSH_FLUSH_MS);
      await drain();
      sender.stop();
      clock.advance(16_000);
      await drain();
      // "once" upgraded to a full calledWith: not just that a second (re-armed)
      // request never went out, but that the one request that did was the
      // expected one.
      expect(fetch).toHaveBeenCalledWith(
        EXPO_PUSH_URL,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(clock.pending()).toBe(0);

      const clearSender = createPushSender({
        fetch,
        now: clock.now,
        timers: clock.timers,
        log: (line) => logs.push(line),
        onUnregistered: () => {
          throw new Error(TOKEN);
        },
      });
      await clearSender.flush();
      clearSender.enqueue(message());
      clock.advance(PUSH_FLUSH_MS);
      await drain();
      expect(logs.join("\n")).toContain("onUnregistered threw");
      expect(logs.join("\n")).not.toContain(TOKEN);
    },
  );
});
