import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelCard } from "@/components/ModelCard";
import { describePermission } from "@/components/PermissionPrompt";
import { RobloxKeyWizard } from "@/components/RobloxKeyWizard";
import { ThreeDToolsTab } from "@/components/ThreeDToolsTab";
import { loadConfig, patchConfig } from "@/lib/config";
import { desktop } from "@/lib/desktop";
import { modelLinksIn } from "@/lib/modelLinks";
import { notify } from "@/lib/notifications";
import { onSettingsRequest } from "@/lib/settingsRequest";
import { offerUploadsOnce } from "@/lib/uploadOffer";
import type {
  ModelFileInfo,
  ModelUploadResult,
  RobloxKeyCheck,
  RobloxUploadState,
} from "@/types/desktop";

vi.mock("@/components/ModelPreview", () => ({
  default: ({ name }: { name: string }) => <div>Preview of {name}</div>,
}));
vi.mock("@/providers/OpenCodeClientProvider", () => ({
  useOpenCodeClient: () => ({ client: null }),
}));
vi.mock("@/lib/config", () => ({ loadConfig: vi.fn(), patchConfig: vi.fn() }));
vi.mock("@/lib/notifications", () => ({
  notify: { message: vi.fn(), success: vi.fn(), error: vi.fn() },
}));
const studio = vi.hoisted(() => ({ selected: { key: "studio-1" } as { key: string } | null }));
vi.mock("@/providers/StudioTargetProvider", () => ({
  useStudioTargetOptional: () => ({ selected: studio.selected }),
}));

