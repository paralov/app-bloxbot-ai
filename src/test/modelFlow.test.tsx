import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelCard } from "@/components/ModelCard";
import { describePermission } from "@/components/PermissionPrompt";
import { ThreeDToolsTab } from "@/components/ThreeDToolsTab";
import { buildUploadSteps } from "@/components/UploadChecklist";
import { SLOWED_DOWN } from "@/hooks/useUploadAccess";
import { desktop } from "@/lib/desktop";
import { modelLinksIn } from "@/lib/modelLinks";
import { notify } from "@/lib/notifications";
import { qk } from "@/lib/queryKeys";
import type {
  ModelFileInfo,
  ModelUploadResult,
  UploadAccess,
  UploadAccessState,
} from "@/types/desktop";

/** Draws as soon as it's shown, unless a test holds it back to draw by hand or makes it fail. */
const preview = vi.hoisted(() => ({ auto: true, fail: false, draw: () => {} }));
vi.mock("@/components/ModelPreview", async () => {
  const { useEffect } = await import("react");
  return {
    default: function Preview({
      name,
      data,
      onDrawn,
      onFailed,
    }: {
      name: string;
      data: Uint8Array;
      onDrawn: (data: Uint8Array) => void;
      onFailed: () => void;
    }) {
      useEffect(() => {
        preview.draw = () => onDrawn?.(data);
        if (preview.fail) onFailed();
        else if (preview.auto) onDrawn?.(data);
      }, [data, onDrawn, onFailed]);
      return <div>Preview of {name}</div>;
    },
  };
});
const sendMessage = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/mutations/useSendMessage", () => ({
  useSendMessage: () => ({ mutate: sendMessage }),
}));
vi.mock("@/providers/OpenCodeClientProvider", () => ({
  useOpenCodeClient: () => ({ client: null }),
}));
const studio = vi.hoisted(() => ({
  selected: { key: "studio-1" } as { key: string; label?: string; placeId?: string } | null,
  targets: [] as unknown[],
  promptReference: "route it here",
}));
vi.mock("@/providers/StudioTargetProvider", () => ({
  useStudioTargetOptional: () => studio,
}));

const URL_A = "file:///Users/me/BloxBot/Models/Crate.fbx";
const FOLDER = "/Users/me/BloxBot/Models";
const file: ModelFileInfo = {
  name: "Crate",
  fileName: "Crate.fbx",
  path: `${FOLDER}/Crate.fbx`,
  folder: FOLDER,
  data: new Uint8Array([1]),
  kind: "fbx",
  sizeBytes: 180 * 1024,
  sent: null,
  hash: "previewed-hash",
};

