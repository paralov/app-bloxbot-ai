import { Check, ChevronDown, Search, X } from "lucide-react";
import type * as React from "react";
import type { KeyboardEvent } from "react";

import { PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/** The one look for anything that floats: pickers, dropdowns, right-click menus and typeaheads. */
export const MENU_SURFACE =
  "rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg outline-hidden";
export const MENU_ITEM =
  "flex min-h-7 w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm outline-none transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 aria-disabled:cursor-default aria-disabled:opacity-60 aria-disabled:hover:bg-transparent";
export const MENU_TRIGGER =
  "flex h-7 min-w-0 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-accent aria-pressed:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground disabled:pointer-events-none disabled:opacity-50";

export const MENU_LABEL = "px-2 py-1.5 text-xs text-muted-foreground";

/** Opens with focus on the menu, not its first item, so nothing looks selected until it's used. */
export function MenuContent(props: React.ComponentProps<typeof PopoverContent>) {
  return (
    <PopoverContent
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        (event.currentTarget as HTMLElement).focus();
      }}
      {...props}
    />
  );
}

export function MenuChevron() {
  return <ChevronDown aria-hidden="true" size={12} className="shrink-0" />;
}

export function MenuLabel({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn(MENU_LABEL, className)} {...props} />;
}

export function MenuItem({
  checked = false,
  description,
  trailing,
  className,
  children,
  ...props
}: React.ComponentProps<"button"> & {
  checked?: boolean;
  description?: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={props.role ? undefined : checked}
      className={cn(MENU_ITEM, className)}
      {...props}
    >
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">{children}</span>
        {description ? (
          <span className="block truncate text-xs text-muted-foreground">{description}</span>
        ) : null}
      </span>
      {trailing ?? (checked ? <Check aria-hidden="true" size={14} className="shrink-0" /> : null)}
    </button>
  );
}

export function MenuSearch({
  value,
  onChange,
  inputRef,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  inputRef?: React.Ref<HTMLInputElement>;
  placeholder: string;
}) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
      <Search aria-hidden="true" size={14} className="shrink-0 text-muted-foreground" />
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder.replace(/\.+$/, "")}
        className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
      />
      {value ? (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear search"
          className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
        >
          <X aria-hidden="true" size={14} />
        </button>
      ) : null}
    </div>
  );
}

/** Arrow keys, Home and End between a menu's items, wrapping at the ends. */
export function moveMenuFocus(event: KeyboardEvent<HTMLElement>, items: readonly HTMLElement[]) {
  const at = items.indexOf(document.activeElement as HTMLElement);
  const to =
    event.key === "ArrowDown"
      ? items[(at + 1) % items.length]
      : event.key === "ArrowUp"
        ? // Focus starts on the menu itself, where up means the last item.
          items[at <= 0 ? items.length - 1 : at - 1]
        : event.key === "Home"
          ? items[0]
          : event.key === "End"
            ? items[items.length - 1]
            : undefined;
  if (!to) return;
  event.preventDefault();
  to.focus();
}
