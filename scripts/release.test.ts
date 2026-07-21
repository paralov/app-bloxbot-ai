import assert from "node:assert/strict";
import { test } from "node:test";
import { assertExactAssetNames, assertStableVersion, releaseAction } from "./release.ts";
import { releaseAssetNames } from "./release-notes.ts";

test("accepts stable versions and rejects prereleases", () => {
  assert.doesNotThrow(() => assertStableVersion("1.2.3"));
  assert.throws(() => assertStableVersion("1.2.3-beta.1"), /intentionally rejects prereleases/);
});

test("requires exactly the seven end-user and updater assets", () => {
  const expected = releaseAssetNames("1.2.3");
  assert.doesNotThrow(() => assertExactAssetNames(expected, "1.2.3", "test assets"));
  assert.throws(
    () => assertExactAssetNames([...expected, "irrelevant.blockmap"], "1.2.3", "test assets"),
    /must contain exactly/,
  );
});

test("resumes a partial draft release after an upload failure", () => {
  assert.equal(releaseAction({ isDraft: true }, true), "resume");
});

test("refuses an already-published release or an orphaned tag", () => {
  assert.throws(() => releaseAction({ isDraft: false }, true), /already published/);
  assert.throws(() => releaseAction(null, true), /tag already exists/);
});
