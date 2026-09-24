import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Storage } from "@earendil-works/pi-durable";
import {
  STORAGE_READ_BENCHMARKS,
  STORAGE_WRITE_BENCHMARKS,
  seedStorageBenchmark,
  seedStorageWriteBenchmark,
} from "@earendil-works/pi-durable/testing";
import { bench, describe } from "vitest";

const BACKEND_NAME = "Cloudflare Durable Object SQLite";
const READ_OPTIONS = {
  time: 300,
  iterations: 10,
  warmupTime: 75,
  warmupIterations: 3,
} as const;
const WRITE_OPTIONS = {
  time: 0,
  iterations: 20,
  warmupTime: 0,
  warmupIterations: 5,
} as const;

type SessionStub = ReturnType<typeof env.SESSIONS.get>;

function createStub(): SessionStub {
  return env.SESSIONS.get(env.SESSIONS.newUniqueId());
}

async function useStorage<T>(stub: SessionStub, use: (storage: Storage) => Promise<T>): Promise<T> {
  return runInDurableObject(stub, async (instance) => use(await instance.storage));
}

function assertResult(name: string, actual: number, expected: number): void {
  if (actual !== expected) {
    throw new Error(`${name} returned ${actual}; expected ${expected}`);
  }
}

const readStub = createStub();
const readDataset = await useStorage(readStub, (storage) => seedStorageBenchmark(storage));

for (const scenario of STORAGE_READ_BENCHMARKS) {
  const result = await useStorage(readStub, (storage) => scenario.run(storage, readDataset));
  assertResult(scenario.name, result, scenario.expected(readDataset));

  describe(scenario.name, () => {
    bench(
      BACKEND_NAME,
      async () => {
        await useStorage(readStub, (storage) => scenario.run(storage, readDataset));
      },
      READ_OPTIONS,
    );
  });
}

async function createWriteFixture(): Promise<SessionStub> {
  const stub = createStub();
  await useStorage(stub, seedStorageWriteBenchmark);
  return stub;
}

for (const scenario of STORAGE_WRITE_BENCHMARKS) {
  const validation = await createWriteFixture();
  const result = await useStorage(validation, scenario.run);
  assertResult(scenario.name, result, scenario.expected);

  const pool: SessionStub[] = [];
  for (let index = 0; index < WRITE_OPTIONS.iterations + WRITE_OPTIONS.warmupIterations; index++) {
    pool.push(await createWriteFixture());
  }
  describe(scenario.name, () => {
    bench(
      BACKEND_NAME,
      async () => {
        const stub = pool.shift();
        if (stub === undefined) throw new Error(`Fixture pool for ${scenario.name} was exhausted`);
        await useStorage(stub, scenario.run);
      },
      WRITE_OPTIONS,
    );
  });
}
