import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { parseReleaseNotes, UpdateReleaseNotes } from "@/components/UpdateReleaseNotes";

const releaseHtml = `
  <h2>Download BloxBot</h2>
  <ul><li><a href="https://example.com/app.dmg">macOS (.dmg)</a></li></ul>
  <h3>Added</h3>
  <ul><li>Coordinate work across multiple Studio places.</li></ul>
`;

describe("UpdateReleaseNotes", () => {
  it("keeps changelog sections and omits download links", () => {
    expect(parseReleaseNotes(releaseHtml)).toEqual([
      { title: "Added", items: ["Coordinate work across multiple Studio places."] },
    ]);
  });

  it("renders readable release notes instead of raw HTML", () => {
    render(<UpdateReleaseNotes body={releaseHtml} />);
    expect(screen.getByText("Added")).toBeVisible();
    expect(screen.getByText("Coordinate work across multiple Studio places.")).toBeVisible();
    expect(screen.queryByText(/<h2>/)).not.toBeInTheDocument();
    expect(screen.queryByText("macOS (.dmg)")).not.toBeInTheDocument();
  });
});
