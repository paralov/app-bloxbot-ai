import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ studioTarget: null as unknown, capture: vi.fn() }));

vi.mock("@/providers/StudioTargetProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/providers/StudioTargetProvider")>()),
  useStudioTargetOptional: () => mocks.studioTarget,
}));
vi.mock("posthog-js/dist/module.full.no-external.js", () => ({
  default: { capture: mocks.capture, register: vi.fn() },
}));

import StudioNotice from "@/components/StudioNotice";

const LOBBY = { key: "lobby", label: "Lobby (placeId: 2)", detail: null };
const DUNGEON = { key: "gone", label: "Dungeon (placeId: 1)", detail: null };
const onOpenSetup = vi.fn();
const onOpenPicker = vi.fn();

function show(studioTarget: Record<string, unknown>) {
  mocks.studioTarget = {
    status: "ready",
    selected: null,
    selectingKey: null,
    targets: [],
    missing: null,
    ...studioTarget,
  };
  return render(<StudioNotice onOpenSetup={onOpenSetup} onOpenPicker={onOpenPicker} />);
}

describe("StudioNotice", () => {
  beforeEach(() => vi.clearAllMocks());

  it("stays out of the way when a Studio is in use or still being looked for", () => {
    const { unmount } = show({ selected: LOBBY, targets: [LOBBY] });
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(screen.queryByRole("button")).toBeNull();
    unmount();
    show({ status: "loading" });
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("leads to the setup steps when nothing is connected", () => {
    show({ status: "empty" });
    expect(screen.getByRole("status")).toHaveTextContent("No Studio connected.");

    fireEvent.click(screen.getByRole("button", { name: "Show me how" }));

    expect(onOpenSetup).toHaveBeenCalledOnce();
    expect(mocks.capture).toHaveBeenCalledWith(
      "studio_target_guidance_followed",
      expect.objectContaining({ trigger: "notice" }),
    );
  });

  it("names the place this chat is missing, and leads to the picker when others are open", () => {
    show({ targets: [LOBBY], missing: DUNGEON });
    // Said whole, not cut off where the button starts.
    expect(screen.getByRole("status")).toHaveTextContent(
      "Dungeon isn't open. Reopen it or choose another.",
    );

    fireEvent.click(screen.getByRole("button", { name: "Choose another" }));
    expect(onOpenPicker).toHaveBeenCalledOnce();
    expect(onOpenSetup).not.toHaveBeenCalled();
  });

  it("names the missing place with the steps when nothing else is open", () => {
    show({ status: "empty", missing: DUNGEON });
    expect(screen.getByRole("status")).toHaveTextContent("Dungeon isn't open");
    expect(screen.getByRole("button", { name: "Show me how" })).toBeVisible();
  });

  it("says out loud when a chat's place comes back", () => {
    const { rerender } = show({ status: "empty", missing: DUNGEON });
    mocks.studioTarget = {
      status: "ready",
      selected: { ...DUNGEON, key: "new" },
      selectingKey: null,
      targets: [DUNGEON],
      missing: null,
    };
    rerender(<StudioNotice onOpenSetup={onOpenSetup} onOpenPicker={onOpenPicker} />);
    expect(screen.getByRole("status")).toHaveTextContent("Dungeon is connected.");
  });

  it("says when two open places share this chat's place's name", () => {
    show({ targets: [DUNGEON, { ...DUNGEON, key: "other" }], missing: DUNGEON, twins: 2 });
    expect(screen.getByRole("status")).toHaveTextContent("2 places named Dungeon are open.");
    fireEvent.click(screen.getByRole("button", { name: "Choose one" }));
    expect(onOpenPicker).toHaveBeenCalledOnce();
  });

  it("asks about a same-named place, and one click takes it", () => {
    const select = vi.fn().mockResolvedValue(undefined);
    const twin = { ...DUNGEON, key: "other" };
    show({ targets: [twin], missing: DUNGEON, twins: 1, nameMatch: twin, select });
    expect(screen.getByRole("status")).toHaveTextContent("Is the open Dungeon this chat's place?");

    fireEvent.click(screen.getByRole("button", { name: "Use it" }));

    expect(select).toHaveBeenCalledWith(twin);
    expect(onOpenPicker).not.toHaveBeenCalled();

    // With nothing else open, there's no other to choose.
    expect(screen.queryByRole("button", { name: "Choose another" })).toBeNull();
  });

  it("offers the others when more than the same-named place is open", () => {
    const twin = { ...DUNGEON, key: "other" };
    show({ targets: [twin, LOBBY], missing: DUNGEON, twins: 1, nameMatch: twin });
    fireEvent.click(screen.getByRole("button", { name: "Choose another" }));
    expect(onOpenPicker).toHaveBeenCalledOnce();
  });

  it("says Studio couldn't be reached instead of naming a place as closed", () => {
    show({ status: "error", missing: DUNGEON });
    expect(screen.getByRole("status")).toHaveTextContent("Couldn't reach Studio.");
  });

  it("stays out of a chat that's under way without a Studio", () => {
    mocks.studioTarget = {
      status: "empty",
      selected: null,
      selectingKey: null,
      targets: [],
      missing: null,
    };
    render(<StudioNotice onOpenSetup={onOpenSetup} onOpenPicker={onOpenPicker} quiet />);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("still speaks up in a started chat when it has a place to lose", () => {
    mocks.studioTarget = {
      status: "empty",
      selected: null,
      selectingKey: null,
      targets: [],
      missing: DUNGEON,
    };
    render(<StudioNotice onOpenSetup={onOpenSetup} onOpenPicker={onOpenPicker} quiet />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Dungeon isn't open. Reopen it to use Studio again.",
    );
  });

  it("offers to carry on without Studio, and goes quiet once chosen", () => {
    const workWithoutStudio = vi.fn();
    const { unmount } = show({ status: "empty", workWithoutStudio });
    fireEvent.click(screen.getByRole("button", { name: "Work without Studio" }));
    expect(workWithoutStudio).toHaveBeenCalledOnce();
    unmount();

    show({ status: "empty", withoutStudio: true });
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("asks for a choice when several Studios are open and this chat has none", () => {
    show({ targets: [LOBBY, DUNGEON] });
    expect(screen.getByRole("status")).toHaveTextContent("Several Studios are open.");
  });

  it("stays out of the moment before the only Studio is picked up", () => {
    show({ targets: [LOBBY] });
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("asks which Studio when a chat has used one and it isn't written down", () => {
    show({ targets: [LOBBY], unknownPlace: true });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Choose which Studio this chat worked in.",
    );
  });
});
