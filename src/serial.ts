/** Serializes asynchronous operations by key while allowing unrelated keys to proceed independently. */
export class KeyedSerialQueue<Key> {
  readonly #tails = new Map<Key, Promise<void>>();

  run<Result>(key: Key, operation: () => Result | Promise<Result>): Promise<Result> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    const tail = current.then(
      () => undefined,
      () => undefined,
    );
    this.#tails.set(key, tail);
    return current.finally(() => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    });
  }
}
