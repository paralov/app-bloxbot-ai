import {
  type ComponentProps,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { MENU_ITEM, MENU_SURFACE } from "@/components/ui/menu";

// Wide and tall enough to keep the menu on screen near the window's edge.
const MENU_WIDTH = 176;
const MENU_HEIGHT = 160;

export function menuPosition(event: { clientX: number; clientY: number }) {
  return {
    x: Math.min(event.clientX, window.innerWidth - MENU_WIDTH),
    y: Math.min(event.clientY, window.innerHeight - MENU_HEIGHT),
  };
}

/** Saves on Enter or clicking away, and cancels on Escape. Several lines save on clicking away. */
export function InlineEdit({
  value: initialValue,
  label,
  maxLength,
  multiline = false,
  placeholder,
  className,
  onDone,
}: {
  value: string;
  label: string;
  maxLength?: number;
  multiline?: boolean;
  placeholder?: string;
  className: string;
  onDone: (value: string | null) => void;
}) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  // Enter unmounts the input, which can blur it as well.
  const doneRef = useRef(false);
  const finish = (next: string | null) => {
    if (doneRef.current) return;
    doneRef.current = true;
    onDone(next);
  };

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const props = {
    ref: inputRef,
    value,
    maxLength,
    placeholder,
    "aria-label": label,
    onChange: (event: { target: { value: string } }) => setValue(event.target.value),
    onClick: (event: MouseEvent) => event.stopPropagation(),
    onKeyDown: (event: React.KeyboardEvent) => {
      // The row uses Enter and Space to select, and Space must still type here.
      event.stopPropagation();
      if (event.key === "Enter" && !multiline) finish(value);
      if (event.key === "Escape") finish(null);
    },
    onBlur: () => finish(value),
    className: `min-w-0 rounded-sm bg-background px-1 text-foreground outline-none ring-1 ring-ring ${className}`,
  };
  return multiline ? <textarea rows={4} {...props} /> : <input {...props} />;
}

/** In the body: a panel around Explorer has a transform, which would move and clip it. */
export function ContextMenu({
  x,
  y,
  label,
  onClose,
  children,
}: {
  x: number;
  y: number;
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const openedFrom = useRef<Element | null>(null);
  useEffect(() => {
    openedFrom.current = document.activeElement;
    menuRef.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    return () => {
      // Back to the row it came from, if nothing else has taken focus since.
      const current = document.activeElement;
      if (!current || current === document.body)
        (openedFrom.current as HTMLElement | null)?.focus();
    };
  }, []);
  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const to =
      event.key === "ArrowDown"
        ? items[(at + 1) % items.length]
        : event.key === "ArrowUp"
          ? items[(at - 1 + items.length) % items.length]
          : event.key === "Home"
            ? items[0]
            : event.key === "End"
              ? items[items.length - 1]
              : undefined;
    if (!to) return;
    event.preventDefault();
    to.focus();
  };
  useEffect(() => {
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", onClose);
    window.addEventListener("blur", onClose);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", onClose);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={label}
      onKeyDown={moveFocus}
      className={`fixed z-[200] ${MENU_SURFACE}`}
      style={{ left: x, top: y, width: MENU_WIDTH }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}

export function ContextMenuItem({
  className = "",
  ...props
}: { className?: string } & ComponentProps<"button">) {
  return (
    <button type="button" role="menuitem" className={`${MENU_ITEM} ${className}`} {...props} />
  );
}
