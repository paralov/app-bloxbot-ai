import { Hash, SlidersHorizontal, Tag } from "lucide-react";
import type { ExplorerReferenceKind } from "@/lib/explorer";
import { cn } from "@/lib/utils";

const FIELD_STYLES = {
  property: {
    title: "Property",
    icon: SlidersHorizontal,
    className: "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  attribute: {
    title: "Attribute",
    icon: Tag,
    className: "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  },
  tag: {
    title: "Tag on",
    icon: Hash,
    className: "border-pink-500/25 bg-pink-500/10 text-pink-700 dark:text-pink-300",
  },
} as const;

/** How a Studio reference looks in a message. A property, attribute or tag also says which it is. */
export function ReferenceChip({
  label,
  path,
  fieldKind,
  className,
}: {
  label: string;
  path: string;
  fieldKind?: ExplorerReferenceKind;
  className?: string;
}) {
  const field = fieldKind ? FIELD_STYLES[fieldKind] : null;
  return (
    <span
      className={cn(
        "mx-0.5 inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 align-baseline text-xs font-medium",
        field?.className ?? "border-blue-500/25 bg-blue-500/10 text-blue-700 dark:text-blue-300",
        className,
      )}
      title={field ? `${field.title}${fieldKind === "tag" ? "" : " of"} ${path}` : path}
    >
      {field ? <field.icon aria-hidden="true" size={11} className="shrink-0" /> : null}
      {label}
    </span>
  );
}
