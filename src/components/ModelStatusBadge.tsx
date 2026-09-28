/** A small tag for a model that isn't generally available yet, or is on its way out. */
export default function ModelStatusBadge({ status }: { status?: string }) {
  if (status === "beta")
    return (
      <span className="shrink-0 rounded bg-amber-100 px-1 text-[9px] font-medium text-amber-700 dark:bg-amber-950/50 dark:text-amber-400">
        beta
      </span>
    );
  if (status === "alpha")
    return (
      <span className="shrink-0 rounded bg-purple-100 px-1 text-[9px] font-medium text-purple-700 dark:bg-purple-950/50 dark:text-purple-300">
        alpha
      </span>
    );
  if (status === "deprecated")
    return (
      <span className="shrink-0 rounded bg-muted px-1 text-[9px] font-medium text-muted-foreground">
        deprecated
      </span>
    );
  return null;
}
