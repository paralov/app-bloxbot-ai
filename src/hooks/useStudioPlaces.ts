import { useQuery } from "@tanstack/react-query";

import { desktop } from "@/lib/desktop";
import { qk } from "@/lib/queryKeys";

export function useStudioPlaces() {
  return useQuery({
    queryKey: qk.studios,
    queryFn: () => desktop.listRobloxStudios(),
    staleTime: 5_000,
    retry: false,
  });
}
