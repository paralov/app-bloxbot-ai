import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { LexicalTypeaheadMenuPlugin, MenuOption } from "@lexical/react/LexicalTypeaheadMenuPlugin";
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  DecoratorNode,
  type EditorConfig,
  type LexicalEditor,
  type NodeKey,
  type SerializedEditorState,
  type SerializedLexicalNode,
} from "lexical";
import { type LucideIcon, SquareSlash } from "lucide-react";
import posthog from "posthog-js/dist/module.full.no-external.js";
import {
  type ClipboardEventHandler,
  forwardRef,
  type ReactNode,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { iconForClass } from "@/components/Explorer";
import { ReferenceChip } from "@/components/ReferenceChip";
import { MENU_LABEL, MENU_SURFACE } from "@/components/ui/menu";
import { analyticsProperties } from "@/lib/analytics";
import type { ExplorerNode, ExplorerReference } from "@/lib/explorer";
import type { Command } from "@/lib/opencode/types";
import {
  buildObjectSearchIndex,
  CLIENT_COMMANDS,
  promptTriggerMatch,
  type SearchableObject,
  searchCommands,
  searchObjects,
} from "@/lib/promptSuggestions";

type TokenKind = "object" | "command";

function escapeTagBody(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

function escapeTagValue(value: string) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

interface SerializedPromptTokenNode extends SerializedLexicalNode {
  kind: TokenKind;
  label: string;
  value: string;
  field?: ExplorerReference["field"];
  type: "prompt-token";
  version: 1;
}

class PromptTokenNode extends DecoratorNode<ReactNode> {
  __kind: TokenKind;
  __label: string;
  __value: string;
  /** A property or attribute of the object, when the reference is to one of those. */
  __field: ExplorerReference["field"];

  static getType() {
    return "prompt-token";
  }

  static clone(node: PromptTokenNode) {
    return new PromptTokenNode(node.__kind, node.__label, node.__value, node.__field, node.__key);
  }

  static importJSON(serializedNode: SerializedLexicalNode & Record<string, unknown>) {
    const serialized = serializedNode as unknown as SerializedPromptTokenNode;
    return new PromptTokenNode(
      serialized.kind,
      serialized.label,
      serialized.value,
      serialized.field,
    );
  }

  constructor(
    kind: TokenKind,
    label: string,
    value: string,
    field?: ExplorerReference["field"],
    key?: NodeKey,
  ) {
    super(key);
    this.__kind = kind;
    this.__label = label;
    this.__value = value;
    this.__field = field;
  }

  createDOM(_config: EditorConfig) {
    const span = document.createElement("span");
    span.className = "inline";
    return span;
  }

  updateDOM() {
    return false;
  }

  exportJSON(): SerializedPromptTokenNode {
    return {
      ...super.exportJSON(),
      kind: this.__kind,
      label: this.__label,
      value: this.__value,
      field: this.__field,
      type: "prompt-token",
      version: 1,
    };
  }

  getTextContent() {
    if (this.__kind === "object") {
      const field = this.__field
        ? ` ${this.__field.kind}="${escapeTagValue(this.__field.name)}"`
        : "";
      return `<Instance reference="${escapeTagValue(this.__value)}"${field}>${escapeTagBody(this.__label)}</Instance>`;
    }
    return this.__value;
  }

  isInline() {
    return true;
  }

  decorate() {
    if (this.__kind === "object") {
      return (
        <ReferenceChip
          label={this.__label}
          path={this.__value}
          fieldKind={this.__field?.kind}
          className="select-all"
        />
      );
    }
    return (
      <span
        className="mx-0.5 inline-flex select-all items-center rounded-md border border-violet-500/25 bg-violet-500/10 px-1.5 py-0.5 align-baseline text-xs font-medium text-violet-700 dark:text-violet-300"
        title={this.__value}
      >
        {this.__label}
      </span>
    );
  }
}

function $createPromptTokenNode(
  kind: TokenKind,
  label: string,
  value: string,
  field?: ExplorerReference["field"],
) {
  return new PromptTokenNode(kind, label, value, field);
}

class PromptOption extends MenuOption {
  kind: TokenKind;
  label: string;
  detail: string;
  value: string;
  glyph: LucideIcon;

  constructor(
    key: string,
    kind: TokenKind,
    label: string,
    detail: string,
    value: string,
    glyph: LucideIcon,
  ) {
    super(key);
    this.kind = kind;
    this.label = label;
    this.detail = detail;
    this.value = value;
    this.glyph = glyph;
  }
}

const EMPTY_OBJECT_INDEX: readonly SearchableObject[] = [];
const EMPTY_COMMANDS: readonly Command[] = [];
const OBJECT_TRIGGER = promptTriggerMatch("@");
const COMMAND_TRIGGER = promptTriggerMatch("/");
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function SetEditorRef({ editorRef }: { editorRef: React.MutableRefObject<LexicalEditor | null> }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    editorRef.current = editor;
    return () => {
      editorRef.current = null;
    };
  }, [editor, editorRef]);
  return null;
}

