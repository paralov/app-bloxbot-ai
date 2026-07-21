import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { changelogSection, releaseAssetNames, releaseNotes } from "./release-notes.ts";

interface ExistingRelease {
  assets: Array<{ name: string }>;
  isDraft: boolean;
  tagName: string;
}

export function assertStableVersion(version: string): void {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error(
      `Release version ${version} is not a stable SemVer. This workflow intentionally rejects prereleases.`,
    );
  }
}

export function assertExactAssetNames(
  actualNames: readonly string[],
  version: string,
  location: string,
): void {
  const expected = releaseAssetNames(version).sort();
  const actual = [...actualNames].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${location} must contain exactly:\n${expected.join("\n")}\n\nFound:\n${actual.join("\n")}`,
    );
  }
}

export function releaseAction(
  release: Pick<ExistingRelease, "isDraft"> | null,
  tagExists: boolean,
): "create" | "resume" {
  if (release) {
    if (!release.isDraft) throw new Error("The release is already published.");
    return "resume";
  }
  if (tagExists) throw new Error("The tag already exists without a resumable draft release.");
  return "create";
}

function command(commandName: string, args: string[]): void {
  const result = spawnSync(commandName, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${commandName} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

function inspectRelease(tag: string): ExistingRelease | null {
  const result = spawnSync("gh", ["release", "view", tag, "--json", "assets,isDraft,tagName"], {
    encoding: "utf8",
  });
  if (result.status === 0) return JSON.parse(result.stdout) as ExistingRelease;
  if (/release not found|not found/i.test(result.stderr)) return null;
  throw new Error(result.stderr.trim() || `Could not inspect release ${tag}`);
}

function remoteTagExists(tag: string): boolean {
  const result = spawnSync("git", [
    "ls-remote",
    "--exit-code",
    "--tags",
    "origin",
    `refs/tags/${tag}`,
  ]);
  if (result.status === 0) return true;
  if (result.status === 2) return false;
  throw new Error(`Could not inspect remote tag ${tag}`);
}

async function readReleaseInputs(): Promise<{
  changelog: string;
  tag: string;
  version: string;
}> {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    version?: unknown;
  };
  if (typeof packageJson.version !== "string") throw new Error("package.json has no version");
  assertStableVersion(packageJson.version);

  const changelog = await readFile(new URL("../CHANGELOG.md", import.meta.url), "utf8");
  changelogSection(changelog, packageJson.version);
  return { changelog, tag: `v${packageJson.version}`, version: packageJson.version };
}

async function validate(): Promise<void> {
  const { tag, version } = await readReleaseInputs();
  const existingRelease = inspectRelease(tag);
  releaseAction(existingRelease, remoteTagExists(tag));

  process.stdout.write(`Release ${tag} is valid and ready.\n`);
}

async function publish(releaseDirectory: string): Promise<void> {
  const { changelog, tag, version } = await readReleaseInputs();
  const target = process.env.GITHUB_SHA;
  if (!target) throw new Error("GITHUB_SHA is required to publish a release");

  const directory = resolve(releaseDirectory);
  const localAssets = await readdir(directory);
  assertExactAssetNames(localAssets, version, "The local release directory");

  const existingRelease = inspectRelease(tag);
  const action = releaseAction(existingRelease, remoteTagExists(tag));
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "bloxbot-release-"));
  const notesPath = join(temporaryDirectory, "release-notes.md");

  try {
    await writeFile(notesPath, `${releaseNotes(changelog, version)}\n`);
    if (action === "create") {
      command("gh", [
        "release",
        "create",
        tag,
        "--draft",
        "--target",
        target,
        "--title",
        `BloxBot ${tag}`,
        "--notes-file",
        notesPath,
      ]);
    } else {
      command("gh", [
        "release",
        "edit",
        tag,
        "--draft",
        "--target",
        target,
        "--title",
        `BloxBot ${tag}`,
        "--notes-file",
        notesPath,
      ]);
    }

    const draft = inspectRelease(tag);
    if (!draft?.isDraft) throw new Error(`${tag} is not a draft release`);

    const expected = new Set(releaseAssetNames(version));
    for (const asset of draft.assets) {
      if (!expected.has(asset.name)) {
        command("gh", ["release", "delete-asset", tag, asset.name, "--yes"]);
      }
    }

    command("gh", [
      "release",
      "upload",
      tag,
      ...releaseAssetNames(version).map((name) => join(directory, name)),
      "--clobber",
    ]);

    const uploaded = inspectRelease(tag);
    if (!uploaded?.isDraft) throw new Error(`${tag} stopped being a draft before verification`);
    assertExactAssetNames(
      uploaded.assets.map((asset) => asset.name),
      version,
      `The remote ${tag} draft`,
    );

    command("gh", ["release", "edit", tag, "--draft=false", "--latest"]);
    process.stdout.write(`Published ${tag} with exactly seven verified assets.\n`);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const [operation, directory] = process.argv.slice(2);
  if (operation === "validate") return validate();
  if (operation === "publish" && directory) return publish(directory);
  throw new Error("Usage: node scripts/release.ts validate | publish <release-directory>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
