export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
  intervalMs = 5
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await sleep(intervalMs);
  }
  throw new Error("Condition was not met before timeout.");
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function uniqueChannel(prefix = "test"): string {
  return `${prefix}-${crypto.randomUUID()}`;
}
