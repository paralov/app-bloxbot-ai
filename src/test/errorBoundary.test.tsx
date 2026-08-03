import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ErrorBoundary from "@/components/ErrorBoundary";

const captureExceptionSpy = vi.fn();

vi.mock("posthog-js/dist/module.full.no-external.js", () => ({
  default: { captureException: (...args: unknown[]) => captureExceptionSpy(...args) },
}));

function Thrower({ error }: { error: Error }) {
  throw error;
}

describe("ErrorBoundary", () => {
  afterEach(() => {
    captureExceptionSpy.mockReset();
  });

  it("forwards caught errors to posthog.captureException", () => {
    const error = new Error("boom");
    // Suppress the expected React error boundary console output.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <Thrower error={error} />
      </ErrorBoundary>,
    );

    expect(captureExceptionSpy).toHaveBeenCalledOnce();
    expect(captureExceptionSpy).toHaveBeenCalledWith(error);
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();

    spy.mockRestore();
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
});
