import { Plus, X } from "lucide-react";
import {
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ColorWheel } from "@/components/ColorWheel";
import {
  ContextMenu,
  ContextMenuItem,
  InlineEdit,
  menuPosition,
} from "@/components/ExplorerControls";
import { MENU_SURFACE, MenuChevron, MenuContent, MenuItem, MenuSearch } from "@/components/ui/menu";
import { Popover, PopoverTrigger } from "@/components/ui/popover";
import { desktop } from "@/lib/desktop";
import {
  ATTRIBUTE_TYPES,
  type AttributeType,
  canEditObject,
  canEditValue,
  colorFromHex,
  colorToBytes,
  colorToHex,
  type ExplorerField,
  type ExplorerFieldKind,
  type ExplorerNode,
  type ExplorerNodeDetails,
  type ExplorerReference,
  FIELD_SHAPES,
  FONT_STYLES,
  FONT_WEIGHTS,
  fieldEditor,
  fieldNumbers,
  fieldOptions,
  formatFieldValue,
  groupFields,
  type HsvColor,
  hexToHsv,
  hsvToHex,
  isAttributeName,
  keepExactNumbers,
  nodeId,
  objectPaths,
  readableFieldValue,
  shortenNumber,
} from "@/lib/explorer";
import { notify } from "@/lib/notifications";
import { useExplorerReference } from "@/providers/ExplorerReferenceProvider";

type InspectorTab = "properties" | "attributes" | "tags";

export type FieldChange =
  | { action: "setField"; kind: ExplorerFieldKind; field: string; value: string; valueType: string }
  | { action: "addAttribute"; field: string; valueType: AttributeType }
  | { action: "removeAttribute" | "addTag" | "removeTag"; field: string };

interface InspectorField extends ExplorerField {
  /** Describes the object rather than being a setting on it, so a reference means the object. */
  fixed?: boolean;
  /** The Name row, which renames through the tree so the selection follows it. */
  rename?: boolean;
}

