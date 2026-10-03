import { InstallerError } from './limits.js';

/** Race even test transports that ignore AbortSignal; never retain an abort listener. */
export async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // A caller may already have started I/O before a synchronous abort. Observe its rejection.
    void promise.catch(() => undefined);
    throw new InstallerError(503, 'installer_unavailable');
  }
  let listener: () => void = () => undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    listener = () => reject(new InstallerError(503, 'installer_unavailable'));
    signal.addEventListener('abort', listener, { once: true });
  });
  try {
    return await Promise.race([promise, cancelled]);
  } finally {
    signal.removeEventListener('abort', listener);
  }
}

/** Counts actual chunks, not Content-Length. Stops and cancels on excess or cancellation. */
export async function readBounded(
  source: { body: ReadableStream<Uint8Array> | null; headers: Headers },
  maximum: number,
  signal: AbortSignal,
  status = 413,
): Promise<string> {
  const reader = source.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (signal.aborted) throw new InstallerError(503, 'installer_unavailable');
    if (Number(source.headers.get('content-length') ?? 0) > maximum) {
      throw new InstallerError(status, 'body_too_large');
    }
    if (!reader) return '';
    for (;;) {
      const part = await abortable(reader.read(), signal);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maximum) throw new InstallerError(status, 'body_too_large');
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
    } catch {
      throw new InstallerError(status === 413 ? 400 : status, 'invalid_utf8');
    }
  } finally {
    // Do not let a hostile stream's cancel implementation stall the request.
    if (reader) {
      void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}
