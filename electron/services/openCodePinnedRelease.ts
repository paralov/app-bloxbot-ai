/**
 * The known-good OpenCode release BloxBot installs when there is no cached copy and
 * GitHub's release API can't be reached (for example when it rate-limits a shared IP).
 * It downloads straight from github.com/.../releases/download/..., which the API limit
 * does not cover, and is verified against the SHA-256 below.
 *
 * To bump it:
 * 1. Pick a stable release in the line `OpenCodeBinary.ts` supports that BloxBot has run with.
 * 2. Copy each asset's `digest` (without the `sha256:` prefix) from
 *    `gh api repos/anomalyco/opencode/releases/tags/<tag>`.
 * 3. Run `pnpm check:opencode-pin` to confirm the hashes match GitHub's published digests.
 */

export interface PinnedOpenCodeAsset {
  readonly assetName: string;
  readonly url: string;
  readonly sha256: string;
}

export interface PinnedOpenCodeRelease {
  readonly version: string;
  /** Keyed by `${platform}-${arch}`, one entry per platform BloxBot supports. */
  readonly assets: Readonly<Record<string, PinnedOpenCodeAsset>>;
}

const TAG = "v2.2.5";
const download = (assetName: string) =>
  `https://github.com/anomalyco/opencode/releases/download/${TAG}/${assetName}`;

export const PINNED_OPENCODE_RELEASE: PinnedOpenCodeRelease = {
  version: "2.2.5",
  assets: {
    "darwin-arm64": {
      assetName: "opencode-darwin-arm64.zip",
      url: download("opencode-darwin-arm64.zip"),
      sha256: "25ba9908979fa7d764792c82589b4b5768ab1511154e0317d98aa77d216ce767",
    },
    "darwin-x64": {
      assetName: "opencode-darwin-x64.zip",
      url: download("opencode-darwin-x64.zip"),
      sha256: "4d4419022e6ffbd48afc97c5101bdf001d38b0499f516169b9a80a87a340fd56",
    },
    "win32-x64": {
      assetName: "opencode-windows-x64.zip",
      url: download("opencode-windows-x64.zip"),
      sha256: "2f3bfd6b3527c60c2a882557b20ddc9ba6bdff4b5a8fe61c853da8fcfb3076e8",
    },
    "linux-x64": {
      assetName: "opencode-linux-x64.tar.gz",
      url: download("opencode-linux-x64.tar.gz"),
      sha256: "09f44302c10fd036912f59c81fd1aef5df45dd06f649197f9dfc9bbe2a79614e",
    },
  },
};
