import { describe, expect, it } from "vitest";
import { isOpenableUrl } from "../../electron/openableUrl";

describe("isOpenableUrl", () => {
  it("allows web and email links, and files on this computer", () => {
    for (const url of [
      "https://a.dev",
      "http://localhost:3000",
      "mailto:a@b.dev",
      "file:///a/b",
      "file:///C:/a",
    ]) {
      expect(isOpenableUrl(new URL(url))).toBe(true);
    }
  });

  it("refuses files on another machine, and anything else", () => {
    for (const url of [
      "file://evil.example/share/a",
      "file:////evil.example/share/a",
      "file://///evil.example/share/a",
      "file:///\\\\evil.example\\share",
      "file:///%5C%5Cevil.example/share",
      "file:///%2F%2Fevil.example/share",
      "javascript:alert(1)",
      "smb://a/b",
    ]) {
      expect(isOpenableUrl(new URL(url))).toBe(false);
    }
  });
});
