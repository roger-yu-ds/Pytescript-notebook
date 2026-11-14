// A minimal typed event emitter (no Node or VS Code dependency).

export type Listener<T> = (value: T) => void;

export class Emitter<T> {
  private listeners = new Set<Listener<T>>();

  /** Subscribe; returns an unsubscribe function. */
  on(listener: Listener<T>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  fire(value: T) {
    for (const l of [...this.listeners]) {
      try {
        l(value);
      } catch (e) {
        console.error("event listener failed", e);
      }
    }
  }

  clear() {
    this.listeners.clear();
  }
}
