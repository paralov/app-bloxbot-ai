import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelCard } from "@/components/ModelCard";
import { describePermission } from "@/components/PermissionPrompt";
import { ThreeDToolsTab } from "@/components/ThreeDToolsTab";
import { desktop } from "@/lib/desktop";
import { modelLinksIn } from "@/lib/modelLinks";
import type { ModelFileInfo, ModelUploadResult, UploadAccessState } from "@/types/desktop";

vi.mock("@/components/ModelPreview", () => ({
  default: ({ name }: { name: string }) => <div>Preview of {name}</div>,
}));
const sendMessage = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/mutations/useSendMessage", () => ({
  useSendMessage: () => ({ mutate: sendMessage }),
}));
vi.mock("@/providers/OpenCodeClientProvider", () => ({
  useOpenCodeClient: () => ({ client: null }),
}));
const studio = vi.hoisted(() => ({
  selected: { key: "studio-1" } as { key: string } | null,
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

function setUp(access: UploadAccessState, model: ModelFileInfo | null = file) {
  vi.spyOn(desktop, "readModelFile").mockResolvedValue(model);
  vi.spyOn(desktop, "getUploadAccess").mockResolvedValue({ state: access, modelsFolder: FOLDER });
  vi.spyOn(desktop, "onModelUploadStep").mockReturnValue(() => {});
}

beforeEach(() => {
  studio.selected = { key: "studio-1" };
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
});

describe("before uploads can run", () => {
  it("offers importing by hand with no Studio, and no talk of keys", async () => {
    setUp("no_studio");
    studio.selected = null;
    render(wrap(<ModelCard url={URL_A} />));
    expect(await screen.findByRole("heading", { name: "Crate" })).toBeTruthy();
    expect(screen.getByText("In Studio, open the File menu and choose Import.")).toBeTruthy();
    expect(screen.getByText(/Roblox holds you responsible/)).toBeTruthy();
    expect(screen.getByText("Preview of Crate")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Upload to Roblox" })).toBeNull();
    expect(screen.queryByText(/API key/i)).toBeNull();
  });

  it("shows nothing for a file it can't read", async () => {
    setUp("ready", null);
    const { container } = render(wrap(<ModelCard url={URL_A} />));
    await waitFor(() => expect(desktop.readModelFile).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("walks through Studio's permissions, using this file's folder", async () => {
    setUp("needs_permission");
    render(wrap(<ModelCard url={URL_A} />));
    expect(await screen.findByText("Turn on uploads in Studio")).toBeTruthy();
    expect(screen.getByText("MCP Permissions")).toBeTruthy();
    expect(screen.getByText("Publish & manage assets")).toBeTruthy();
    expect(screen.getByText("asset:write")).toBeTruthy();
    expect(screen.getByText(FOLDER)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy path" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Upload to Roblox" })).toBeNull();
  });

  it("moves on by itself once Studio's permissions are on", async () => {
    setUp("needs_permission");
    render(wrap(<ModelCard url={URL_A} />));
    await screen.findByText("Turn on uploads in Studio");
    vi.spyOn(desktop, "getUploadAccess").mockResolvedValue({
      state: "ready",
      modelsFolder: FOLDER,
    });
    expect(
      await screen.findByRole("button", { name: "Upload to Roblox" }, { timeout: 6000 }),
    ).toBeTruthy();
  }, 8000);

  it("explains an old Studio window and an unpublished place", async () => {
    setUp("reopen_studio");
    render(wrap(<ModelCard url={URL_A} />));
    expect(await screen.findByText(/Close and reopen this place/)).toBeTruthy();
    cleanup();
    setUp("not_published");
    render(wrap(<ModelCard url={URL_A} />));
    expect(await screen.findByText(/Publish this place/)).toBeTruthy();
    expect(screen.getByText("In Studio, open the File menu and choose Import.")).toBeTruthy();
  });
});

describe("the upload click", () => {
  const click = async (result: ModelUploadResult) => {
    vi.spyOn(desktop, "uploadModelToPlace").mockResolvedValue(result);
    render(wrap(<ModelCard url={URL_A} />));
    fireEvent.click(await screen.findByRole("button", { name: "Upload to Roblox" }));
    await waitFor(() =>
      expect(desktop.uploadModelToPlace).toHaveBeenCalledWith(URL_A, "studio-1", "previewed-hash"),
    );
  };

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

  it("explains a rejection, and offers no way to resend", async () => {
    setUp("ready");
    await click({ status: "rejected", assetId: "9" });
    expect(await screen.findByText("Roblox rejected it")).toBeTruthy();
    expect(screen.getByText(/won't send this file again/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /upload|try again/i })).toBeNull();
  });

  it("asks for just the folder when that's all that's missing", async () => {
    setUp("ready");
    await click({ status: "needs_folder", folder: "/elsewhere" });
    expect(await screen.findByText(/hasn't approved this file's folder/)).toBeTruthy();
    expect(screen.getByText("/elsewhere")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByText("Publish & manage assets")).toBeNull();
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

  it("has no key to make, and walks through Studio when uploads are off", async () => {
    open("needs_permission");
    expect(await screen.findByText("Off")).toBeTruthy();
    expect(screen.getByText(/no key to make/)).toBeTruthy();
    expect(screen.getByText("Publish & manage assets")).toBeTruthy();
    expect(screen.getByText(FOLDER)).toBeTruthy();
    expect(screen.queryByLabelText(/API key/i)).toBeNull();
  });

  it("says when uploads are on, and hides the steps", async () => {
    open("ready");
    expect(await screen.findByText("On")).toBeTruthy();
    expect(screen.queryByText("Publish & manage assets")).toBeNull();
  });

  it("explains each other state", async () => {
    for (const [access, pill] of [
      ["reopen_studio", "Reopen Studio"],
      ["not_published", "Publish first"],
      ["no_studio", "Open a place"],
    ] as const) {
      open(access);
      expect(await screen.findByText(pill)).toBeTruthy();
      cleanup();
    }
  });
});