function wrap(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const accessOf = (state: UploadAccessState, readOn = false, writeOn = false): UploadAccess => ({
  state,
  readOn,
  writeOn,
  folder: FOLDER,
  folderUrl: `file://${FOLDER}`,
});

function setUp(access: UploadAccessState, model: ModelFileInfo | null = file) {
  vi.spyOn(desktop, "readModelFile").mockResolvedValue(model);
  vi.spyOn(desktop, "getUploadAccess").mockResolvedValue(accessOf(access));
  vi.spyOn(desktop, "onModelUploadStep").mockReturnValue(() => {});
}

/** Upload only works once the preview has drawn, which comes a moment after the card. */
async function uploadButton() {
  const button = await screen.findByRole("button", { name: "Upload to Roblox" });
  await waitFor(() => expect(button).toBeEnabled());
  return button;
}

beforeEach(() => {
  studio.selected = { key: "studio-1" };
  studio.targets = [];
  preview.auto = true;
  preview.fail = false;
  sendMessage.mockClear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("finding models in a reply", () => {
  it("finds linked FBX and GLB files once each, and nothing else", () => {
    expect(
      modelLinksIn(
        "Here: [crate](file:///a/Crate.fbx), again file:///a/Crate.fbx and [b](file:///a/B.GLB). Not [c](file:///a/c.txt) or https://x.test/d.fbx",
      ),
    ).toEqual(["file:///a/Crate.fbx", "file:///a/B.GLB"]);
  });

  it("leaves paths shown as code alone, but still finds real links around them", () => {
    expect(
      modelLinksIn(
        [
          "Export with:",
          "```python",
          'path = "file:///a/Fenced.fbx"',
          "```",
          "Then open [`Crate.fbx`](file:///a/Crate.fbx), not `file:///a/Inline.glb`.",
          "~~~",
          "file:///a/Tilde.glb",
          "~~~",
          "Also file:///a/Bare.glb",
          "```",
          "file:///a/Unclosed.fbx",
        ].join("\n"),
      ),
    ).toEqual(["file:///a/Crate.fbx", "file:///a/Bare.glb"]);
  });

  it("leaves indented code alone, but not indented text in a list or paragraph", () => {
    expect(
      modelLinksIn(
        [
          "    file:///a/AtStart.fbx",
          "",
          "Run this:",
          "",
          "    open file:///a/Indented.fbx",
          "",
          "\tfile:///a/Tabbed.glb",
          "Then:",
          "    file:///a/Paragraph.glb",
          "",
          "1. Export it.",
          "",
          "    Then open file:///a/ListItem.fbx",
        ].join("\n"),
      ),
    ).toEqual(["file:///a/Paragraph.glb", "file:///a/ListItem.fbx"]);
  });

  it("finds paths with brackets in them, without taking a link's closing bracket", () => {
    expect(
      modelLinksIn(
        "See [crate](file:///m/Crate%20(1).fbx) and file:///m/Box%20(2).glb (or file:///m/C.fbx).",
      ),
    ).toEqual(["file:///m/Crate%20(1).fbx", "file:///m/Box%20(2).glb", "file:///m/C.fbx"]);
  });
});

describe("before uploads can run", () => {
  it("offers importing by hand with no Studio, and no talk of keys", async () => {
    setUp("no_studio");
    studio.selected = null;
    render(wrap(<ModelCard url={URL_A} />));
    expect(await screen.findByRole("heading", { name: "Crate" })).toBeTruthy();
    expect(screen.getByText("In Studio, open the File menu and choose Import.")).toBeTruthy();
    expect(screen.getByText(/Roblox holds you responsible/)).toBeTruthy();
    // The preview loads on its own, after the card.
    expect(await screen.findByText("Preview of Crate")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Upload to Roblox" })).toBeNull();
    expect(screen.queryByText(/API key/i)).toBeNull();
  });

  it("shows nothing for a file it can't read", async () => {
    setUp("ready", null);
    const { container } = render(wrap(<ModelCard url={URL_A} />));
    await waitFor(() => expect(desktop.readModelFile).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("shows the very next thing to click, and ticks off what's done", async () => {
    setUp("needs_permission");
    vi.spyOn(desktop, "getUploadAccess").mockResolvedValue(
      accessOf("needs_permission", true, false),
    );
    render(wrap(<ModelCard url={URL_A} />));
    expect(await screen.findByText("Turn on one-click uploads")).toBeTruthy();
    const current = document.querySelector('[aria-current="step"]');
    expect(current?.textContent).toContain("Allow asset:write");
    expect(current?.textContent).toContain("Just below it");
    expect(screen.getByText(/Allow asset:read/).textContent).toContain("(done)");
    expect(screen.getByText(/Watching Studio/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Upload to Roblox" })).toBeNull();
    expect(desktop.getUploadAccess).toHaveBeenCalledWith("studio-1", URL_A);
  });

  it("names the folder last, ready to copy or show", async () => {
    setUp("needs_folder");
    vi.spyOn(desktop, "getUploadAccess").mockResolvedValue(accessOf("needs_folder", true, true));
    const open = vi.spyOn(desktop, "openUrl").mockResolvedValue();
    render(wrap(<ModelCard url={URL_A} />));
    expect(await screen.findByText(FOLDER)).toBeTruthy();
    expect(screen.getByText("Upload folders")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy path" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show folder" }));
    expect(open).toHaveBeenCalledWith(`file://${FOLDER}`);
  });

  it("moves on by itself, and says so wherever someone is", async () => {
    setUp("needs_permission");
    const success = vi.spyOn(notify, "success").mockReturnValue("id");
    render(wrap(<ModelCard url={URL_A} />));
    await screen.findByText("Turn on one-click uploads");
    expect(success).not.toHaveBeenCalled();
    vi.spyOn(desktop, "getUploadAccess").mockResolvedValue(accessOf("ready", true, true));
    expect(
      await screen.findByRole("button", { name: "Upload to Roblox" }, { timeout: 6000 }),
    ).toBeTruthy();
    expect(success).toHaveBeenCalledTimes(1);
    expect(success.mock.calls[0]?.[1]).toMatchObject({ system: expect.anything() });
  }, 8000);

  it("doesn't announce switching to a place that was already set up", async () => {
    setUp("needs_permission");
    vi.spyOn(desktop, "getUploadAccess").mockImplementation(async (key) =>
      key === "studio-2" ? accessOf("ready", true, true) : accessOf("needs_permission"),
    );
    const success = vi.spyOn(notify, "success").mockReturnValue("id");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = (
      <QueryClientProvider client={client}>
        <ModelCard url={URL_A} />
      </QueryClientProvider>
    );
    const { rerender } = render(view);
    await screen.findByText("Turn on one-click uploads");
    studio.selected = { key: "studio-2" };
    rerender(
      <QueryClientProvider client={client}>
        <ModelCard url={URL_A} />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole("button", { name: "Upload to Roblox" })).toBeTruthy();
    expect(success).not.toHaveBeenCalled();
  });

  it("checks again when the same Studio opens another place", async () => {
    setUp("ready");
    vi.spyOn(desktop, "getUploadAccess").mockResolvedValue(accessOf("ready", true, true));
    studio.selected = { key: "studio-1", label: "Obby", placeId: "1" };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = () => (
      <QueryClientProvider client={client}>
        <ModelCard url={URL_A} />
      </QueryClientProvider>
    );
    const { rerender } = render(view());
    await screen.findByRole("button", { name: "Upload to Roblox" });
    vi.spyOn(desktop, "getUploadAccess").mockResolvedValue(accessOf("needs_permission"));
    studio.selected = { key: "studio-1", label: "Tycoon", placeId: "2" };
    rerender(view());
    expect(await screen.findByText("Turn on one-click uploads")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Upload to Roblox" })).toBeNull();
  });

  it("keeps watching when Roblox asks it to slow down", async () => {
    setUp("needs_permission");
    vi.spyOn(desktop, "getUploadAccess")
      .mockRejectedValueOnce(new Error("Roblox asked BloxBot to slow down"))
      .mockResolvedValue(accessOf("needs_permission"));
    render(wrap(<ModelCard url={URL_A} />));
    // With no earlier answer to keep showing, it says why there's nothing yet.
    expect(await screen.findByText(SLOWED_DOWN)).toBeTruthy();
    expect(
      await screen.findByText("Turn on one-click uploads", undefined, { timeout: 6000 }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Upload to Roblox" })).toBeNull();
  }, 8000);

  it("drops a folder refusal when another Studio is chosen", async () => {
    setUp("ready");
    vi.spyOn(desktop, "getUploadAccess").mockResolvedValue(accessOf("ready", true, true));
    vi.spyOn(desktop, "uploadModelToPlace").mockResolvedValue({
      status: "needs_folder",
      folder: FOLDER,
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = render(
      <QueryClientProvider client={client}>
        <ModelCard url={URL_A} />
      </QueryClientProvider>,
    );
    fireEvent.click(await uploadButton());
    expect(await screen.findByText(/hasn't approved this file's folder/)).toBeTruthy();
    studio.selected = { key: "studio-2" };
    rerender(
      <QueryClientProvider client={client}>
        <ModelCard url={URL_A} />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole("button", { name: "Upload to Roblox" })).toBeTruthy();
    expect(screen.queryByText(/hasn't approved this file's folder/)).toBeNull();
  });

  it("explains when Roblox won't accept Studio's sign-in, and offers importing", async () => {
    setUp("refused");
    render(wrap(<ModelCard url={URL_A} />));
    expect(await screen.findByText(/isn't accepting Studio's sign-in/)).toBeTruthy();
    expect(screen.getByText("In Studio, open the File menu and choose Import.")).toBeTruthy();
  });

  it("doesn't announce uploads that were already on", async () => {
    setUp("ready");
    const success = vi.spyOn(notify, "success").mockReturnValue("id");
    render(wrap(<ModelCard url={URL_A} />));
    await screen.findByRole("button", { name: "Upload to Roblox" });
    expect(success).not.toHaveBeenCalled();
  });

  it("starts from the first thing that's wrong", () => {
    const currentOf = (access: UploadAccess) =>
      buildUploadSteps(access).find((step) => !step.done)?.id;
    expect(currentOf(accessOf("no_studio"))).toBe("studio");
    expect(currentOf(accessOf("not_published"))).toBe("published");
    expect(currentOf(accessOf("reopen_studio"))).toBe("reopen");
    expect(currentOf(accessOf("needs_permission"))).toBe("read");
    expect(currentOf(accessOf("needs_permission", true))).toBe("write");
    expect(currentOf(accessOf("needs_permission", false, true))).toBe("read");
    expect(currentOf(accessOf("needs_folder", true, true))).toBe("folder");
    expect(currentOf(accessOf("ready", true, true))).toBeUndefined();
    expect(buildUploadSteps(accessOf("no_studio")).some((step) => step.id === "reopen")).toBe(
      false,
    );
    expect(currentOf(accessOf("choose_studio"))).toBe("choose");
  });

  it("guides an old Studio window and an unpublished place, and always offers importing", async () => {
    setUp("reopen_studio");
    render(wrap(<ModelCard url={URL_A} />));
    expect(await screen.findByText(/Close this place in Studio and open it again/)).toBeTruthy();
    expect(screen.getByText("Import it yourself")).toBeTruthy();
    cleanup();
    setUp("not_published");
    render(wrap(<ModelCard url={URL_A} />));
    expect(await screen.findByText("Publish to Roblox")).toBeTruthy();
    expect(screen.getByText("Import it yourself")).toBeTruthy();
  });
});

describe("watching Studio", () => {
  it("keeps watching while BloxBot's window is hidden behind Studio", async () => {
    setUp("needs_permission");
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    render(wrap(<ModelCard url={URL_A} />));
    await screen.findByText("Turn on one-click uploads");
    vi.spyOn(desktop, "getUploadAccess").mockResolvedValue(accessOf("ready", true, true));
    expect(
      await screen.findByRole("button", { name: "Upload to Roblox" }, { timeout: 6000 }),
    ).toBeTruthy();
    hidden.mockRestore();
    visibility.mockRestore();
  }, 8000);
});

describe("the upload click", () => {
  const click = async (result: ModelUploadResult) => {
    vi.spyOn(desktop, "uploadModelToPlace").mockResolvedValue(result);
    render(wrap(<ModelCard url={URL_A} />));
    fireEvent.click(await uploadButton());
    await waitFor(() =>
      expect(desktop.uploadModelToPlace).toHaveBeenCalledWith(URL_A, "studio-1", "previewed-hash"),
    );
  };

  it("won't send a new version of the file until that version is the one on screen", async () => {
    setUp("ready");
    const upload = vi
      .spyOn(desktop, "uploadModelToPlace")
      .mockResolvedValue({ status: "rejected", assetId: "9" });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ModelCard url={URL_A} />
      </QueryClientProvider>,
    );
    await uploadButton();
    preview.auto = false;
    vi.spyOn(desktop, "readModelFile").mockResolvedValue({
      ...file,
      data: new Uint8Array([2]),
      hash: "new-hash",
    });
    await act(() => client.invalidateQueries({ queryKey: qk.modelFile(URL_A) }));

    const button = screen.getByRole("button", { name: "Upload to Roblox" });
    await waitFor(() => expect(button).toBeDisabled());
    fireEvent.click(button);
    expect(upload).not.toHaveBeenCalled();

    act(() => preview.draw());
    fireEvent.click(await uploadButton());
    await waitFor(() => expect(upload).toHaveBeenCalledWith(URL_A, "studio-1", "new-hash"));
  });

  it("won't upload a file it couldn't draw until someone says they checked it", async () => {
    preview.fail = true;
    setUp("ready");
    const open = vi.spyOn(desktop, "openUrl").mockResolvedValue();
    const upload = vi
      .spyOn(desktop, "uploadModelToPlace")
      .mockResolvedValue({ status: "rejected", assetId: "9" });
    render(wrap(<ModelCard url={URL_A} />));
    expect(await screen.findByText(/Couldn't draw a preview/)).toBeTruthy();
    const button = screen.getByRole("button", { name: "Upload to Roblox" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(upload).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Show file" }));
    expect(open).toHaveBeenCalledWith(URL_A);
    fireEvent.click(screen.getByRole("checkbox", { name: "I opened it and checked it" }));
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(upload).toHaveBeenCalledWith(URL_A, "studio-1", "previewed-hash"));
  });

  it("does nothing until it's pressed, and says uploads are permanent", async () => {
    setUp("ready");
    const upload = vi.spyOn(desktop, "uploadModelToPlace");
    render(wrap(<ModelCard url={URL_A} />));
    await screen.findByRole("button", { name: "Upload to Roblox" });
    expect(screen.getByText(/Uploads are permanent/)).toBeTruthy();
    expect(upload).not.toHaveBeenCalled();
  });

  it("reports the model added, and hands the fix-up to the AI without another upload", async () => {
    setUp("ready");
    await click({ status: "added", assetId: "555", path: "game.Workspace.Crate" });
    expect(await screen.findByText("Added to your place")).toBeTruthy();
    expect(screen.getByText(/It's at Workspace.Crate/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Fix size and placement" }));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const sent = sendMessage.mock.calls[0]?.[0] as { text: string; studioTargetReference: string };
    expect(sent.text).toContain("rbx-import-asset");
    expect(sent.text).toContain("asset 555");
    expect(sent.text).toContain("don't upload the model again");
    expect(sent.studioTargetReference).toBe("route it here");
    expect(screen.queryByRole("button", { name: "Fix size and placement" })).toBeNull();
    expect(screen.getByText("Asked BloxBot to fix it.")).toBeTruthy();
  });

  it("sends the fix to the place it uploaded to, even if another's chosen since", async () => {
    setUp("ready");
    await click({ status: "added", assetId: "555", path: "game.Workspace.Crate" });
    await screen.findByText("Added to your place");
    studio.promptReference = "another place";
    fireEvent.click(screen.getByRole("button", { name: "Fix size and placement" }));
    const sent = sendMessage.mock.calls[0]?.[0] as { studioTargetReference: string };
    expect(sent.studioTargetReference).toBe("route it here");
    studio.promptReference = "route it here";
  });

  it("explains a rejection, and offers no way to resend", async () => {
    setUp("ready");
    await click({ status: "rejected", assetId: "9" });
    expect(await screen.findByText("Roblox rejected it")).toBeTruthy();
    expect(screen.getByText(/won't send this file again/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /upload|try again/i })).toBeNull();
  });

  it("asks for just the folder when that's all that's missing", async () => {
    setUp("ready");
    vi.spyOn(desktop, "getUploadAccess").mockResolvedValue(accessOf("ready", true, true));
    await click({ status: "needs_folder", folder: FOLDER });
    expect(await screen.findByText(/hasn't approved this file's folder/)).toBeTruthy();
    expect(document.querySelector('[aria-current="step"]')?.textContent).toContain(FOLDER);
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("falls back to importing by hand when Roblox refuses Studio", async () => {
    setUp("ready");
    await click({ status: "failed", reason: "refused" });
    expect(await screen.findByText(/You can still import it yourself/)).toBeTruthy();
    expect(screen.getByText("In Studio, open the File menu and choose Import.")).toBeTruthy();
  });

  it("makes someone look at a file that changed, before it can go up", async () => {
    setUp("ready");
    await click({ status: "failed", reason: "file_changed" });
    expect(await screen.findByText(/changed after this preview/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Check the new version" }));
    expect(await screen.findByRole("button", { name: "Upload to Roblox" })).toBeTruthy();
  });

  it("lets someone decline, and change their mind", async () => {
    setUp("ready");
    render(wrap(<ModelCard url={URL_A} />));
    fireEvent.click(await screen.findByRole("button", { name: "Don't upload" }));
    expect(screen.getByText(/Nothing went to Roblox/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Upload after all" }));
    expect(screen.getByRole("button", { name: "Upload to Roblox" })).toBeTruthy();
  });

  it("remembers a file already sent", async () => {
    setUp("ready", { ...file, sent: { assetId: "9", moderation: "rejected" } });
    render(wrap(<ModelCard url={URL_A} />));
    expect(await screen.findByText("Roblox rejected it")).toBeTruthy();
  });

  it("says what to do, rather than offering a dead button, when no place is chosen", async () => {
    setUp("no_studio", { ...file, sent: { assetId: "5", moderation: "approved" } });
    studio.selected = null;
    render(wrap(<ModelCard url={URL_A} />));
    expect(await screen.findByRole("button", { name: "Add it to your place" })).toBeDisabled();
    expect(screen.getByText("Open your place in Studio first.")).toBeTruthy();
    cleanup();
    studio.targets = [{ key: "a" }, { key: "b" }];
    setUp("no_studio", { ...file, sent: { assetId: "5", moderation: "checking" } });
    render(wrap(<ModelCard url={URL_A} />));
    expect(await screen.findByRole("button", { name: "Check again" })).toBeDisabled();
    expect(screen.getByText("Choose your place in the Studio picker first.")).toBeTruthy();
  });

  it("doesn't blame the place while a chosen one waits for the preview to draw", async () => {
    preview.auto = false;
    setUp("ready", { ...file, sent: { assetId: "5", moderation: "approved" } });
    render(wrap(<ModelCard url={URL_A} />));
    expect(await screen.findByRole("button", { name: "Add it to your place" })).toBeDisabled();
    expect(screen.queryByText("Open your place in Studio first.")).toBeNull();
  });

  it("offers to add a file that's already on Roblox, whatever Studio's permissions", async () => {
    setUp("needs_permission", { ...file, sent: { assetId: "5", moderation: "approved" } });
    render(wrap(<ModelCard url={URL_A} />));
    expect(await screen.findByRole("button", { name: "Add it to your place" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Upload to Roblox" })).toBeNull();
  });
});

describe("the permission prompt", () => {
  it("speaks plainly, whatever the tool", () => {
    expect(describePermission("shell").title).toBe("Run this command?");
    expect(describePermission("roblox-studio_start_stop_play").title).toBe(
      "Let Roblox Studio start stop play?",
    );
    expect(describePermission("something_new").title).toBe("Allow something new?");
  });

  it("makes acting on someone's Roblox account a decision every time", () => {
    for (const tool of [
      "roblox-studio_upload_image",
      "roblox_studio_upload_image",
      "roblox-studio_open_cloud_invoke",
      "roblox_studio_open_cloud_invoke",
    ]) {
      expect(describePermission(tool).everyTime).toBe(true);
    }
    expect(describePermission("roblox-studio_open_cloud_invoke").title).toBe(
      "Let BloxBot change things on Roblox?",
    );
    expect(describePermission("shell").everyTime).toBeUndefined();
  });
});

describe("the 3D tools page", () => {
  const open = (access: UploadAccessState) => {
    setUp(access);
    vi.spyOn(desktop, "getBlenderToolsState").mockResolvedValue({ state: "not_installed" });
    render(wrap(<ThreeDToolsTab />));
  };

  it("has no key to make, and shows the same live checklist as the card", async () => {
    open("needs_permission");
    expect(await screen.findByText("Off")).toBeTruthy();
    expect(screen.getByText(/no key to make/)).toBeTruthy();
    expect(document.querySelector('[aria-current="step"]')?.textContent).toContain(
      "Allow asset:read",
    );
    expect(screen.getByText(/Watching Studio/)).toBeTruthy();
    expect(screen.queryByLabelText(/API key/i)).toBeNull();
    expect(desktop.getUploadAccess).toHaveBeenCalledWith("studio-1", null);
  });

  it("asks for a place to be chosen when several are open, rather than opened", async () => {
    studio.selected = null;
    open("choose_studio");
    expect(await screen.findByText(/Choose yours in the Studio picker/)).toBeTruthy();
    expect(screen.queryByText(/Open the place you're building/)).toBeNull();
  });

  it("says when uploads are on, and hides the steps", async () => {
    open("ready");
    expect(await screen.findByText("On")).toBeTruthy();
    expect(screen.queryByText(/Watching Studio/)).toBeNull();
  });
});
