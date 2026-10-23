import { runInDurableObject } from "cloudflare:test";
import { expect } from "vitest";

/** Poll the Session's alarm, starting the Session if it is not running, until it matches. */
export async function expectAlarm(stub: DurableObjectStub, expected: number | null): Promise<void> {
  let alarm: number | null | undefined;
  for (let attempt = 0; attempt < 200; attempt++) {
    alarm = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
    if (alarm === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(alarm).toBe(expected);
}
