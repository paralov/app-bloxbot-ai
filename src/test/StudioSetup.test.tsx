import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import StudioSetup from "@/components/StudioSetup";

describe("StudioSetup", () => {
  it("explains how to fix Studio's MCP helper when it can't start (#106)", () => {
    const { rerender } = render(
      <StudioSetup
        connected={false}
        checking={false}
        problem="not_installed"
        onCheck={vi.fn()}
        onContinue={vi.fn()}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "BloxBot can't find Studio's MCP helper. Install or update Roblox Studio, then follow the steps above.",
    );
    expect(screen.queryByText("Looking for Roblox Studio")).toBeNull();

    rerender(
      <StudioSetup
        connected={false}
        checking={false}
        problem="unavailable"
        onCheck={vi.fn()}
        onContinue={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Studio's MCP helper stopped. Open Roblox Studio so it can finish updating, or reinstall it if this keeps happening.",
    );
    expect(screen.getByRole("status").textContent).not.toContain(";");
  });

  it("offers a way back only when one is given", () => {
    const onDismiss = vi.fn();
    const props = { connected: false, checking: false, onCheck: vi.fn(), onContinue: vi.fn() };
    const { rerender } = render(<StudioSetup {...props} />);
    expect(screen.queryByRole("button", { name: "Back to chat" })).toBeNull();

    rerender(<StudioSetup {...props} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: "Back to chat" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("can check again from any step, and keeps focus when Back goes away", () => {
    const onCheck = vi.fn();
    render(
      <StudioSetup connected={false} checking={false} onCheck={onCheck} onContinue={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(onCheck).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    const back = screen.getByRole("button", { name: "Back" });
    back.focus();
    fireEvent.click(back);
    expect(screen.getByRole("button", { name: "Next" })).toHaveFocus();
  });

  it("moves focus to what comes next when Studio connects", () => {
    const { rerender } = render(
      <StudioSetup connected={false} checking={false} onCheck={vi.fn()} onContinue={vi.fn()} />,
    );
    expect(screen.getByRole("heading", { name: "Let's connect Studio" })).toHaveFocus();

    rerender(<StudioSetup connected checking={false} onCheck={vi.fn()} onContinue={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Let's build" })).toHaveFocus();
  });

  it("doesn't call someone ready when this chat still needs a place chosen", () => {
    render(
      <StudioSetup connected needsChoice checking={false} onCheck={vi.fn()} onContinue={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Choose a place" })).toHaveFocus();
    expect(screen.queryByText(/ready to build/)).toBeNull();
  });

  it("says so when a check finds nothing", () => {
    const props = { connected: false, onCheck: vi.fn(), onContinue: vi.fn() };
    const { rerender } = render(<StudioSetup {...props} checking={false} />);
    expect(screen.queryByText(/Not found yet/)).toBeNull();

    rerender(<StudioSetup {...props} checking />);
    rerender(<StudioSetup {...props} checking={false} />);
    expect(
      screen.getByText("Not found yet. Check these steps, then restart Studio."),
    ).toBeVisible();
  });

  it("lets someone who isn't here for Studio skip it, the first time", () => {
    const onSkip = vi.fn();
    render(
      <StudioSetup
        connected={false}
        checking={false}
        onCheck={vi.fn()}
        onContinue={vi.fn()}
        onSkip={onSkip}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(onSkip).toHaveBeenCalledOnce();
  });
});
