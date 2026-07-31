export class SerialTaskQueue<Key> {
  private readonly tails = new Map<Key, Promise<void>>();

  run<Value>(key: Key, task: () => Promise<Value>): Promise<Value> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    return result.finally(() => {
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    });
  }
}