function DomInputFallbackPlugin() {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    const root = editor.getRootElement();
    if (!root) return;
    const handleInput = (event: Event) => {
      if ((event as InputEvent).inputType) return;
      const next = root.textContent ?? "";
      editor.update(() => {
        $getRoot()
          .clear()
          .append($createParagraphNode().append($createTextNode(next)));
      });
    };
    root.addEventListener("input", handleInput, true);
    return () => root.removeEventListener("input", handleInput, true);
  }, [editor]);
  return null;
}

/**
 * Sits on top of the composer, at its full width. The height follows the list
 * as it filters, and closing leaves a copy behind to fade out, because Lexical
 * unmounts the menu at once.
 */
function SuggestionMenu({ container, children }: { container: Element; children: ReactNode }) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number>();

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => setHeight(list.offsetHeight + 2);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    return () => {
      if (!surface || window.matchMedia?.(REDUCED_MOTION).matches) return;
      const ghost = surface.cloneNode(true) as HTMLElement;
      ghost.removeAttribute("data-prompt-menu");
      ghost.setAttribute("aria-hidden", "true");
      ghost.inert = true;
      ghost.classList.replace("animate-suggestions-in", "animate-suggestions-out");
      container.append(ghost);
      window.setTimeout(() => ghost.remove(), 120);
    };
  }, [container]);

  return createPortal(
    <div
      ref={surfaceRef}
      data-prompt-menu=""
      className={`animate-suggestions-in absolute inset-x-0 bottom-full z-50 mb-2 origin-bottom overflow-hidden transition-[height] duration-150 ease-out ${MENU_SURFACE} p-0!`}
      style={{ height }}
    >
      <div ref={listRef} className="app-scrollbar max-h-72 overflow-y-auto p-1">
        {children}
      </div>
    </div>,
    container,
  );
}

