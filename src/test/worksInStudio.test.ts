import { describe, expect, it, vi } from "vitest";

vi.mock("@/providers/ActiveSessionProvider", () => ({ useActiveSession: vi.fn() }));
vi.mock("@/providers/OpenCodeClientProvider", () => ({ useOpenCodeClient: vi.fn() }));

import { worksInStudio } from "@/hooks/useMessages";

describe("worksInStudio", () => {
  it("counts a Studio tool, but not looking at what's open", () => {
    expect(worksInStudio("roblox-studio_execute_luau", {})).toBe(true);
    expect(worksInStudio("roblox-studio_list_roblox_studios", {})).toBe(false);
    expect(worksInStudio("bash", { command: "ls" })).toBe(false);
  });

  it("reads Code Mode the same way", () => {
    const listing = "await roblox_studio.list_roblox_studios();";
    const working = `${listing} await roblox_studio.execute_luau({ code: "print(1)" });`;
    expect(worksInStudio("execute", { code: listing })).toBe(false);
    expect(worksInStudio("execute", { code: working })).toBe(true);
    expect(worksInStudio("execute", { code: "console.log(1)" })).toBe(false);
  });
});
