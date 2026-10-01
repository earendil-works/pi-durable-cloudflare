import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, InboxDoc, MemoryStorage } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { queuedInputs } from "../src/protocol.ts";

const context = BACKGROUND_CONTEXT;

describe("queued prompts", () => {
  it("queues input submitted during a running turn and answers it afterwards", async () => {
    const firstStarted = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const slowFirst: FauxResponseStep = async () => {
      firstStarted.resolve();
      await releaseFirst.promise;
      return fauxAssistantMessage([fauxText("First answer.")]);
    };
    const faux = fauxProvider();
    faux.setResponses([slowFirst, fauxAssistantMessage([fauxText("Second answer.")])]);
    const models = createModels();
    models.setProvider(faux.provider);
    const harness = await Harness.open(
      new MemoryStorage(),
      { models, registry: createRegistry() },
      context,
    );

    try {
      const root = await harness.root(context);
      await root.configure({ model: { provider: "faux", modelId: "faux-1" } }, context);
      const first = await root.submit(
        { type: "input", content: "First question", whenBusy: "followUp" },
        context,
      );
      await firstStarted.promise;

      const second = await root.submit(
        { type: "input", content: "Second question", whenBusy: "followUp" },
        context,
      );
      expect(queuedInputs(await harness.snapshot(InboxDoc, root.id, context))).toEqual([
        { submissionId: second.id, mode: "followUp", text: "Second question" },
      ]);

      releaseFirst.resolve();
      await expect(first.wait(context)).resolves.toMatchObject({ status: "done" });
      await expect(second.wait(context)).resolves.toMatchObject({ status: "done" });
      expect(queuedInputs(await harness.snapshot(InboxDoc, root.id, context))).toEqual([]);
    } finally {
      releaseFirst.resolve();
      await harness.close(context);
    }
  });
});
