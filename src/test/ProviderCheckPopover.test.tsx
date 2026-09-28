import type { Model } from "@opencode-ai/sdk/v2/client";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import ProviderCheckPopover from "@/components/ProviderCheckPopover";

function model(id: string, name: string) {
  return { id, name, status: "active" } as Model;
}

describe("ProviderCheckPopover", () => {
  it("starts on the first model and checks the one the user picks", () => {
    const onCheck = vi.fn();
    const models = [model("gpt-5.6", "GPT-5.6"), model("gpt-5.6-mini", "GPT-5.6 Mini")];
    render(
      <ProviderCheckPopover
        providerName="OpenAI"
        models={models}
        checking={false}
        onCheck={onCheck}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    expect(screen.getByRole("option", { name: "GPT-5.6" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // Short lists don't need a search box.
    expect(screen.queryByLabelText("Search models")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("option", { name: "GPT-5.6 Mini" }));
    fireEvent.click(screen.getByRole("button", { name: "Check GPT-5.6 Mini" }));
    expect(onCheck).toHaveBeenCalledWith(models[1]);
  });

  it("offers search when the list is long", () => {
    const models = Array.from({ length: 12 }, (_, i) => model(`m-${i}`, `Model ${i}`));
    render(
      <ProviderCheckPopover
        providerName="OpenRouter"
        models={models}
        checking={false}
        onCheck={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    fireEvent.change(screen.getByLabelText("Search models"), { target: { value: "model 11" } });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Model 11"]);
  });

  it("says when there's nothing to check", () => {
    render(
      <ProviderCheckPopover providerName="Voice" models={[]} checking={false} onCheck={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    expect(screen.getByText("This provider has no chat models to test with.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Check / })).not.toBeInTheDocument();
  });
});
