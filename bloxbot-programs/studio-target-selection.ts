async function run({ input, callTool }: { input: any; callTool: (name: string, args: Record<string, unknown>) => Promise<unknown> }) {
  const targetKey = typeof input?.targetKey === "string" ? input.targetKey : "";
  if (!targetKey) throw new Error("A Studio target is required");
  const data = normalizeMcpResult(await callTool("list_roblox_studios", {})) ?? {};
  const studios = Array.isArray(data) ? data : Array.isArray(data.studios) ? data.studios : [];
  const selected = studios.find((studio: any) => {
    const rawStudioId = studio?.studio_id ?? studio?.studioId ?? studio?.id;
    return normalizeMcpIdentifier(rawStudioId) === targetKey;
  });
  if (!selected) throw new Error("Studio target could not be verified");
  const rawPlaceId = selected?.place_id ?? selected?.placeId;
  const placeId = normalizeMcpIdentifier(rawPlaceId);
  const rawLabel = selected?.name ?? selected?.place_name ?? selected?.placeName;
  return {
    selected: {
      key: targetKey,
      label: typeof rawLabel === "string" && rawLabel ? rawLabel : targetKey,
      detail: placeId ? "Place " + placeId : "Local place",
      placeId,
    },
    verified: true,
  };
}
