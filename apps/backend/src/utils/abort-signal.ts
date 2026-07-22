export interface DisposableAbortSignal {
  signal: AbortSignal;
  cleanup: () => void;
}

export function createTimeoutAbortSignal(
  timeoutMs: number,
  parentSignal?: AbortSignal,
): DisposableAbortSignal {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException('Request timed out', 'TimeoutError')),
    Math.max(1, timeoutMs),
  );
  timeout.unref?.();

  const abortFromParent = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  }

  let cleanedUp = false;
  return {
    signal: controller.signal,
    cleanup: () => {
      if (cleanedUp) return;
      cleanedUp = true;
      clearTimeout(timeout);
      parentSignal?.removeEventListener('abort', abortFromParent);
    },
  };
}

export async function raceWithAbortSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
