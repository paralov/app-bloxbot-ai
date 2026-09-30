/**
 * The known-good OpenCode release BloxBot installs when there is no cached copy and
 * GitHub's release API can't be reached (for example when it rate-limits a shared IP).
 * It downloads straight from github.com/.../releases/download/..., which the API limit
 * does not cover, and is verified against the SHA-256 below.
 *
 * To bump it:
 * 1. Pick a stable 1.x.x release that BloxBot has run with.
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

const TAG = "v1.18.33";
const download = (assetName: string) =>
  `https://github.com/anomalyco/opencode/releases/download/${TAG}/${assetName}`;

export const PINNED_OPENCODE_RELEASE: PinnedOpenCodeRelease = {
  version: "1.18.33",
  assets: {
    "darwin-arm64": {
      assetName: "opencode-darwin-arm64.zip",
      url: download("opencode-darwin-arm64.zip"),
      sha256: "24b12873e605b3db3387cb355f43ba7451cd6065c180d8c188663337d2eeb553",
    },
    "darwin-x64": {
      assetName: "opencode-darwin-x64.zip",
      url: download("opencode-darwin-x64.zip"),
      sha256: "90c7e7d9ffa0d8691ca0f15b42a7b89b72e17a4d26074b9ef06559ff87b221ec",
    },
    "win32-x64": {
      assetName: "opencode-windows-x64.zip",
      url: download("opencode-windows-x64.zip"),
      sha256: "cc827fda2e32502373c5de25a4b78471766b99881d12a441ae5b9fcff39c5780",
    },
    "linux-x64": {
      assetName: "opencode-linux-x64.tar.gz",
      url: download("opencode-linux-x64.tar.gz"),
      sha256: "e546123213ae47909a4268692aa4b94950d011afe9cac9938753a2194f1c16d5",
    },
  },
};