export function Inspector({
  node,
  studioId,
  onReference,
  onChange,
  onRename,
}: {
  node: ExplorerNode;
  studioId: string | null;
  onReference: (reference: ExplorerReference) => void;
  onChange: (change: FieldChange, onDone: () => void) => void;
  onRename: (name: string) => void;
}) {
  const [details, setDetails] = useState<ExplorerNodeDetails | "loading" | "failed">("loading");
  // Stays put between objects, so comparing attributes doesn't take a click on each one.
  const [tab, setTab] = useState<InspectorTab>("properties");
  const [menu, setMenu] = useState<{ field: InspectorField; x: number; y: number } | null>(null);
  const [editingField, setEditingField] = useState<string | null>(null);
  const [addingAttribute, setAddingAttribute] = useState(false);
  const kind: ExplorerFieldKind = tab === "properties" ? "property" : "attribute";
  const [addingTag, setAddingTag] = useState(false);
  const closeMenu = useCallback(() => setMenu(null), []);
  const readPathRef = useRef<string | null>(null);

  const id = nodeId(node);
  const request = useMemo(
    () => ({
      path: node.path,
      className: node.className,
      occurrence: node.occurrence,
      occurrences: node.occurrences,
    }),
    [node.path, node.className, node.occurrence, node.occurrences],
  );
  const readDetails = useRef<(background: boolean) => void>(() => {});

  useEffect(() => {
    if (!studioId) return;
    let current = true;
    let started = 0;
    let shown = 0;
    const read = (background: boolean) => {
      // An older answer can arrive after a newer one, and mustn't replace it. A newer read that had
      // nothing to say doesn't count, or the answer being waited for would be thrown away.
      const sequence = ++started;
      desktop.getExplorerNodeDetails(studioId, { ...request, background }).then(
        (next) => {
          if (!current || !next || sequence < shown) return;
          shown = sequence;
          setDetails(next);
        },
        (error) => {
          console.error("[explorer] couldn't read object details", error);
          if (current && !background && sequence > shown) setDetails("failed");
        },
      );
    };
    readDetails.current = read;
    // Reading the same object again keeps its rows up, so nothing jumps after an edit.
    if (readPathRef.current !== id) setDetails("loading");
    readPathRef.current = id;
    read(false);
    return () => {
      current = false;
    };
  }, [studioId, id, request]);

  // Studio or the AI may have changed this object while the window was in the background.
  useEffect(() => {
    const reread = () => readDetails.current(true);
    window.addEventListener("focus", reread);
    return () => window.removeEventListener("focus", reread);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: an edit belongs to one object and tab
  useEffect(() => {
    setEditingField(null);
    setAddingAttribute(false);
    setAddingTag(false);
    setMenu(null);
  }, [id, tab]);

  const loaded = typeof details === "object" ? details : null;
  const attributes = loaded?.attributes ?? [];
  const tags = loaded?.tags;
  const groups = useMemo(
    () => [
      {
        category: null,
        fields: [
          {
            name: "Name",
            value: node.name,
            type: "string",
            fixed: true,
            rename: true,
            writable: canEditObject(node),
          },
          { name: "ClassName", value: node.className, fixed: true },
          { name: "Path", value: node.path, fixed: true },
        ] as InspectorField[],
      },
      ...groupFields(
        (loaded?.properties ?? []).filter(
          (field) => field.name !== "Name" && field.name !== "ClassName",
        ),
      ),
    ],
    [loaded?.properties, node],
  );

  const reread = () => readDetails.current(false);
  const setField = (field: InspectorField, value: string | null) => {
    setEditingField(null);
    if (value === null || value === field.value) return;
    if (field.rename) {
      onRename(value);
      return;
    }
    onChange(
      { action: "setField", kind, field: field.name, value, valueType: field.type ?? "string" },
      reread,
    );
  };
  const fieldListProps = {
    editingField,
    onOpenMenu: (event: MouseEvent, field: InspectorField) => {
      event.preventDefault();
      setMenu({ field, ...menuPosition(event) });
    },
    onStartEdit: setEditingField,
    onCancelEdit: () => setEditingField(null),
    onSetField: setField,
  };

  return (
    <div className="h-[42%] shrink-0 overflow-y-auto border-t bg-card/60">
      <div className="sticky top-0 z-10 flex items-center border-b bg-card/95 px-2 py-1.5 backdrop-blur-sm">
        <div role="tablist" aria-label="Object details" className="flex flex-1 gap-0.5">
          <InspectorTabButton tab="properties" current={tab} onSelect={setTab}>
            Properties
          </InspectorTabButton>
          <InspectorTabButton tab="attributes" current={tab} onSelect={setTab}>
            Attributes{attributes.length > 0 ? ` ${attributes.length}` : ""}
          </InspectorTabButton>
          <InspectorTabButton tab="tags" current={tab} onSelect={setTab}>
            Tags{tags && tags.length > 0 ? ` ${tags.length}` : ""}
          </InspectorTabButton>
        </div>
        {tab === "attributes" && loaded && !loaded.locked ? (
          <button
            type="button"
            aria-label="Add attribute"
            title="Add attribute"
            onClick={() => setAddingAttribute(true)}
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Plus size={13} />
          </button>
        ) : null}
        {tab === "tags" && tags ? (
          <button
            type="button"
            aria-label="Add tag"
            title="Add tag"
            onClick={() => setAddingTag(true)}
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Plus size={13} />
          </button>
        ) : null}
      </div>
      {loaded?.locked ? (
        <p className="px-3 pt-2 text-xs text-muted-foreground">
          Studio only reports the first 20 objects at one path, so this one can't be changed here.
        </p>
      ) : null}
      {loaded?.limited ? (
        <p className="px-3 pt-2 text-xs text-muted-foreground">
          {loaded.limited === "redo"
            ? "Studio has something to redo. Tags and some values are hidden to keep it, and return once you've made another change."
            : "Studio couldn't read everything, so tags and some values are hidden."}
        </p>
      ) : null}
      {tab === "properties"
        ? groups.map((group) => (
            <section key={group.category ?? "object"}>
              {group.category ? (
                <h4 className="px-3 pb-0.5 pt-2 text-xs font-medium text-muted-foreground">
                  {group.category}
                </h4>
              ) : null}
              <FieldList fields={group.fields} {...fieldListProps} />
            </section>
          ))
        : null}
      {tab === "attributes" && addingAttribute ? (
        <AddAttributeForm
          taken={attributes.map((attribute) => attribute.name)}
          onCancel={() => setAddingAttribute(false)}
          onAdd={(field, valueType) => {
            setAddingAttribute(false);
            onChange({ action: "addAttribute", field, valueType }, reread);
          }}
        />
      ) : null}
      {tab === "attributes" && attributes.length > 0 ? (
        <FieldList fields={attributes} {...fieldListProps} />
      ) : null}
      {tab === "attributes" && loaded && attributes.length === 0 && !addingAttribute ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">No attributes.</p>
      ) : null}
      {tab === "tags" && addingTag && tags ? (
        <AddTagForm
          tags={tags}
          placeTags={loaded?.placeTags ?? []}
          onCancel={() => setAddingTag(false)}
          onAdd={(field) => {
            setAddingTag(false);
            onChange({ action: "addTag", field }, reread);
          }}
        />
      ) : null}
      {tab === "tags" && tags && tags.length > 0 ? (
        <TagList
          tags={tags}
          onOpenMenu={fieldListProps.onOpenMenu}
          onRemove={(field) => onChange({ action: "removeTag", field }, reread)}
        />
      ) : null}
      {tab === "tags" && tags?.length === 0 && !addingTag ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">No tags.</p>
      ) : null}
      {details === "failed" ? (
        <p className="px-3 pb-3 text-xs text-muted-foreground">
          Couldn't read this object's {tab} from Studio.
        </p>
      ) : null}
      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={`Actions for ${menu.field.name}`}
          onClose={closeMenu}
        >
          <ContextMenuItem
            onClick={() => {
              onReference(
                menu.field.fixed
                  ? node
                  : {
                      ...node,
                      field: { kind: tab === "tags" ? "tag" : kind, name: menu.field.name },
                    },
              );
              setMenu(null);
            }}
          >
            Reference in chat
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => {
              void navigator.clipboard.writeText(readableFieldValue(menu.field)).then(
                () => notify.success("Value copied"),
                () => notify.error("Couldn't copy the value"),
              );
              setMenu(null);
            }}
          >
            Copy value
          </ContextMenuItem>
          {canEditValue(menu.field) ? (
            <ContextMenuItem
              onClick={() => {
                setEditingField(menu.field.name);
                setMenu(null);
              }}
            >
              Edit value
            </ContextMenuItem>
          ) : null}
          {tab === "tags" ? (
            <ContextMenuItem
              className="text-destructive"
              onClick={() => {
                onChange({ action: "removeTag", field: menu.field.name }, reread);
                setMenu(null);
              }}
            >
              Remove tag
            </ContextMenuItem>
          ) : null}
          {tab === "attributes" && !loaded?.locked ? (
            <ContextMenuItem
              className="text-destructive"
              onClick={() => {
                onChange({ action: "removeAttribute", field: menu.field.name }, reread);
                setMenu(null);
              }}
            >
              Remove attribute
            </ContextMenuItem>
          ) : null}
        </ContextMenu>
      ) : null}
    </div>
  );
}

