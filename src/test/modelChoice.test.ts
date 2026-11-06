import { describe, expect, it } from "vitest";
import { goneReason, pickFreeModel, replacementModel } from "@/lib/modelChoice";
import type { ProviderListResponse } from "@/lib/opencode/types";

const model = (id: string, status = "active") => ({ id, name: `${id} name`, status });

/** OpenCode's free tier, with its default, plus a paid provider. */
function providers(): ProviderListResponse {
  return {
    all: [
      {
        id: "opencode",
        name: "OpenCode Zen",
        source: "custom",
        models: {
          "big-pickle": model("big-pickle"),
          "crouton-alpha-free": model("crouton-alpha-free", "alpha"),
          "flash-free": model("flash-free"),
          "old-free": model("old-free", "deprecated"),
          "glm-free": model("glm-free"),
        },
      },
      {
        id: "anthropic",
        name: "Anthropic",
        source: "api",
        models: { sonnet: model("sonnet") },
      },
    ],
    connected: ["opencode", "anthropic"],
    default: { opencode: "flash-free", anthropic: "sonnet" },
  } as unknown as ProviderListResponse;
}

const none = new Set<string>();

describe("another free model", () => {
  it("prefers OpenCode's default free model over the rest", () => {
    expect(
      pickFreeModel(providers(), { avoid: ["opencode/big-pickle"], unavailable: none }),
    ).toEqual({ key: "opencode/flash-free", name: "flash-free name" });
  });

  it("skips the failed and selected models, refused, hidden and deprecated ones, then previews", () => {
    expect(
      pickFreeModel(providers(), {
        avoid: ["opencode/flash-free", "opencode/big-pickle"],
        unavailable: new Set(["opencode/glm-free"]),
      }),
    ).toEqual({ key: "opencode/crouton-alpha-free", name: "crouton-alpha-free name" });
    expect(
      pickFreeModel(providers(), {
        avoid: ["opencode/flash-free"],
        unavailable: none,
        hidden: new Set(["opencode/big-pickle"]),
      })?.key,
    ).toBe("opencode/glm-free");
  });

  it("offers nothing without the free tier, as a Zen key makes those models paid", () => {
    const list = providers();
    list.all[0].source = "api";
    expect(pickFreeModel(list, { avoid: [], unavailable: none })).toBeUndefined();
  });
});

describe("a saved model that's gone", () => {
  it("finds models OpenCode stopped listing, and ones refused in the region", () => {
    const refused = new Set(["opencode/crouton-alpha-free"]);
    expect(goneReason(providers(), "opencode/nemotron-3-ultra-free", none)).toBe("retired");
    expect(goneReason(providers(), "opencode/crouton-alpha-free", refused)).toBe("region");
    expect(goneReason(providers(), "opencode/flash-free", refused)).toBeUndefined();
    // A provider that isn't listed is a disconnect, which is handled on its own.
    expect(goneReason(providers(), "openrouter/anything", none)).toBeUndefined();
  });

  it("moves to the provider's default, as OpenCode does with no model set", () => {
    expect(replacementModel(providers(), "opencode/space-bunny-free", none)).toEqual({
      key: "opencode/flash-free",
      name: "flash-free name",
    });
    expect(replacementModel(providers(), "anthropic/claude-2", none)?.key).toBe("anthropic/sonnet");
  });

  it("falls back to another free model when the default can't be used either", () => {
    expect(
      replacementModel(providers(), "opencode/exo-free", new Set(["opencode/flash-free"]))?.key,
    ).toBe("opencode/big-pickle");
  });
});
