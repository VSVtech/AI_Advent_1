// Bounded FIFO admission queue. Only running jobs occupy an Ollama slot.
export class GenerationQueue {
  active = 0;
  waiting = [];

  constructor({ concurrency, queueCapacity, queueTimeoutMs }) {
    this.concurrency = concurrency;
    this.capacity = queueCapacity;
    this.timeoutMs = queueTimeoutMs;
  }

  acquire(signal) {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.active < this.concurrency) {
      this.active++;
      return Promise.resolve(this.releaseOnce());
    }
    if (this.waiting.length >= this.capacity)
      return Promise.reject(
        Object.assign(new Error('Очередь заполнена. Повторите запрос позже.'), {
          code: 'queue_full',
          status: 429,
        }),
      );
    return new Promise((resolve, reject) => {
      const entry = { resolve, cleanup: () => {} };
      const remove = (error) => {
        const index = this.waiting.indexOf(entry);
        if (index < 0) return;
        this.waiting.splice(index, 1);
        entry.cleanup();
        reject(error);
      };
      const cancelled = () => remove(signal.reason);
      const timer = setTimeout(
        () =>
          remove(
            Object.assign(
              new Error(
                'Истекло время ожидания в очереди. Повторите запрос позже.',
              ),
              { code: 'queue_timeout', status: 504 },
            ),
          ),
        this.timeoutMs,
      );
      timer.unref?.();
      entry.cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancelled);
      };
      this.waiting.push(entry);
      signal.addEventListener('abort', cancelled, { once: true });
    });
  }

  releaseOnce() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      const next = this.waiting.shift();
      if (next) {
        next.cleanup();
        this.active++;
        next.resolve(this.releaseOnce());
      }
    };
  }
}
