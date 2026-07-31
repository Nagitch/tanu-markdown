export class SerialTaskQueue<Key> {
  private readonly tails = new Map<Key, Promise<void>>();

  run(key: Key, task: () => Promise<void>): Promise<void> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    this.tails.set(key, current);
    return current.finally(() => {
      if (this.tails.get(key) === current) {
        this.tails.delete(key);
      }
    });
  }
}
