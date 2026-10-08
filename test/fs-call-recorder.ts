/**
 * Filesystem call recording for the tests that check how a file is published, not
 * merely what it ends up containing.
 *
 * The guarantees worth pinning down here are about sequence rather than result: the
 * target is never opened for writing, the temporary file is renamed in from the same
 * directory, and a failed write leaves the previous bytes in place. Asserting on
 * recorded calls is what separates an in-place truncating write from a rename into
 * place without depending on the scheduler, and it is why the recorder writes through
 * to the real filesystem before injecting a failure -- a failure raised before the
 * target is touched would let a truncating writer pass.
 *
 * Vitest hoists `vi.mock` above a test file's imports, so a test file creates its
 * control object inside `vi.hoisted` and pulls this module in with a dynamic import
 * from inside the mock factory. The instrumentation lives here so that "published
 * safely" has one definition: two copies would drift in exactly the details the
 * guarantees turn on, such as which calls are recorded and when the failure lands.
 */

export interface FsCalls {
  /** When set, the next write throws once it has gone through to the filesystem. */
  failNextWrite: boolean;
  /** Every path passed to `writeFileSync`, in call order. */
  openedForWrite: string[];
  /** Every `renameSync`, as [from, to], in call order. */
  renames: Array<[string, string]>;
}

/**
 * Wrap the real `node:fs` so `writeFileSync` and `renameSync` report their arguments
 * before performing them. Everything else passes through unchanged, so a test that
 * also reads, lists, or unlinks is exercising the real filesystem.
 */
export function instrumentNodeFs(
  control: FsCalls,
  actual: typeof import("node:fs"),
): Partial<typeof import("node:fs")> {
  return {
    ...actual,
    writeFileSync: ((...args: Parameters<typeof actual.writeFileSync>) => {
      const target = typeof args[0] === "string" ? args[0] : String(args[0]);
      control.openedForWrite.push(target);
      (actual.writeFileSync as (...a: unknown[]) => void)(...args);
      if (control.failNextWrite) {
        control.failNextWrite = false;
        throw new Error("simulated write failure");
      }
    }) as typeof actual.writeFileSync,
    renameSync: ((...args: Parameters<typeof actual.renameSync>) => {
      control.renames.push([String(args[0]), String(args[1])]);
      return (actual.renameSync as (...a: unknown[]) => void)(...args);
    }) as typeof actual.renameSync,
  };
}
