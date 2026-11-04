import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MessageText } from "@/components/ChatMessages";
import { ExplorerReferenceProvider } from "@/providers/ExplorerReferenceProvider";

describe("references in a sent message", () => {
  it("tells objects, properties and attributes apart", () => {
    render(
      <ExplorerReferenceProvider>
        <MessageText
          text={
            'Check <Instance reference="game.Workspace.Part">@Part</Instance> ' +
            '<Instance reference="game.Workspace.Part" property="Anchored">@Part.Anchored</Instance> ' +
            '<Instance reference="game.Workspace.Part" attribute="Team">@Part.Team</Instance> ' +
            '<Instance reference="game.Workspace.Part" tag="Enemy">@Part.Enemy</Instance>'
          }
        />
      </ExplorerReferenceProvider>,
    );

    expect(screen.getByText("@Part")).toHaveAttribute("title", "game.Workspace.Part");
    expect(screen.getByText("@Part.Anchored")).toHaveAttribute(
      "title",
      "Property of game.Workspace.Part",
    );
    expect(screen.getByText("@Part.Team")).toHaveAttribute(
      "title",
      "Attribute of game.Workspace.Part",
    );
    expect(screen.getByText("@Part.Enemy")).toHaveAttribute("title", "Tag on game.Workspace.Part");
    expect(screen.queryByText(/<Instance/)).not.toBeInTheDocument();
  });
});
