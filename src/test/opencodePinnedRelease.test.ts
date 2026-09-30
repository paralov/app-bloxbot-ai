import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { getOpenCodeAssetSpec } from "../../electron/services/OpenCodeBinary";
import { PINNED_OPENCODE_RELEASE } from "../../electron/services/openCodePinnedRelease";

const SUPPORTED_PLATFORMS = [
  ["darwin", "arm64"],
  ["darwin", "x64"],
  ["win32", "x64"],
  ["linux", "x64"],
] as const;

describe("pinned OpenCode release", () => {
  it("has a verified download for every supported platform", () => {
    expect(PINNED_OPENCODE_RELEASE.version).toMatch(/^1\.\d+\.\d+$/);
    expect(Object.keys(PINNED_OPENCODE_RELEASE.assets).sort()).toEqual(
      SUPPORTED_PLATFORMS.map(([platform, arch]) => `${platform}-${arch}`).sort(),
    );
    for (const [platform, arch] of SUPPORTED_PLATFORMS) {
      const spec = Effect.runSync(getOpenCodeAssetSpec(platform, arch));
      const asset = PINNED_OPENCODE_RELEASE.assets[`${platform}-${arch}`];
      expect(asset?.assetName).toBe(spec.archiveName);
      expect(asset?.url).toBe(
        `https://github.com/anomalyco/opencode/releases/download/v${PINNED_OPENCODE_RELEASE.version}/${spec.archiveName}`,
      );
      expect(asset?.sha256).toMatch(/^[a-f\d]{64}$/);
    }
  });

  // Needs network, so it only runs through `pnpm check:opencode-pin`.
  it.runIf(process.env.OPENCODE_PIN_CHECK === "1")(
    "matches the digests GitHub publishes for the release",
    async () => {
      const token = process.env.GITHUB_TOKEN;
      const response = await fetch(
        `https://api.github.com/repos/anomalyco/opencode/releases/tags/v${PINNED_OPENCODE_RELEASE.version}`,
        {
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "BloxBot",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        },
      );
      expect(response.status).toBe(200);
      const release = (await response.json()) as {
        draft: boolean;
        prerelease: boolean;
        assets: { name: string; browser_download_url: string; digest: string | null }[];
      };
      expect(release.draft).toBe(false);
      expect(release.prerelease).toBe(false);
      for (const asset of Object.values(PINNED_OPENCODE_RELEASE.assets)) {
        const published = release.assets.find((candidate) => candidate.name === asset.assetName);
        expect(published?.browser_download_url).toBe(asset.url);
        expect(published?.digest).toBe(`sha256:${asset.sha256}`);
      }
    },
    30_000,
  );
});
