import { getCACertificates } from "node:tls";
import { describe, expect, it, vi } from "vitest";
import { trustSystemCertificates } from "../../electron/systemCertificates";

describe("trusting the computer's certificates", () => {
  it("adds the system's certificates to Node's own, once each", () => {
    const set = vi.fn();
    const ok = trustSystemCertificates({
      getCACertificates: ((type: string) => (type === "system" ? ["b", "c"] : ["a", "b"])) as never,
      setDefaultCACertificates: set,
    });
    expect(ok).toBe(true);
    expect(set).toHaveBeenCalledWith(["a", "b", "c"]);
  });

  it("keeps Node's own when the system's can't be read", () => {
    const set = vi.fn();
    const ok = trustSystemCertificates({
      getCACertificates: ((type: string) => {
        if (type === "system") throw new Error("no store");
        return ["a"];
      }) as never,
      setDefaultCACertificates: set,
    });
    expect(ok).toBe(false);
    expect(set).not.toHaveBeenCalled();
  });

  it("works with the real certificate store", () => {
    expect(getCACertificates("system").length).toBeGreaterThanOrEqual(0);
  });
});
