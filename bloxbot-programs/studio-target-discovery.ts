async function run({ callTool }: { input: unknown; callTool: (name: string, args: Record<string, unknown>) => Promise<unknown> }) {
  const data = normalizeMcpResult(await callTool("list_roblox_studios", {})) ?? {};
  const studios = Array.isArray(data) ? data : Array.isArray(data.studios) ? data.studios : [];
  const targets = studios.flatMap((studio: any) => {
    const rawStudioId = studio?.studio_id ?? studio?.studioId ?? studio?.id;
    const key = normalizeMcpIdentifier(rawStudioId) ?? "";
    if (!key) return [];
    const rawPlaceId = studio?.place_id ?? studio?.placeId;
    const placeId = normalizeMcpIdentifier(rawPlaceId);
    const rawLabel = studio?.name ?? studio?.place_name ?? studio?.placeName;
    return [{
      key,
      label: typeof rawLabel === "string" && rawLabel ? rawLabel : key,
      detail: placeId ? "Place " + placeId : "Local place",
      placeId,
    }];
  });
  return { targets, selectedKey: null };
}
