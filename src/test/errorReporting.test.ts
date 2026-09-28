import { describe, expect, it, vi } from "vitest";
import {
  createErrorDeduper,
  describeError,
  ERROR_MESSAGE_MAX_LENGTH,
  errorFromMainReport,
  REDACTED,
  scrubErrorMessage,
  scrubErrorText,
  scrubEventProperties,
} from "@/lib/errorReporting";
import { createMainErrorReporter, type MainErrorTarget } from "../../electron/errorReporter";

describe("scrubErrorText", () => {
  it("replaces home directories on macOS, Linux and Windows", () => {
    expect(scrubErrorText("ENOENT: open '/Users/oscar/BloxBot/opencode.json'")).toBe(
      "ENOENT: open '~/BloxBot/opencode.json'",
    );
    expect(scrubErrorText("at /home/jane/app/index.js:1:2")).toBe("at ~/app/index.js:1:2");
    expect(scrubErrorText("EPERM C:\\Users\\Jane Doe\\AppData\\Local\\x")).toBe(
      "EPERM ~\\AppData\\Local\\x",
    );
    expect(scrubErrorText("path C:\\Users\\jdoe\\BloxBot")).toBe("path ~\\BloxBot");
    expect(scrubErrorText('{"path":"C:\\\\Users\\\\jdoe\\\\BloxBot"}')).toBe(
      '{"path":"~\\\\BloxBot"}',
    );
    expect(scrubErrorText("EPERM C:/Users/Jane Doe/AppData/x")).toBe("EPERM ~/AppData/x");
    expect(scrubErrorText("profile at C:\\Users\\Jane Doe")).toBe("profile at ~");
    expect(scrubErrorText("profile at C:/Users/Jane Doe")).toBe("profile at ~");
    expect(scrubErrorText("file:///Users/oscar/app.asar/index.js")).toBe(
      "file://~/app.asar/index.js",
    );
  });

  it("masks the username wherever else it appears", () => {
    expect(scrubErrorText("/Users/oscar/x failed for oscar@laptop")).toBe(
      "~/x failed for <user>@laptop",
    );
    expect(scrubErrorText("login oscar rejected", { username: "oscar" })).toBe(
      "login <user> rejected",
    );
  });

  it("replaces a known home directory", () => {
    expect(scrubErrorText("/opt/homes/os/BloxBot missing", { home: "/opt/homes/os" })).toBe(
      "~/BloxBot missing",
    );
  });

  it("redacts numeric credential values but keeps token counts", () => {
    expect(scrubErrorText("api_key=12345678 rejected")).toBe("api_key=[redacted] rejected");
    expect(scrubErrorText('{"password": "4242"}')).toBe('{"password": "[redacted]"}');
    expect(scrubErrorText("input_tokens: 812, max_tokens: 4096")).toBe(
      "input_tokens: 812, max_tokens: 4096",
    );
  });

  it("leaves URL paths and ordinary text alone", () => {
    expect(scrubErrorText("max_tokens: 4096 exceeds the limit")).toBe(
      "max_tokens: 4096 exceeds the limit",
    );
    const text =
      "GET https://example.com/home/users/123 returned 404 for anthropic/claude-sonnet-4";
    expect(scrubErrorText(text)).toBe(text);
    expect(scrubErrorText("Cannot read properties of undefined (reading 'map')")).toBe(
      "Cannot read properties of undefined (reading 'map')",
    );
  });

  it("masks API keys and tokens", () => {
    const cases = [
      "sk-proj-abcdefghijklmnop1234567890",
      "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
      "sk-or-v1-0123456789abcdef0123456789abcdef",
      "AIzaSyA1234567890abcdefghijklmnopqrstu",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "gsk_abcdefghijklmnopqrstuv0123",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      "3f9a1c7e5b2d4f6a8c0e1b3d5f7a9c2e4b6d8f0a",
    ];
    for (const secret of cases) {
      const scrubbed = scrubErrorText(`request failed with ${secret} in it`);
      expect(scrubbed).not.toContain(secret);
      expect(scrubbed).toContain(REDACTED);
    }
  });

  it("masks authorization headers and key-value credentials", () => {
    expect(scrubErrorText("Authorization: Bearer abc.def-ghi_jkl")).not.toContain("abc.def");
    expect(scrubErrorText("Basic b3BlbmNvZGU6c2VjcmV0cGFzcw==")).toBe(`Basic ${REDACTED}`);
    expect(scrubErrorText("url?api_key=hunter2&x=1")).toBe(`url?api_key=${REDACTED}&x=1`);
    expect(scrubErrorText('{"password": "hunter2"}')).toBe(`{"password": "${REDACTED}"}`);
  });

  it("keeps long paths that are not secrets", () => {
    const path = "~/node_modules/.pnpm/posthog-js@1.363.1/node_modules/posthog-js/dist/module.js";
    expect(scrubErrorText(path)).toBe(path);
  });
});

