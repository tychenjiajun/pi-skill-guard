// ── Mock pi ExtensionAPI fixture ───────────────────────────────────────────
// Stand-in for pi.on(…) so extension handler code can be exercised in tests
// without loading the real framework runtime.

/** Handler: (event, ctx) => void | Promise<void> */
export type MockHandler = (event: unknown, ctx: MockExtensionContext) => Promise<void> | void;

/** Subset of ExtensionContext needed by both pi-loop-guard and pi-skill-guard. */
export interface MockExtensionContext {
  ui: { notify(message: string, type?: string): void };
  cwd: string;
  signal: AbortSignal | undefined;
  abort(): void;
  sessionManager: {
    getEntries(): readonly unknown[];
    getBranch(): readonly unknown[];
  };
}

// ── Spy helpers ──────────────────────────────────────────────────────────────

export interface Spies {
  notified: string[];
  aborted: number;
  getEntriesCalls: number;
  getBranchCalls: number;
  sendUserMessageCalls: unknown[];
}

export function makeSpies(): Spies {
  return { notified: [], aborted: 0, getEntriesCalls: 0, getBranchCalls: 0, sendUserMessageCalls: [] };
}

// ── Core mock ─────────────────────────────────────────────────────────────────
/**
 * Drop-in for the `pi` parameter inside an extension factory function.
 *
 *   const pi = makeMockPi();
 *   myExtension(pi);            // pi.on() registers handlers
 *   await pi.fire(eventObj);    // replay event, await handler
 *   expect(pi.spies.notified).toContain("…");
 */

export type ReturnPi = {
  on(event: string, handler: MockHandler): void;
  fire(event: Record<string, unknown>): Promise<void>;
  spies: Spies;
  ctx: MockExtensionContext;
  reset(): void;
};

export interface MakeMockPiInput {
  spies?: Spies;
}

export function makeMockPi(input: MakeMockPiInput = {}): ReturnPi {
  const spies = input.spies ?? makeSpies();
  const sendUserMessageCalls: unknown[] = [];

  const ctx: MockExtensionContext = {
    ui: {
      notify(message: string, _type?: string) {
        spies.notified.push(message);
      },
    },
    cwd: "/mock-cwd",
    signal: undefined,
    abort() {
      spies.aborted++;
    },
    sessionManager: {
      getEntries() {
        spies.getEntriesCalls++;
        return [];
      },
      getBranch() {
        spies.getBranchCalls++;
        return [];
      },
    },
  };

  // Ordered handler slots mirror internal pi event bus ordering.
  const slots: { event: string; handler: MockHandler }[] = [];

  // ── build the returned object ────────────────────────────────────────────
  // start with the ReturnPi-typed structure and add sendUserMessage afterwards
  // so TypeScript (and runtime) both surface it on the same object.

  const apiSpy: ReturnPi = {
    on(event: string, handler: MockHandler) {
      slots.push({ event, handler });
    },

    async fire(event: Record<string, unknown>): Promise<void> {
      const handler = slots.find((s) => s.event === event.type)?.handler;
      if (handler) await handler(event, ctx);
    },

    spies,
    ctx,
    reset() {
      spies.notified.length = 0;
      spies.aborted = 0;
      spies.getEntriesCalls = 0;
      spies.getBranchCalls = 0;
      spies.sendUserMessageCalls.length = 0;
    },
  };

  // Attach sendUserMessage so handler-closure code like pi.sendUserMessage(...)
  // resolves at runtime.  Typed explicitly to avoid being dropped by a TS build.
  apiSpy.sendUserMessage = (
    content: unknown,
    opts?: unknown,
  ) => {
    spies.sendUserMessageCalls.push({ content, opts });
  };

  return apiSpy;
}
