/** Per-canonical-map in-process serialization for decisions and cache mutations. */
class MapDecisionBoundary {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly active = new Set<string>();

  async run<T>(mapId: string, operation: () => T | Promise<T>): Promise<T> {
    const previous = this.tails.get(mapId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.tails.set(mapId, tail);
    await previous.catch(() => undefined);
    this.active.add(mapId);
    try {
      return await operation();
    } finally {
      this.active.delete(mapId);
      release();
      if (this.tails.get(mapId) === tail) this.tails.delete(mapId);
    }
  }

  runSync<T>(mapId: string, operation: () => T): { acquired: true; value: T } | { acquired: false } {
    if (this.tails.has(mapId) || this.active.has(mapId)) return { acquired: false };
    this.active.add(mapId);
    try {
      return { acquired: true, value: operation() };
    } finally {
      this.active.delete(mapId);
    }
  }

  runManySync<T>(mapIds: string[], operation: () => T): { acquired: true; value: T } | { acquired: false } {
    const ids = [...new Set(mapIds)].sort();
    if (ids.some(id => this.tails.has(id) || this.active.has(id))) return { acquired: false };
    for (const id of ids) this.active.add(id);
    try {
      return { acquired: true, value: operation() };
    } finally {
      for (const id of ids) this.active.delete(id);
    }
  }
}

export const mapDecisionBoundary = new MapDecisionBoundary();