describe("scrubErrorMessage", () => {
  it("truncates after scrubbing", () => {
    const message = scrubErrorMessage(`/Users/oscar/${"x".repeat(2000)}`);
    expect(message).toHaveLength(ERROR_MESSAGE_MAX_LENGTH);
    expect(message.startsWith("~/x")).toBe(true);
    expect(message.endsWith("…")).toBe(true);
  });
});

describe("scrubEventProperties", () => {
  it("scrubs $exception values and stack frames", () => {
    const properties = scrubEventProperties({
      $exception_list: [
        {
          type: "Error",
          value: `Failed to read /Users/oscar/secret.txt with sk-ant-${"a".repeat(30)} ${"y".repeat(900)}`,
          stacktrace: {
            type: "raw",
            frames: [
              {
                filename: "/Users/oscar/BloxBot/app.js",
                abs_path: "file:///Users/oscar/BloxBot/app.js",
                function: "load",
                lineno: 3,
                in_app: true,
              },
            ],
          },
        },
      ],
      error_message: "C:\\Users\\jdoe\\x",
      component_stack: "at App (/home/jdoe/src/App.tsx:1:1)",
      $exception_message: "open /Users/oscar/a",
      feature: "chat",
    });
    const [exception] = properties.$exception_list as Array<Record<string, unknown>>;
    const value = exception?.value as string;
    expect(value.startsWith("Failed to read ~/secret.txt with [redacted]")).toBe(true);
    expect(value.length).toBeLessThanOrEqual(ERROR_MESSAGE_MAX_LENGTH);
    expect(JSON.stringify(properties)).not.toMatch(/oscar|jdoe/);
    expect((exception?.stacktrace as { frames: Array<Record<string, unknown>> }).frames[0]).toEqual(
      {
        filename: "~/BloxBot/app.js",
        abs_path: "file://~/BloxBot/app.js",
        function: "load",
        lineno: 3,
        in_app: true,
      },
    );
    expect(properties.error_message).toBe("~\\x");
    expect(properties.feature).toBe("chat");
  });

  it("leaves events without error data unchanged", () => {
    const properties = { feature: "app", app_version: "1.0.0" };
    expect(scrubEventProperties(properties)).toEqual(properties);
  });
});

describe("describeError", () => {
  it("reads Errors, strings and OpenCode SDK error bodies", () => {
    expect(describeError(new TypeError("bad"))).toEqual({ type: "TypeError", message: "bad" });
    expect(describeError("plain")).toEqual({ type: "string", message: "plain" });
    expect(
      describeError({
        name: "ProviderAuthError",
        data: { message: "Invalid key", providerID: "x" },
      }),
    ).toEqual({ type: "ProviderAuthError", message: "Invalid key" });
    expect(describeError({ message: "loose" })).toEqual({ type: "object", message: "loose" });
    expect(describeError(42)).toEqual({ type: "number", message: null });
    expect(describeError(null)).toEqual({ type: "object", message: null });
  });

  it("appends the cause of a wrapping error", () => {
    const error = new Error("Failed to start OpenCode", { cause: new Error("spawn EACCES") });
    expect(describeError(error).message).toBe("Failed to start OpenCode (cause: spawn EACCES)");
  });
});