function InspectorTabButton({
  tab,
  current,
  onSelect,
  children,
}: {
  tab: InspectorTab;
  current: InspectorTab;
  onSelect: (tab: InspectorTab) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={tab === current}
      onClick={() => onSelect(tab)}
      className={`rounded-md px-2 py-1 text-xs font-medium transition-colors ${tab === current ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}
    >
      {children}
    </button>
  );
}

function FieldList({
  fields,
  editingField,
  onOpenMenu,
  onStartEdit,
  onCancelEdit,
  onSetField,
}: {
  fields: readonly InspectorField[];
  editingField: string | null;
  onOpenMenu: (event: MouseEvent, field: InspectorField) => void;
  onStartEdit: (name: string) => void;
  onCancelEdit: () => void;
  onSetField: (field: InspectorField, value: string | null) => void;
}) {
  return (
    <dl className="px-1 py-1">
      {fields
        .filter((field) => field.value !== "" || field.fixed || canEditValue(field))
        .map((field) => (
          <FieldRow
            key={field.name}
            field={field}
            editing={editingField === field.name}
            onOpenMenu={onOpenMenu}
            onStartEdit={() => onStartEdit(field.name)}
            onCancelEdit={onCancelEdit}
            onSet={(value) => onSetField(field, value)}
          />
        ))}
    </dl>
  );
}

function FieldRow({
  field,
  editing,
  onOpenMenu,
  onStartEdit,
  onCancelEdit,
  onSet,
}: {
  field: InspectorField;
  editing: boolean;
  onOpenMenu: (event: MouseEvent, field: InspectorField) => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSet: (value: string | null) => void;
}) {
  const editable = canEditValue(field);
  const editor = fieldEditor(field.type);
  const tupleOpen = editing && editor === "tuple";
  const fontOpen = editing && editor === "font";
  return (
    <div
      onContextMenu={(event) => onOpenMenu(event, field)}
      className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-x-2 rounded-md px-2 py-0.5 text-xs hover:bg-accent/60"
    >
      <dt className="truncate text-muted-foreground" title={field.name}>
        {field.name}
      </dt>
      <dd className="flex min-w-0 items-center">
        {editable ? (
          <FieldValue
            field={field}
            editing={editing}
            onStartEdit={onStartEdit}
            onCancelEdit={onCancelEdit}
            onSet={onSet}
          />
        ) : (
          <span
            className={`truncate tabular-nums ${field.fixed ? "text-foreground" : "text-muted-foreground"}`}
            title={readableFieldValue(field)}
          >
            {formatFieldValue(field)}
          </span>
        )}
      </dd>
      {tupleOpen ? (
        <div className="col-span-2 pb-1 pt-1">
          <TupleEditor field={field} onDone={onSet} />
        </div>
      ) : null}
      {fontOpen ? (
        <div className="col-span-2 pb-1 pt-1">
          <FontEditor field={field} onSave={onSet} onClose={onCancelEdit} />
        </div>
      ) : null}
    </div>
  );
}

function FieldValue({
  field,
  editing,
  onStartEdit,
  onCancelEdit,
  onSet,
}: {
  field: InspectorField;
  editing: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSet: (value: string | null) => void;
}) {
  const editor = fieldEditor(field.type);
  const shown = formatFieldValue(field);
  const readable = readableFieldValue(field);
  const openProps = {
    open: editing,
    onOpenChange: (open: boolean) => (open ? onStartEdit() : onCancelEdit()),
  };

  if (editor === "choice") {
    return (
      <ChoicePicker
        {...openProps}
        label={`Change ${field.name}`}
        current={shown}
        options={fieldOptions(field)}
        onPick={onSet}
      />
    );
  }
  if (editor === "palette") {
    return <BrickColorPicker {...openProps} field={field} onPick={onSet} />;
  }
  if (editor === "color") {
    return <ColorPicker {...openProps} field={field} onPick={onSet} />;
  }
  if (editor === "flags") {
    return <FlagsPicker {...openProps} field={field} onSave={onSet} />;
  }
  if (editor === "object") {
    return <ObjectPicker {...openProps} field={field} onPick={onSet} />;
  }

  if (editing && editor === "text") {
    return (
      <InlineEdit
        value={readable}
        label={`Edit ${field.name}`}
        multiline={field.value.includes("\n")}
        className="w-full text-xs"
        onDone={(value) =>
          onSet(value === null || value === readable ? null : keepExactNumbers(value, field))
        }
      />
    );
  }

  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <button
        type="button"
        onClick={onStartEdit}
        aria-label={`Edit ${field.name}`}
        title={readable}
        className="min-w-0 cursor-text truncate rounded-sm text-left text-foreground tabular-nums hover:underline hover:decoration-muted-foreground hover:underline-offset-2"
      >
        {shown === "" ? <span className="text-muted-foreground">Empty</span> : shown}
      </button>
    </span>
  );
}

const PICKER_TRIGGER =
  "flex min-w-0 max-w-full items-center gap-1 rounded-sm text-left text-foreground hover:underline hover:decoration-muted-foreground hover:underline-offset-2";

/** A long list of choices gets a search box, and a very long one only shows what fits. */
const SEARCH_ABOVE = 8;
const MOST_SHOWN = 200;

function ChoicePicker({
  label,
  current,
  options,
  open: controlledOpen,
  onOpenChange,
  onPick,
}: {
  label: string;
  current: string;
  options: readonly string[];
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onPick: (value: string) => void;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const [search, setSearch] = useState("");
  const open = controlledOpen ?? localOpen;
  const setOpen = (next: boolean) => {
    setSearch("");
    setLocalOpen(next);
    onOpenChange?.(next);
  };
  const query = search.trim().toLowerCase();
  const matching = options.filter((option) => option.toLowerCase().includes(query));
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" aria-label={label} title={current} className={PICKER_TRIGGER}>
          <span className="truncate">{current}</span>
          <MenuChevron />
        </button>
      </PopoverTrigger>
      <MenuContent align="end" className={`w-52 p-0 ${MENU_SURFACE}`}>
        {options.length > SEARCH_ABOVE ? (
          <MenuSearch value={search} onChange={setSearch} placeholder="Search..." />
        ) : null}
        <div
          className="app-scrollbar max-h-56 overflow-y-auto p-1"
          role="listbox"
          aria-label={label}
        >
          {matching.slice(0, MOST_SHOWN).map((option) => (
            <MenuItem
              key={option}
              role="option"
              aria-selected={option === current}
              checked={option === current}
              title={option}
              onClick={() => {
                setOpen(false);
                if (option !== current) onPick(option);
              }}
            >
              <span className="truncate">{option}</span>
            </MenuItem>
          ))}
          {matching.length > MOST_SHOWN ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              Search to see the other {matching.length - MOST_SHOWN}.
            </div>
          ) : null}
          {matching.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">No matches.</div>
          ) : null}
        </div>
      </MenuContent>
    </Popover>
  );
}

const NONE_OPTION = "None";

/** Points a property at another object in the place, or at nothing. */
function ObjectPicker({
  field,
  open,
  onOpenChange,
  onPick,
}: {
  field: InspectorField;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (value: string) => void;
}) {
  const { objects } = useExplorerReference();
  const options = useMemo(
    () => (open ? [NONE_OPTION, ...objectPaths(objects)] : []),
    [objects, open],
  );
  return (
    <ChoicePicker
      label={`Change ${field.name}`}
      current={field.value || NONE_OPTION}
      options={options}
      open={open}
      onOpenChange={onOpenChange}
      onPick={(path) => onPick(path === NONE_OPTION ? "" : path)}
    />
  );
}

/** Several can be on at once, so it saves when the list closes instead of on each click. */
function FlagsPicker({
  field,
  open,
  onOpenChange,
  onSave,
}: {
  field: InspectorField;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (value: string | null) => void;
}) {
  const options = fieldOptions(field);
  const saved = useMemo(() => field.value.split(/[\s,]+/).filter(Boolean), [field.value]);
  const [chosen, setChosen] = useState<readonly string[]>(saved);
  useEffect(() => setChosen(saved), [saved]);
  const close = () => {
    const next = options.filter((option) => chosen.includes(option));
    const before = options.filter((option) => saved.includes(option));
    onSave(next.join(", ") === before.join(", ") ? null : next.join(", "));
  };
  return (
    <Popover open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Change ${field.name}`}
          title={field.value}
          className={PICKER_TRIGGER}
        >
          <span className="truncate">{field.value || NONE_OPTION}</span>
          <MenuChevron />
        </button>
      </PopoverTrigger>
      <MenuContent align="end" className={`w-40 ${MENU_SURFACE}`}>
        <div role="listbox" aria-multiselectable="true" aria-label={field.name}>
          {options.map((option) => (
            <MenuItem
              key={option}
              role="option"
              aria-selected={chosen.includes(option)}
              checked={chosen.includes(option)}
              onClick={() =>
                setChosen((current) =>
                  current.includes(option)
                    ? current.filter((item) => item !== option)
                    : [...current, option],
                )
              }
            >
              {option}
            </MenuItem>
          ))}
        </div>
      </MenuContent>
    </Popover>
  );
}

