import { describe, expect, it } from "vitest";
import { CommandOutbox } from "../src/client/command-outbox.ts";
import { KeyedSerialQueue } from "../src/serial.ts";

const create = (requestId: string) => ({ type: "conversation.create", requestId }) as const;

const prompt = (requestId: string) =>
  ({ type: "prompt.submit", requestId, conversationId: 1, content: "Hello" }) as const;

describe("multiplayer command recovery", () => {
  it("replays unacknowledged mutations with their original request IDs", () => {
    const outbox = new CommandOutbox();
    const promptResults: boolean[] = [];
    outbox.enqueue(create("create-1"));
    outbox.enqueue(prompt("prompt-1"), (accepted) => promptResults.push(accepted));

    const firstDelivery: string[] = [];
    outbox.replay(({ requestId }) => firstDelivery.push(requestId));
    const retryDelivery: string[] = [];
    outbox.replay(({ requestId }) => retryDelivery.push(requestId));

    expect(firstDelivery).toEqual(["create-1", "prompt-1"]);
    expect(retryDelivery).toEqual(firstDelivery);
    expect(promptResults).toEqual([]);

    expect(
      outbox.acknowledge({
        type: "command.result",
        command: "conversation.create",
        requestId: "create-1",
        ok: true,
        conversationId: 2,
      }),
    ).toEqual(create("create-1"));

    const remaining: string[] = [];
    outbox.replay(({ requestId }) => remaining.push(requestId));
    expect(remaining).toEqual(["prompt-1"]);

    expect(
      outbox.acknowledge({
        type: "command.result",
        command: "prompt.submit",
        requestId: "prompt-1",
        ok: false,
        error: { code: "rejected", message: "Rejected" },
      }),
    ).toEqual(prompt("prompt-1"));
    expect(promptResults).toEqual([false]);
    expect(outbox.has("prompt.submit")).toBe(false);
  });

  it("settles an outstanding prompt once when the client is disposed", () => {
    const outbox = new CommandOutbox();
    const results: boolean[] = [];
    outbox.enqueue(prompt("prompt-1"), (accepted) => results.push(accepted));

    outbox.clear();
    outbox.clear();

    expect(results).toEqual([false]);
    expect(outbox.has("prompt.submit")).toBe(false);
  });
});

describe("connection operation serialization", () => {
  it("runs operations for one connection in order without blocking another", async () => {
    const queue = new KeyedSerialQueue<object>();
    const firstConnection = {};
    const secondConnection = {};
    const release = Promise.withResolvers<void>();
    const order: string[] = [];

    const first = queue.run(firstConnection, async () => {
      order.push("first:start");
      await release.promise;
      order.push("first:end");
    });
    const second = queue.run(firstConnection, () => {
      order.push("second");
    });
    const independent = queue.run(secondConnection, () => {
      order.push("independent");
    });

    await independent;
    expect(order).toEqual(["first:start", "independent"]);

    release.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "independent", "first:end", "second"]);
  });

  it("continues a connection queue after an operation fails", async () => {
    const queue = new KeyedSerialQueue<object>();
    const connection = {};
    const failed = queue.run(connection, () => {
      throw new Error("failed");
    });
    const recovered = queue.run(connection, () => "recovered");

    await expect(failed).rejects.toThrow("failed");
    await expect(recovered).resolves.toBe("recovered");
  });
});
