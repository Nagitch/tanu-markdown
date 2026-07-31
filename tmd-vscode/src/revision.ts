export class ClientRevisionTracker<T extends object> {
  private readonly revisions = new WeakMap<T, number>();

  latest(client: T): number {
    return this.revisions.get(client) ?? 0;
  }

  accept(client: T, revision: number): boolean {
    if (revision <= this.latest(client)) {
      return false;
    }
    this.revisions.set(client, revision);
    return true;
  }

  reset(client: T): void {
    this.revisions.delete(client);
  }
}