/** A Font's family, weight and style. Each one saves as soon as it changes. */
function FontEditor({
  field,
  onSave,
  onClose,
}: {
  field: InspectorField;
  onSave: (value: string) => void;
  onClose: () => void;
}) {
  const [family = "", weight = "Regular", style = "Normal"] = field.value.split(/,\s*/);
  const [familyText, setFamilyText] = useState(family);
  const saveFamily = () => {
    const next = familyText.trim();
    if (next && next !== family) onSave(`${next}, ${weight}, ${style}`);
  };
  return (
    <div
      className="space-y-1 rounded-md bg-background/60 p-1.5"
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") onClose();
      }}
    >
      <label className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[10px] text-muted-foreground">Family</span>
        <input
          aria-label={`${field.name} family`}
          value={familyText}
          onChange={(event) => setFamilyText(event.target.value)}
          onBlur={saveFamily}
          onKeyDown={(event) => {
            if (event.key === "Enter") saveFamily();
          }}
          className="w-full min-w-0 rounded-sm bg-background px-1 py-0.5 text-foreground outline-none ring-1 ring-border focus:ring-ring"
        />
      </label>
      <div className="flex items-center justify-between gap-2">
        <ChoicePicker
          label={`${field.name} weight`}
          current={weight}
          options={FONT_WEIGHTS}
          onPick={(next) => onSave(`${family}, ${next}, ${style}`)}
        />
        <ChoicePicker
          label={`${field.name} style`}
          current={style}
          options={FONT_STYLES}
          onPick={(next) => onSave(`${family}, ${weight}, ${next}`)}
        />
        <button
          type="button"
          onClick={onClose}
          className="rounded-md bg-secondary px-2 py-0.5 font-medium hover:bg-accent"
        >
          Done
        </button>
      </div>
    </div>
  );
}