describe("createErrorDeduper", () => {
  it("accepts the same key once per window", () => {
    let time = 0;
    const shouldReport = createErrorDeduper(1000, () => time);
    expect(shouldReport("a")).toBe(true);
    expect(shouldReport("a")).toBe(false);
    expect(shouldReport("b")).toBe(true);
    time = 1000;
    expect(shouldReport("a")).toBe(true);
  });
});

describe("errorFromMainReport", () => {
  it("rebuilds an Error with the forwarded name and stack", () => {
    const error = errorFromMainReport({
      source: "opencode_start",
      name: "OpenCodeError",
      message: "boom",
      stack: "OpenCodeError: boom\n    at start (main.js:1:1)",
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("OpenCodeError");
    expect(error.stack).toContain("at start");
  });
});

function fakeTarget(): MainErrorTarget & { send: ReturnType<typeof vi.fn>; destroy(): void } {
  let destroyed = false;
  const listeners: Array<() => void> = [];
  return {
    send: vi.fn(),
    isDestroyed: () => destroyed,
    once: (_event, listener) => listeners.push(listener),
    destroy() {
      destroyed = true;
      for (const listener of listeners) listener();
    },
  };
}

describe("createMainErrorReporter", () => {
  it("buffers until a window attaches, then flushes in order", () => {
    const reporter = createMainErrorReporter({ channel: "err" });
    reporter.report("a", new Error("first"));
    reporter.report("b", "second");
    const target = fakeTarget();
    reporter.attach(target);
    expect(target.send.mock.calls.map(([, report]) => report.message)).toEqual(["first", "second"]);
    reporter.report("c", new Error("third"));
    expect(target.send).toHaveBeenCalledTimes(3);
  });

  it("bounds the buffer and de-duplicates repeats", () => {
    let time = 0;
    const reporter = createMainErrorReporter({ channel: "err", maxBuffered: 3, now: () => time });
    for (let index = 0; index < 5; index += 1) reporter.report("loop", new Error(`e${index}`));
    reporter.report("loop", new Error("e4"));
    const target = fakeTarget();
    reporter.attach(target);
    expect(target.send.mock.calls.map(([, report]) => report.message)).toEqual(["e2", "e3", "e4"]);
    reporter.report("loop", new Error("e4"));
    expect(target.send).toHaveBeenCalledTimes(3);
    time = 60_000;
    reporter.report("loop", new Error("e4"));
    expect(target.send).toHaveBeenCalledTimes(4);
  });

  it("pre-scrubs with the known home directory and username", () => {
    const reporter = createMainErrorReporter({
      channel: "err",
      home: "/srv/people/oscar",
      username: "oscar",
    });
    const target = fakeTarget();
    reporter.attach(target);
    const error = new Error("cannot open /srv/people/oscar/BloxBot as oscar");
    reporter.report("opencode_start", error);
    const [, report] = target.send.mock.calls[0] ?? [];
    expect(report).toMatchObject({
      source: "opencode_start",
      name: "Error",
      message: "cannot open ~/BloxBot as <user>",
    });
    expect(report.stack).not.toContain("oscar");
  });

  it("buffers again after the window is destroyed", () => {
    const reporter = createMainErrorReporter({ channel: "err" });
    const first = fakeTarget();
    reporter.attach(first);
    first.destroy();
    reporter.report("a", new Error("while closed"));
    expect(first.send).not.toHaveBeenCalled();
    const second = fakeTarget();
    reporter.attach(second);
    expect(second.send).toHaveBeenCalledOnce();
  });
});
