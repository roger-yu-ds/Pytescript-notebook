// A tiny test harness for the extension host (no mocha needed).

type Fn = () => Promise<void> | void;
const tests: { name: string; fn: Fn; timeout: number }[] = [];

export function test(name: string, fn: Fn, timeout = 120_000) {
  tests.push({ name, fn, timeout });
}

export async function runAll(): Promise<void> {
  let failed = 0;
  for (const t of tests) {
    const started = Date.now();
    try {
      await Promise.race([
        Promise.resolve().then(t.fn),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${t.timeout} ms`)), t.timeout)),
      ]);
      console.log(`✓ ${t.name} (${Date.now() - started} ms)`);
    } catch (e) {
      failed++;
      console.log(`✗ ${t.name}\n    ${String((e as Error)?.stack ?? e).split("\n").slice(0, 6).join("\n    ")}`);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} extension tests passed${failed ? "" : " ✅"}`);
  if (failed) throw new Error(`${failed} extension test(s) failed`);
}

/** Poll until `f` returns a truthy value. */
export async function until<T>(f: () => T | Promise<T>, what: string, ms = 60_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  let last: T | undefined;
  while (Date.now() < end) {
    last = await f();
    if (last) return last as NonNullable<T>;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${what}`);
}