function Swatch({ color }: { color: string | undefined }) {
  return (
    <span
      className="h-3 w-3 shrink-0 rounded-sm ring-1 ring-border"
      style={{ backgroundColor: color }}
    />
  );
}

/** Saves once when it closes, so a drag around the wheel is one change in Studio. Escape cancels. */
function ColorPicker({
  field,
  open,
  onOpenChange,
  onPick,
}: {
  field: InspectorField;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (value: string | null) => void;
}) {
  const savedHex = colorToHex(field.value);
  const [color, setColor] = useState<HsvColor>(() => hexToHsv(savedHex));
  const [hexText, setHexText] = useState<string | null>(null);
  const cancelledRef = useRef(false);
  const hex = hsvToHex(color);
  // What the wheel makes of the saved color, so opening and closing it writes nothing.
  const untouchedHex = hsvToHex(hexToHsv(savedHex));
  const bytes = colorToBytes(colorFromHex(hex));

  useEffect(() => {
    if (open) {
      setColor(hexToHsv(savedHex));
      setHexText(null);
      cancelledRef.current = false;
    }
  }, [open, savedHex]);

  const setByte = (index: number, text: string) => {
    const byte = Math.max(0, Math.min(255, Number(text) || 0));
    const next = bytes.map((current, position) => (position === index ? byte : current));
    const nextHex = `#${next.map((part) => part.toString(16).padStart(2, "0")).join("")}`;
    setColor(hexToHsv(nextHex));
    setHexText(null);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          onOpenChange(true);
        } else if (cancelledRef.current || hex === untouchedHex) {
          onPick(null);
        } else {
          onPick(colorFromHex(hex));
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Change ${field.name}`}
          title={savedHex}
          className={PICKER_TRIGGER}
        >
          <Swatch color={open ? hex : savedHex} />
          <span className="truncate tabular-nums">
            {open ? bytes.join(", ") : formatFieldValue(field)}
          </span>
        </button>
      </PopoverTrigger>
      <MenuContent
        align="end"
        className={`w-52 space-y-2 p-3 ${MENU_SURFACE}`}
        onEscapeKeyDown={() => {
          cancelledRef.current = true;
        }}
      >
        <ColorWheel
          color={color}
          onChange={(next) => {
            setColor(next);
            setHexText(null);
          }}
        />
        <div className="flex items-center gap-2 text-xs">
          <Swatch color={hex} />
          <input
            aria-label={`${field.name} hex`}
            value={hexText ?? hex}
            onChange={(event) => {
              const text = event.target.value;
              setHexText(text);
              if (/^#[0-9a-f]{6}$/i.test(text)) setColor(hexToHsv(text.toLowerCase()));
            }}
            className="w-full min-w-0 rounded-sm bg-background px-1 py-0.5 tabular-nums text-foreground outline-none ring-1 ring-border focus:ring-ring"
          />
        </div>
        <div className="grid grid-cols-3 gap-1 text-xs">
          {["R", "G", "B"].map((label, index) => (
            <label key={label} className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[10px] text-muted-foreground">{label}</span>
              <input
                aria-label={`${field.name} ${label}`}
                value={bytes[index]}
                onChange={(event) => setByte(index, event.target.value)}
                className="w-full min-w-0 rounded-sm bg-background px-1 py-0.5 tabular-nums text-foreground outline-none ring-1 ring-border focus:ring-ring"
              />
            </label>
          ))}
        </div>
      </MenuContent>
    </Popover>
  );
}

function BrickColorPicker({
  field,
  open,
  onOpenChange,
  onPick,
}: {
  field: InspectorField;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (value: string) => void;
}) {
  const [search, setSearch] = useState("");
  const options = fieldOptions(field);
  const swatches = field.swatches ?? [];
  const query = search.trim().toLowerCase();
  const current = swatches[options.indexOf(field.value)];
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setSearch("");
        onOpenChange(next);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Change ${field.name}`}
          title={field.value}
          className={PICKER_TRIGGER}
        >
          <Swatch color={current} />
          <span className="truncate">{field.value}</span>
          <MenuChevron />
        </button>
      </PopoverTrigger>
      <MenuContent align="end" className={`w-60 p-0 ${MENU_SURFACE}`}>
        <MenuSearch value={search} onChange={setSearch} placeholder="Search..." />
        <div
          role="listbox"
          aria-label={field.name}
          className="app-scrollbar grid max-h-56 grid-cols-8 gap-1 overflow-y-auto p-2"
        >
          {options.map((option, index) =>
            option.toLowerCase().includes(query) ? (
              <button
                key={option}
                type="button"
                role="option"
                aria-label={option}
                aria-selected={option === field.value}
                title={option}
                onClick={() => {
                  setSearch("");
                  onOpenChange(false);
                  if (option !== field.value) onPick(option);
                }}
                className={`h-5 w-5 rounded-sm ring-1 ${option === field.value ? "ring-2 ring-foreground" : "ring-border hover:ring-foreground/60"}`}
                style={{ backgroundColor: swatches[index] }}
              />
            ) : null,
          )}
        </div>
      </MenuContent>
    </Popover>
  );
}

