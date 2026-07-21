import assert from "node:assert/strict";
import { test } from "node:test";
import { changelogSection, releaseNotes } from "./release-notes.ts";

const changelog = `# Changelog

## [Unreleased]

## [1.2.3] - 2026-07-21

### Added

- A useful feature.

## [1.2.2] - 2026-07-20

- An older feature.

[Unreleased]: https://example.com
`;

test("extracts only the requested changelog section", () => {
  assert.equal(changelogSection(changelog, "1.2.3"), "### Added\n\n- A useful feature.");
});

test("excludes changelog link references from the oldest release", () => {
  assert.equal(changelogSection(changelog, "1.2.2"), "- An older feature.");
});

test("puts end-user installers before changelog notes", () => {
  const notes = releaseNotes(changelog, "1.2.3");
  assert.match(notes, /BloxBot-1\.2\.3-mac\.dmg/);
  assert.match(notes, /BloxBot-Setup-1\.2\.3\.exe/);
  assert.match(notes, /BloxBot-1\.2\.3-linux-amd64\.deb/);
  assert.ok(notes.indexOf("## Download BloxBot") < notes.indexOf("### Added"));
});

test("fails when the version is absent", () => {
  assert.throws(() => changelogSection(changelog, "9.9.9"), /no ## \[9\.9\.9\] section/);
});