function TypeaheadPlugin({
  kind,
  objectIndex,
  commands = EMPTY_COMMANDS,
  objectsLoading = false,
  objectsUnavailable = null,
  noStudio = false,
  onOpen,
  onSubmit,
}: {
  kind: TokenKind;
  objectIndex: readonly SearchableObject[];
  commands?: readonly Command[];
  objectsLoading?: boolean;
  noStudio?: boolean;
  /** Why there are no objects to offer, such as no Studio being open. */
  objectsUnavailable?: string | null;
  onOpen?: () => void;
  onSubmit?: () => void;
}) {
  const [editor] = useLexicalComposerContext();
  const [query, setQuery] = useState<string | null>(null);
  const options = useMemo(() => {
    const search = query ?? "";
    if (kind === "object") {
      return searchObjects(objectIndex, search).map(
        (node) =>
          new PromptOption(
            `object:${node.path}`,
            "object",
            `@${node.name}`,
            node.path,
            node.path,
            iconForClass(node.className),
          ),
      );
    }
    return searchCommands(commands, search).map(
      (command) =>
        new PromptOption(
          `command:${command.name}`,
          "command",
          `/${command.name}`,
          command.description ?? "",
          `/${command.name}`,
          SquareSlash,
        ),
    );
  }, [commands, kind, objectIndex, query]);

  /** Says why the list is empty. A slash that isn't a command stays out of the way. */
  function emptyMessage(search: string): string | null {
    if (kind === "command") return search ? null : "No commands available.";
    if (objectIndex.length === 0) {
      if (objectsLoading) return "Reading your place in Studio";
      // With no Studio in play, "@media" is just something someone typed.
      if (noStudio && search) return null;
      return objectsUnavailable ?? "Nothing to reference in this place yet.";
    }
    return `No objects match "${search}".`;
  }

  return (
    <LexicalTypeaheadMenuPlugin<PromptOption>
      triggerFn={kind === "object" ? OBJECT_TRIGGER : COMMAND_TRIGGER}
      onQueryChange={setQuery}
      onOpen={onOpen}
      options={options}
      onSelectOption={(option, nodeToReplace, closeMenu) => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return;
        const trailingSpace = $createTextNode(" ");
        if (option.kind === "command") {
          const commandText = $createTextNode(option.value);
          if (nodeToReplace) {
            nodeToReplace.replace(commandText);
            commandText.insertAfter(trailingSpace);
          } else {
            selection.insertNodes([commandText, trailingSpace]);
          }
          trailingSpace.selectEnd();
          posthog.capture(
            "composer_command_inserted",
            analyticsProperties("chat", {
              token_kind: option.kind,
              command: option.key.replace("command:", ""),
              completion_method: "typeahead",
            }),
          );
          closeMenu();
          // Commands that act on the app take no argument, so picking one runs it.
          if (CLIENT_COMMANDS.some(({ name }) => `/${name}` === option.value)) {
            setTimeout(() => onSubmit?.(), 0);
          }
          return;
        }

        const token = $createPromptTokenNode(option.kind, option.label, option.value);
        if (nodeToReplace) {
          nodeToReplace.replace(token);
          token.insertAfter(trailingSpace);
        } else {
          selection.insertNodes([token, trailingSpace]);
        }
        trailingSpace.selectEnd();
        posthog.capture(
          "composer_object_referenced",
          analyticsProperties("chat", {
            token_kind: option.kind,
          }),
        );
        closeMenu();
      }}
      menuRenderFn={(_anchor, { selectedIndex, selectOptionAndCleanUp, setHighlightedIndex }) => {
        const root = editor.getRootElement();
        const container = root?.closest("[data-composer]") ?? root?.parentElement;
        if (!container) return null;
        const empty = options.length === 0 ? emptyMessage(query ?? "") : null;
        if (options.length === 0 && !empty) return null;
        return (
          <SuggestionMenu container={container}>
            <div className={MENU_LABEL}>{kind === "object" ? "Objects" : "Commands"}</div>
            {empty ? (
              <div className="px-2 pb-1.5 text-sm text-muted-foreground">{empty}</div>
            ) : (
              <div role="listbox" aria-label={kind === "object" ? "Objects" : "Commands"}>
                {options.map((option, index) => (
                  <button
                    key={option.key}
                    type="button"
                    role="option"
                    aria-selected={selectedIndex === index}
                    ref={option.setRefElement}
                    className={`flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-sm ${
                      selectedIndex === index ? "bg-accent" : ""
                    }`}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseMove={() => setHighlightedIndex(index)}
                    onClick={() => selectOptionAndCleanUp(option)}
                  >
                    <option.glyph
                      aria-hidden="true"
                      size={14}
                      className="shrink-0 text-muted-foreground"
                    />
                    <span className="shrink-0">{option.label}</span>
                    {option.detail ? (
                      <span className="min-w-0 truncate text-xs text-muted-foreground">
                        {option.detail}
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
            )}
          </SuggestionMenu>
        );
      }}
    />
  );
}

export interface PromptEditorHandle {
  clear(): void;
  focus(): void;
  getText(): string;
  insertText(text: string): void;
  /** Puts back what was written, chips and all, from what {@link PromptEditorProps.onChange} gave. */
  restore(state: SerializedEditorState): void;
  /** Adds the same chip as picking the object from the @ list, after what's already written. */
  insertObject(reference: ExplorerReference): void;
}

interface PromptEditorProps {
  commands: readonly Command[];
  objects: readonly ExplorerNode[];
  placeholder: string;
  objectsLoading?: boolean;
  objectsUnavailable?: string | null;
  noStudio?: boolean;
  /** Typing "@" asks for a fresh copy of the place's objects. */
  onObjectsWanted?: () => void;
  onChange(text: string, state: SerializedEditorState): void;
  onSubmit(): void;
  onPaste?: ClipboardEventHandler<HTMLDivElement>;
}

export default forwardRef<PromptEditorHandle, PromptEditorProps>(function PromptEditor(
  {
    commands,
    objects,
    placeholder,
    objectsLoading,
    objectsUnavailable,
    noStudio,
    onObjectsWanted,
    onChange,
    onSubmit,
    onPaste,
  },
  ref,
) {
  const editorRef = useMemo(() => ({ current: null as LexicalEditor | null }), []);
  const objectIndex = useMemo(() => buildObjectSearchIndex(objects), [objects]);
  useImperativeHandle(ref, () => ({
    clear() {
      editorRef.current?.update(() => $getRoot().clear().append($createParagraphNode()));
      const root = editorRef.current?.getRootElement() as
        | (HTMLDivElement & { value?: string })
        | null;
      if (root) root.value = "";
    },
    focus() {
      editorRef.current?.focus();
    },
    getText() {
      return editorRef.current?.getEditorState().read(() => $getRoot().getTextContent()) ?? "";
    },
    restore(state) {
      const editor = editorRef.current;
      if (!editor) return;
      editor.setEditorState(editor.parseEditorState(state));
      editor.update(() => $getRoot().selectEnd());
    },
    insertText(text: string) {
      editorRef.current?.update(() => {
        const root = $getRoot();
        const last = root.getLastChild();
        const paragraph = last && $isElementNode(last) ? last : $createParagraphNode();
        if (!last || !$isElementNode(last)) root.append(paragraph);
        if (root.getTextContent().trim()) paragraph.append($createTextNode("\n\n"));
        paragraph.append($createTextNode(text));
        paragraph.selectEnd();
      });
    },
    insertObject({ name, path, field }) {
      editorRef.current?.update(() => {
        const root = $getRoot();
        const last = root.getLastChild();
        const paragraph = last && $isElementNode(last) ? last : $createParagraphNode();
        if (!last || !$isElementNode(last)) root.append(paragraph);
        if (/\S$/.test(root.getTextContent())) paragraph.append($createTextNode(" "));
        const trailingSpace = $createTextNode(" ");
        paragraph.append(
          $createPromptTokenNode(
            "object",
            field ? `@${name}.${field.name}` : `@${name}`,
            path,
            field,
          ),
          trailingSpace,
        );
        trailingSpace.selectEnd();
      });
    },
  }));

  return (
    <LexicalComposer
      initialConfig={{
        namespace: "BloxBotPrompt",
        nodes: [PromptTokenNode],
        onError: (error) => {
          throw error;
        },
        theme: { paragraph: "m-0" },
      }}
    >
      <div className="relative min-w-0 flex-1">
        <RichTextPlugin
          contentEditable={
            <ContentEditable
              className="app-scrollbar max-h-48 min-h-10 overflow-y-auto whitespace-pre-wrap pb-2 pt-1 text-sm leading-relaxed outline-none"
              aria-label="Message"
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.shiftKey) return;
                if (document.querySelector("[data-prompt-menu] [role=option]")) return;
                event.preventDefault();
                onSubmit();
              }}
              onPaste={onPaste}
            />
          }
          placeholder={
            <div className="pointer-events-none absolute left-0 top-1 text-sm text-muted-foreground/50">
              {placeholder}
            </div>
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
        <HistoryPlugin />
        <OnChangePlugin
          onChange={(state, editor) =>
            state.read(() => {
              const text = $getRoot().getTextContent();
              const root = editor.getRootElement() as (HTMLDivElement & { value?: string }) | null;
              if (root) root.value = text;
              onChange(text, state.toJSON());
            })
          }
        />
        <DomInputFallbackPlugin />
        <TypeaheadPlugin
          kind="object"
          objectIndex={objectIndex}
          objectsLoading={objectsLoading}
          objectsUnavailable={objectsUnavailable}
          noStudio={noStudio}
          onOpen={onObjectsWanted}
        />
        <TypeaheadPlugin
          kind="command"
          objectIndex={EMPTY_OBJECT_INDEX}
          commands={commands}
          onSubmit={onSubmit}
        />
        <SetEditorRef editorRef={editorRef} />
      </div>
    </LexicalComposer>
  );
});
