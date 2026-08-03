import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import ErrorBoundary from "@/components/ErrorBoundary";
import { setCrashReportsEnabled } from "@/lib/analytics";

const captureExceptionSpy = vi.fn();

vi.mock("posthog-js/dist/module.full.no-external.js", () => ({
  default: { captureException: (...args: unknown[]) => captureExceptionSpy(...args) },
}));

function Thrower({ error }: { error: Error }) {
  throw error;
}

describe("ErrorBoundary", () => {
  let consoleErrorSpy: MockInstance;

  beforeEach(() => {
    // Suppress the expected React error boundary console output.
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    setCrashReportsEnabled(true);
  });

  afterEach(() => {
    captureExceptionSpy.mockReset();
    consoleErrorSpy.mockRestore();
  });

  it("forwards caught errors to posthog.captureException", () => {
    const error = new Error("boom");

    render(
      <ErrorBoundary>
        <Thrower error={error} />
      </ErrorBoundary>,
    );

    expect(captureExceptionSpy).toHaveBeenCalledOnce();
    expect(captureExceptionSpy).toHaveBeenCalledWith(error);
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
  });

  it("renders children when no error occurs", () => {
    render(
      <ErrorBoundary>
        <p>OK</p>
      </ErrorBoundary>,
    );

    expect(screen.getByText("OK")).toBeInTheDocument();
    expect(captureExceptionSpy).not.toHaveBeenCalled();
  });

  it("does not call captureException when crash reports are disabled", () => {
    setCrashReportsEnabled(false);
    const error = new Error("silent");
    render(
      <ErrorBoundary>
        <Thrower error={error} />
      </ErrorBoundary>,
    );
    expect(captureExceptionSpy).not.toHaveBeenCalled();
  });
});
