/**
 * AsyncMutex ensures operations against the shared Shufersal browser session
 * execute sequentially even when multiple group members send messages simultaneously.
 */
export class AsyncMutex {
  private queue: Promise<void> = Promise.resolve();
  private pendingCount = 0;

  get pending(): number {
    return this.pendingCount;
  }

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    this.pendingCount++;
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });

    const previous = this.queue;
    this.queue = previous.then(() => next);

    await previous;
    try {
      return await fn();
    } finally {
      this.pendingCount--;
      release();
    }
  }
}