const URL_A = "file:///Users/me/BloxBot/crate/Crate.fbx";
const file: ModelFileInfo = {
  name: "Crate",
  fileName: "Crate.fbx",
  path: "/Users/me/BloxBot/crate/Crate.fbx",
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

function setUp(uploads: RobloxUploadState, model: ModelFileInfo | null = file) {
  vi.spyOn(desktop, "readModelFile").mockResolvedValue(model);
  vi.spyOn(desktop, "getRobloxUploadState").mockResolvedValue(uploads);
  vi.spyOn(desktop, "onModelUploadStep").mockReturnValue(() => {});
}
const ON: RobloxUploadState = { state: "on", ownerId: "1", ownerName: "CipherBolt" };

beforeEach(() => {
  studio.selected = { key: "studio-1" };
  vi.mocked(loadConfig).mockResolvedValue({
    firstModelShown: null,
    uploadsOffered: false,
  } as never);
  vi.mocked(patchConfig).mockResolvedValue(undefined as never);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.mocked(notify.message).mockClear();
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

describe("the model card, for someone new", () => {
  it("gives the import steps, the warning and no key talk", async () => {
    setUp({ state: "off" });
    render(wrap(<ModelCard url={URL_A} />));
    expect(await screen.findByRole("heading", { name: "Crate" })).toBeTruthy();
    expect(screen.getByText("In Studio, open the File menu and choose Import.")).toBeTruthy();
    expect(screen.getByText(/Roblox holds you responsible/)).toBeTruthy();
    expect(screen.getByText("Preview of Crate")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Upload to Roblox" })).toBeNull();
    expect(screen.queryByText(/key/i)).toBeNull();
  });

  it("shows nothing for a file it can't read", async () => {
    setUp({ state: "off" }, null);
    const { container } = render(wrap(<ModelCard url={URL_A} />));
    await waitFor(() => expect(desktop.readModelFile).toHaveBeenCalled());
    expect(container.textContent).toBe("");
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

  it("does nothing until it's pressed", async () => {
    setUp(ON);
    vi.spyOn(desktop, "uploadModelToPlace").mockResolvedValue({
      status: "failed",
      reason: "no_key",
    });
    render(wrap(<ModelCard url={URL_A} />));
    await screen.findByRole("button", { name: "Upload to Roblox" });
    expect(desktop.uploadModelToPlace).not.toHaveBeenCalled();
  });

  it("reports the model added", async () => {
    setUp(ON);
    await click({ status: "added", assetId: "555", path: "game.Workspace.Crate" });
    expect(await screen.findByText("Uploaded and added to your place")).toBeTruthy();
    expect(screen.getByText(/asset 555/)).toBeTruthy();
  });

  it("explains a rejection, and offers no way to resend", async () => {
    setUp(ON);
    await click({ status: "rejected", assetId: "9" });
    expect(await screen.findByText("Roblox rejected it")).toBeTruthy();
    expect(screen.getByText(/won't send this file again/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /upload|try again/i })).toBeNull();
  });

  it("names both accounts when they differ", async () => {
    setUp(ON);
    await click({ status: "wrong_account", keyOwner: "CipherBolt", studio: "Other" });
    expect(
      await screen.findByText(/belongs to CipherBolt, but Studio is signed in to Other/),
    ).toBeTruthy();
    expect(screen.getByText(/Nothing was uploaded/)).toBeTruthy();
  });

  it("gives the fix for a key Roblox turned off", async () => {
    setUp(ON);
    const open = vi.spyOn(desktop, "openUrl").mockResolvedValue();
    await click({ status: "failed", reason: "key_off" });
    expect(await screen.findByText(/switch Enable Key off and back on/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open API Keys page" }));
    expect(open).toHaveBeenCalledWith(
      expect.stringContaining("create.roblox.com/dashboard/credentials"),
    );
  });

  it("makes someone look at a file that changed, before it can go up", async () => {
    setUp(ON);
    await click({ status: "failed", reason: "file_changed" });
    expect(await screen.findByText(/changed after this preview/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Check the new version" }));
    expect(await screen.findByRole("button", { name: "Upload to Roblox" })).toBeTruthy();
  });

  it("lets someone decline, and change their mind", async () => {
    setUp(ON);
    render(wrap(<ModelCard url={URL_A} />));
    fireEvent.click(await screen.findByRole("button", { name: "Don't upload" }));
    expect(screen.getByText(/Nothing went to Roblox/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Upload after all" }));
    expect(screen.getByRole("button", { name: "Upload to Roblox" })).toBeTruthy();
  });

  it("asks for Studio before it can upload", async () => {
    setUp(ON);
    studio.selected = null;
    const upload = vi.spyOn(desktop, "uploadModelToPlace");
    render(wrap(<ModelCard url={URL_A} />));
    const button = await screen.findByRole("button", { name: "Upload to Roblox" });
    expect(screen.getByText(/Open your place in Studio/)).toBeTruthy();
    expect(button.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(button);
    expect(upload).not.toHaveBeenCalled();
  });

  it("remembers a file already sent", async () => {
    setUp(ON, { ...file, sent: { assetId: "9", moderation: "rejected" } });
    render(wrap(<ModelCard url={URL_A} />));
    expect(await screen.findByText("Roblox rejected it")).toBeTruthy();
  });

  it("offers to add a file that's already on the account", async () => {
    setUp(ON, { ...file, sent: { assetId: "5", moderation: "approved" } });
    render(wrap(<ModelCard url={URL_A} />));
    expect(await screen.findByRole("button", { name: "Add it to your place" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Upload to Roblox" })).toBeNull();
  });
});

describe("the offer", () => {
  it("stays quiet for the first model, and asks once on the second", async () => {
    await offerUploadsOnce("file:///a.fbx");
    expect(notify.message).not.toHaveBeenCalled();
    expect(patchConfig).toHaveBeenCalledWith({ firstModelShown: "file:///a.fbx" });

    vi.mocked(loadConfig).mockResolvedValue({
      firstModelShown: "file:///a.fbx",
      uploadsOffered: false,
    } as never);
    await offerUploadsOnce("file:///a.fbx");
    expect(notify.message).not.toHaveBeenCalled();

    await offerUploadsOnce("file:///b.fbx");
    expect(notify.message).toHaveBeenCalledTimes(1);
    expect(patchConfig).toHaveBeenCalledWith({ uploadsOffered: true });

    vi.mocked(loadConfig).mockResolvedValue({
      firstModelShown: "file:///a.fbx",
      uploadsOffered: true,
    } as never);
    await offerUploadsOnce("file:///c.fbx");
    expect(notify.message).toHaveBeenCalledTimes(1);
  });

  it("still counts two models shown at the same moment", async () => {
    let config = { firstModelShown: null as string | null, uploadsOffered: false };
    vi.mocked(loadConfig).mockImplementation(async () => ({ ...config }) as never);
    vi.mocked(patchConfig).mockImplementation(async (patch) => {
      config = { ...config, ...(patch as Partial<typeof config>) };
      return undefined as never;
    });
    await Promise.all([offerUploadsOnce("file:///a.fbx"), offerUploadsOnce("file:///b.fbx")]);
    expect(notify.message).toHaveBeenCalledTimes(1);
  });

  it("leads to the guide", async () => {
    vi.mocked(loadConfig).mockResolvedValue({
      firstModelShown: "file:///a.fbx",
      uploadsOffered: false,
    } as never);
    const opened = vi.fn();
    const stop = onSettingsRequest(opened);
    await offerUploadsOnce("file:///b.fbx");
    const options = vi.mocked(notify.message).mock.calls[0]?.[1] as {
      action: { onClick: () => void };
    };
    act(() => options.action.onClick());
    expect(opened).toHaveBeenCalledWith("uploads");
    stop();
  });

  it("isn't made to someone who already has uploads on", async () => {
    setUp(ON);
    vi.mocked(loadConfig).mockResolvedValue({
      firstModelShown: "file:///other.fbx",
      uploadsOffered: false,
    } as never);
    render(wrap(<ModelCard url={URL_A} />));
    await screen.findByRole("button", { name: "Upload to Roblox" });
    expect(notify.message).not.toHaveBeenCalled();
  });
});

const toPasteStep = async () => {
  for (let step = 0; step < 6; step++) {
    fireEvent.click(await screen.findByRole("button", { name: "Next" }));
  }
  return screen.findByLabelText("API key");
};

describe("the permission prompt", () => {
  it("speaks plainly, whatever the tool", () => {
    expect(describePermission("shell").title).toBe("Run this command?");
    expect(describePermission("roblox-studio_start_stop_play").title).toBe(
      "Let Roblox Studio start stop play?",
    );
    expect(describePermission("something_new").title).toBe("Allow something new?");
  });

  it("makes uploading images a decision every time", () => {
    const upload = describePermission("roblox-studio_upload_image");
    expect(upload.title).toBe("Upload images to your Roblox account?");
    expect(upload.everyTime).toBe(true);
    expect(describePermission("roblox_studio_upload_image").everyTime).toBe(true);
    expect(describePermission("shell").everyTime).toBeUndefined();
  });
});

describe("the key guide", () => {
  const checked: Extract<RobloxKeyCheck, { result: "checked" }> = {
    result: "checked",
    ownerId: "1",
    ownerName: "CipherBolt",
    active: true,
    canUpload: true,
    reachesGroups: false,
    extraAccess: [],
    studio: { id: "1", name: "CipherBolt" },
  };
  const openAndCheck = async (check: RobloxKeyCheck, onClose = () => {}) => {
    setUp({ state: "off" });
    vi.spyOn(desktop, "checkRobloxKey").mockResolvedValue(check);
    render(wrap(<RobloxKeyWizard onClose={onClose} />));
    fireEvent.change(await toPasteStep(), { target: { value: " the-key " } });
    fireEvent.click(screen.getByRole("button", { name: "Check key" }));
    await waitFor(() => expect(desktop.checkRobloxKey).toHaveBeenCalledWith("the-key", "studio-1"));
  };

  it("starts as an opt-in, and opens from the page", async () => {
    setUp({ state: "off" });
    vi.spyOn(desktop, "getBlenderToolsState").mockResolvedValue({ state: "not_installed" });
    render(wrap(<ThreeDToolsTab />));
    expect(screen.queryByLabelText("API key")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Set up uploads" }));
    expect(screen.getByRole("heading", { name: "Connect Roblox" })).toBeTruthy();
    expect(screen.getByText("Step 1 of 7")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "3D tools" }));
    expect(await screen.findByRole("button", { name: "Set up uploads" })).toBeTruthy();
  });

  it("walks one step at a time, covers the traps on Roblox's page, and can go back", async () => {
    setUp({ state: "off" });
    render(wrap(<RobloxKeyWizard onClose={() => {}} />));
    const expected = [
      /It says I don't have permission/,
      /If the name's taken/,
      /not asset-permissions or legacy-assets/,
      /every group you're in/,
      /open it twice/,
      /treat it like a password/,
      /never into a chat/,
    ];
    for (const [index, text] of expected.entries()) {
      expect(screen.getByText(`Step ${index + 1} of 7`)).toBeTruthy();
      expect(screen.getByText(text)).toBeTruthy();
      if (index < 6) fireEvent.click(screen.getByRole("button", { name: "Next" }));
    }
    expect((screen.getByLabelText("API key") as HTMLInputElement).type).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("Step 6 of 7")).toBeTruthy();
    expect(document.activeElement?.textContent).toBe("Save the key and copy it");
  });

  it("turns on a good key, and leaves the guide", async () => {
    const onClose = vi.fn();
    await openAndCheck(checked, onClose);
    const save = vi.spyOn(desktop, "saveRobloxKey").mockResolvedValue();
    expect(await screen.findByText(/same account Studio is signed in to/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Turn on uploads" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith("the-key"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("blocks a key on another account, with no way around it", async () => {
    await openAndCheck({ ...checked, studio: { id: "2", name: "Other" } });
    expect(
      await screen.findByText(/belongs to CipherBolt, but Studio is signed in to Other/),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Turn on uploads|Use it anyway/ })).toBeNull();
  });

  it("blocks a key that can't upload or is switched off", async () => {
    await openAndCheck({ ...checked, canUpload: false });
    expect(await screen.findByText(/add read and write under assets/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Turn on uploads|Use it anyway/ })).toBeNull();
    cleanup();
    vi.restoreAllMocks();
    await openAndCheck({ ...checked, active: false });
    expect(await screen.findByText(/switch Enable Key off and back on/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Turn on uploads|Use it anyway/ })).toBeNull();
  });

  it("warns about a key that does too much, and lets someone decide", async () => {
    await openAndCheck({
      ...checked,
      reachesGroups: true,
      extraAccess: ["universe-datastores.objects"],
    });
    expect(await screen.findByText(/turn on Restrict by Creator/)).toBeTruthy();
    expect(screen.getByText(/also reach universe-datastores.objects/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use it anyway" })).toBeTruthy();
  });

  it("asks for Studio when it can't compare accounts, and can check again", async () => {
    await openAndCheck({ ...checked, studio: null });
    expect(await screen.findByText(/checks\s+again before each upload/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Turn on uploads" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
  });

  it("says when the key isn't one", async () => {
    await openAndCheck({ result: "not_a_key" });
    expect(await screen.findByText(/doesn't recognize this key/)).toBeTruthy();
  });

  it("shows who it's on, and forgets the key", async () => {
    setUp(ON);
    vi.spyOn(desktop, "getBlenderToolsState").mockResolvedValue({ state: "not_installed" });
    const forget = vi.spyOn(desktop, "forgetRobloxKey").mockResolvedValue();
    render(wrap(<ThreeDToolsTab />));
    expect(await screen.findByText(/Models go to CipherBolt/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Turn off and forget the key" }));
    await waitFor(() => expect(forget).toHaveBeenCalled());
  });
});
