import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const REPOSITORY_URL = "https://github.com/paralov/app-bloxbot-ai";

export function releaseAssetNames(version: string): string[] {
  return [
    `BloxBot-${version}-mac.dmg`,
    `BloxBot-${version}-mac.zip`,
    `BloxBot-Setup-${version}.exe`,
    `BloxBot-${version}-linux-amd64.deb`,
    "latest-mac.yml",
    "latest.yml",
    "latest-linux.yml",
  ];
}

export function changelogSection(changelog: string, version: string): string {
  const heading = `## [${version}]`;
  const start = changelog.indexOf(heading);
  if (start === -1) throw new Error(`CHANGELOG.md has no ${heading} section`);

  const bodyStart = changelog.indexOf("\n", start) + 1;
  const rest = changelog.slice(bodyStart);
  const nextSection = rest.search(/^(?:## \[|\[[^\]]+\]:)/m);
  const body = (nextSection === -1 ? rest : rest.slice(0, nextSection)).trim();
  if (!body) throw new Error(`${heading} has no release notes`);
  return body;
}

export function releaseNotes(changelog: string, version: string): string {
  const tag = `v${version}`;
  const download = `${REPOSITORY_URL}/releases/download/${tag}`;
  const [dmg, , exe, deb] = releaseAssetNames(version);
  return [
    "## Download BloxBot",
    "",
    `- [macOS (.dmg)](${download}/${dmg})`,
    `- [Windows (.exe)](${download}/${exe})`,
    `- [Debian / Ubuntu (.deb)](${download}/${deb})`,
    "",
    changelogSection(changelog, version),
  ].join("\n");
}

async function main(): Promise<void> {
  const version = process.argv[2];
  if (!version) throw new Error("Usage: node scripts/release-notes.ts <version>");
  const changelog = await readFile(new URL("../CHANGELOG.md", import.meta.url), "utf8");
  process.stdout.write(`${releaseNotes(changelog, version)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
