import { describe, expect, it, vi } from "vitest";

import { generateStudioTargetPrograms } from "@/lib/studioTargetPrograms";

const envelope = (name: string) => ({
  version: 1 as const,
  contract: { name, version: "1", inputSchemaVersion: "1", outputSchemaVersion: "1" },
  source:
    "async function run({ input, callTool }: { input: unknown; callTool: Function }) { return {}; }",
});

describe("Studio target program generation", () => {
  it("uses a disposable private session and strict structured output", async () => {
    const create = vi.fn().mockResolvedValue({ data: { id: "private" } });
    const prompt = vi.fn().mockResolvedValue({
      data: {
        info: {
          structured: {
            discovery: envelope("studio-target-discovery"),
            selection: envelope("studio-target-selection"),
          },
        },
      },
    });
    const remove = vi.fn().mockResolvedValue({ data: true });
    const client = { session: { create, prompt, delete: remove } };

    const result = await generateStudioTargetPrograms(
      client as never,
      { providerID: "openai", modelID: "gpt" },
      "build",
    );

    expect(result.discovery.contract.name).toBe("studio-target-discovery");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { bloxbotHidden: true, purpose: "studio-target-programs" },
      }),
      { throwOnError: true },
    );
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionID: "private",
        model: { providerID: "openai", modelID: "gpt" },
        agent: "build",
        format: expect.objectContaining({ type: "json_schema", retryCount: 2 }),
      }),
      { throwOnError: true },
    );
    expect(remove).toHaveBeenCalledWith({ sessionID: "private" }, { throwOnError: true });
  });

  it("always deletes the private session after generation fails", async () => {
    const remove = vi.fn().mockResolvedValue({ data: true });
    const client = {
      session: {
        create: vi.fn().mockResolvedValue({ data: { id: "private" } }),
        prompt: vi.fn().mockRejectedValue(new Error("generation failed")),
        delete: remove,
      },
    };

    await expect(generateStudioTargetPrograms(client as never)).rejects.toThrow(
      "generation failed",
    );
    expect(remove).toHaveBeenCalledOnce();
  });
});
