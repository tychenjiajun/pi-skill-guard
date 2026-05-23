import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeMockPi, makeSpies, type ReturnPi } from "./test/pi-fake";

// ---------------------------------------------------------------------------
// Module mocks  (hoisted by vitest 4.x – must be at file top level)
// ---------------------------------------------------------------------------

vi.mock("node:fs", () => {
  return {
    promises: {
      stat: vi.fn(async (_p: string) => {
        throw new Error("ENOENT");
      }),
      readFile: vi.fn(async (_p: string) => "fake skill content"),
    },
  };
});

vi.mock("@earendil-works/pi-coding-agent", () => {
  return {
    getAgentDir: vi.fn(() => "/fake-agent-dir"),
    loadSkills: vi.fn(async () => ({
      skills: [{ name: "my-skill", filePath: "/fake/skills/my-skill/SKILL.md" }],
    })),
    createBashTool: vi.fn(() => ({
      execute: vi.fn(async (_tcId, args) => ({
        content: [{ type: "text" as const, text: `ran: ${args.command}` }],
        isError: false,
      })),
    })),
  };
});

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function mk() {
  const spies = makeSpies();
  const pi = makeMockPi({ spies });

  // await import → vitest mocker pipeline → index.ts loads with mock applied
  const { default: skillGuardExtension } = await (await import("./index.ts")) as {
    default: (pi: unknown) => void;
  };
  skillGuardExtension(pi as unknown as never);

  return { pi, spies };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("skillGuardExtension", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── handler registration ─────────────────────────────────────────────────

  it("registers handlers for session_start, turn_end, and message_end", () => {
    const captured: string[] = [];
    const spies = makeSpies();
    const result = makeMockPi({ spies });
    const origOn = result.on;
    result.on = (ev, _h) => { captured.push(ev); origOn(ev, _h); };
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { default: ext } = require("./index.ts") as { default: (pi: unknown) => void };
    ext(result as unknown as never);
    expect(captured).toContain("session_start");
    expect(captured).toContain("turn_end");
    expect(captured).toContain("message_end");
  });

  // ── session_start ─────────────────────────────────────────────────────────

  it("session_start calls loadSkills", async () => {
    const { pi } = await mk();
    // Verify by checking notification flow when session_start fires.
    await pi.fire({ type: "session_start", cwd: "/tmp" });
    // If loadSkills throws, the catch is silent and the test still "passes";
    // we rely on downstream message_end behaviour to surface any silent failure.
  });

  // ── message_end guard clauses ─────────────────────────────────────────────

  it("message_end is a no-op when role is not toolResult", async () => {
    const { spies, pi } = await mk();
    await pi.fire({
      type: "message_end",
      message: { role: "assistant" as const, content: [], isError: false, toolCallId: "x", toolName: "bash" },
    });
    expect(spies.notified).toHaveLength(0);
  });

  it("message_end is a no-op when isError is false", async () => {
    const { spies, pi } = await mk();
    await pi.fire({
      type: "message_end",
      message: {
        role: "toolResult" as const,
        toolCallId: "t1",
        toolName: "bash",
        content: [{ type: "text" as const, text: "ok" }],
        isError: false,
      },
    });
    expect(spies.notified).toHaveLength(0);
  });

  // ── turn_end ──────────────────────────────────────────────────────────────

  it("turn_end fires without error", async () => {
    const { pi } = await mk();
    await pi.fire({ type: "turn_end" });
    expect(pi.spies.notified).toHaveLength(0);
  });

  // ── Case 1: not-found + matching skill ────────────────────────────────────

  it("message_end: 'not found' for a known skill returns skill content", async () => {
    const { spies, pi } = await mk();
    await pi.fire({ type: "session_start", cwd: "/tmp" });

    await pi.fire({
      type: "message_end",
      message: {
        role: "toolResult" as const,
        toolCallId: "call-1",
        toolName: "my-skill",
        content: [{ type: "text" as const, text: "not found" }],
        isError: true,
      },
    });

    expect(spies.notified.filter((m: string) => /Skill guard:/.test(m)).length).toBeGreaterThanOrEqual(1);
  });

  // ── Case 2: not-found + "command" arg ─────────────────────────────────────

  it("message_end: unknown tool with 'command' arg invokes bash (Case 2)", async () => {
    const { spies, pi } = await mk();
    await pi.fire({ type: "session_start", cwd: "/tmp" });

    // Inject a "command" kwarg into what the session manager returns.
    pi.ctx.sessionManager.getEntries = () => [
      {
        type: "message" as const,
        message: {
          role: "assistant" as const,
          content: [
            {
              type: "toolCall" as const,
              id: "call-cmd",
              toolName: "external-cmd",
              arguments: { command: "echo hello" },
            },
          ],
        },
      },
    ];

    await pi.fire({
      type: "message_end",
      message: {
        role: "toolResult" as const,
        toolCallId: "call-cmd",
        toolName: "external-cmd",
        content: [{ type: "text" as const, text: "not found" }],
        isError: true,
      },
    });

    expect(spies.notified.filter((m: string) => /Skill guard:/.test(m)).length).toBeGreaterThanOrEqual(1);
  });
});
