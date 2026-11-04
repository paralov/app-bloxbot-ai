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
      "BloxBot can't find Roblox Studio's MCP helper. Install or update Roblox Studio, open it, turn on the MCP server in Assistant settings, then check again.",
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
      "Studio's MCP helper stopped right after it started.",
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
});