/** Numbers that belong together, like X, Y and Z. Saves once as a whole, when focus leaves them. */
function TupleEditor({
  field,
  onDone,
}: {
  field: InspectorField;
  onDone: (value: string | null) => void;
}) {
  const shape = FIELD_SHAPES[field.type ?? ""] ?? [];
  const raw = useMemo(() => fieldNumbers(field.value), [field.value]);
  const initial = useMemo(() => raw.map(shortenNumber), [raw]);
  const count = shape.reduce((total, section) => total + section.labels.length, 0);
  const [values, setValues] = useState<string[]>(() =>
    Array.from({ length: count }, (_, index) => initial[index] ?? ""),
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef(false);

  const finish = (save: boolean) => {
    if (doneRef.current) return;
    doneRef.current = true;
    if (!save || values.every((value, index) => value === (initial[index] ?? ""))) {
      onDone(null);
      return;
    }
    if (values.every((value) => value.trim() === "")) {
      onDone("");
      return;
    }
    // Untouched numbers keep every digit, so changing X can't round Y.
    const exact = values.map((value, index) =>
      value === initial[index] ? (raw[index] ?? value) : value.trim(),
    );
    onDone(exact.join(", "));
  };

  useEffect(() => {
    const first = containerRef.current?.querySelector("input");
    first?.focus();
    first?.select();
  }, []);

  let offset = 0;
  return (
    <div
      ref={containerRef}
      className="space-y-1 rounded-md bg-background/60 p-1.5"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) finish(true);
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") finish(true);
        if (event.key === "Escape") finish(false);
      }}
    >
      {shape.map((section) => {
        const start = offset;
        offset += section.labels.length;
        return (
          <div key={section.title ?? "values"}>
            {section.title ? (
              <div className="mb-0.5 text-muted-foreground">{section.title}</div>
            ) : null}
            <div
              className="grid gap-1"
              style={{
                gridTemplateColumns: `repeat(${section.columns ?? section.labels.length}, minmax(0, 1fr))`,
              }}
            >
              {section.labels.map((label, index) => (
                <label key={label} className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate text-[10px] text-muted-foreground">{label}</span>
                  <input
                    aria-label={`${field.name} ${section.title ? `${section.title} ` : ""}${label}`}
                    value={values[start + index]}
                    onChange={(event) =>
                      setValues((current) =>
                        current.map((value, position) =>
                          position === start + index ? event.target.value : value,
                        ),
                      )
                    }
                    className="w-full min-w-0 rounded-sm bg-background px-1 py-0.5 tabular-nums text-foreground outline-none ring-1 ring-border focus:ring-ring"
                  />
                </label>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TagList({
  tags,
  onOpenMenu,
  onRemove,
}: {
  tags: readonly string[];
  onOpenMenu: (event: MouseEvent, field: InspectorField) => void;
  onRemove: (tag: string) => void;
}) {
  return (
    <ul className="px-1 py-1">
      {tags.map((tag) => (
        <li
          key={tag}
          onContextMenu={(event) => onOpenMenu(event, { name: tag, value: tag })}
          className="group flex items-center justify-between gap-2 rounded-md px-2 py-0.5 text-xs hover:bg-accent/60"
        >
          <span className="truncate text-foreground" title={tag}>
            {tag}
          </span>
          <button
            type="button"
            aria-label={`Remove tag ${tag}`}
            title="Remove tag"
            onClick={() => onRemove(tag)}
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
          >
            <X size={11} />
          </button>
        </li>
      ))}
    </ul>
  );
}

function AddTagForm({
  tags,
  placeTags,
  onAdd,
  onCancel,
}: {
  tags: readonly string[];
  placeTags: readonly string[];
  onAdd: (tag: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const trimmed = name.trim();
  const query = trimmed.toLowerCase();
  const suggestions = placeTags.filter(
    (tag) => !tags.includes(tag) && tag.toLowerCase().includes(query),
  );
  const ready = Boolean(trimmed) && !tags.includes(trimmed);
  return (
    <form
      className="space-y-1.5 border-b px-3 py-2 text-xs"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) onAdd(trimmed);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") onCancel();
      }}
    >
      <div className="flex items-center gap-1.5">
        <input
          autoFocus
          aria-label="Tag name"
          placeholder="Tag name"
          value={name}
          maxLength={256}
          onChange={(event) => setName(event.target.value)}
          className="min-w-0 flex-1 rounded-sm bg-background px-1.5 py-1 text-foreground outline-none ring-1 ring-border focus:ring-ring"
        />
        <button
          type="submit"
          disabled={!ready}
          className="rounded-md bg-foreground px-2 py-1 font-medium text-background hover:opacity-90 disabled:opacity-50"
        >
          Add
        </button>
      </div>
      {suggestions.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {suggestions.slice(0, 12).map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => onAdd(tag)}
              className="max-w-full truncate rounded-md bg-secondary px-1.5 py-0.5 hover:bg-accent"
            >
              {tag}
            </button>
          ))}
        </div>
      ) : null}
    </form>
  );
}

function AddAttributeForm({
  taken,
  onAdd,
  onCancel,
}: {
  taken: readonly string[];
  onAdd: (name: string, type: AttributeType) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<AttributeType>("string");
  const [typeOpen, setTypeOpen] = useState(false);
  const trimmed = name.trim();
  const problem = !trimmed
    ? null
    : !isAttributeName(trimmed)
      ? "Use letters, numbers and underscores, without starting with RBX."
      : taken.includes(trimmed)
        ? "This object already has that attribute."
        : null;
  const ready = Boolean(trimmed) && !problem;
  return (
    <form
      className="space-y-1.5 border-b px-3 py-2 text-xs"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) onAdd(trimmed, type);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") onCancel();
      }}
    >
      <div className="flex items-center gap-1.5">
        <input
          autoFocus
          aria-label="Attribute name"
          placeholder="Name"
          value={name}
          maxLength={100}
          onChange={(event) => setName(event.target.value)}
          className="min-w-0 flex-1 rounded-sm bg-background px-1.5 py-1 text-foreground outline-none ring-1 ring-border focus:ring-ring"
        />
        <Popover open={typeOpen} onOpenChange={setTypeOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="Attribute type"
              className="flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-1 text-foreground ring-1 ring-border hover:bg-accent"
            >
              {type}
              <MenuChevron />
            </button>
          </PopoverTrigger>
          <MenuContent align="end" className={`w-40 ${MENU_SURFACE}`}>
            <div className="app-scrollbar max-h-56 overflow-y-auto" role="listbox">
              {ATTRIBUTE_TYPES.map((option) => (
                <MenuItem
                  key={option}
                  role="option"
                  aria-selected={option === type}
                  checked={option === type}
                  onClick={() => {
                    setType(option);
                    setTypeOpen(false);
                  }}
                >
                  {option}
                </MenuItem>
              ))}
            </div>
          </MenuContent>
        </Popover>
      </div>
      {problem ? <p className="text-destructive">{problem}</p> : null}
      <div className="flex justify-end gap-1.5">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md bg-secondary px-2 py-1 font-medium hover:bg-accent"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!ready}
          className="rounded-md bg-foreground px-2 py-1 font-medium text-background hover:opacity-90 disabled:opacity-50"
        >
          Add
        </button>
      </div>
    </form>
  );
}
