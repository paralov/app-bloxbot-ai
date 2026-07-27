import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import {
  LexicalTypeaheadMenuPlugin,
  MenuOption,
  useBasicTypeaheadTriggerMatch,
} from "@lexical/react/LexicalTypeaheadMenuPlugin";
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
  type SerializedLexicalNode,
} from "lexical";
import posthog from "posthog-js/dist/module.full.no-external.js";
import {
  type ClipboardEventHandler,
  forwardRef,
  type ReactNode,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { analyticsProperties } from "@/lib/analytics";
import type { ExplorerNode } from "@/lib/explorer";

type TokenKind = "object" | "command";

interface SerializedPromptTokenNode extends SerializedLexicalNode {
  kind: TokenKind;
  label: string;
  value: string;
  type: "prompt-token";
  version: 1;
}

class PromptTokenNode extends DecoratorNode<ReactNode> {
  __kind: TokenKind;
  __label: string;
  __value: string;

  static getType() {
    return "prompt-token";
  }

  static clone(node: PromptTokenNode) {
    return new PromptTokenNode(node.__kind, node.__label, node.__value, node.__key);
  }

  static importJSON(serializedNode: SerializedLexicalNode & Record<string, unknown>) {
    const serialized = serializedNode as unknown as SerializedPromptTokenNode;
    return new PromptTokenNode(serialized.kind, serialized.label, serialized.value);
  }

  constructor(kind: TokenKind, label: string, value: string, key?: NodeKey) {
    super(key);
    this.__kind = kind;
    this.__label = label;
    this.__value = value;
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
      type: "prompt-token",
      version: 1,
    };
  }

  getTextContent() {
    return this.__value;
  }

  isInline() {
    return true;
  }

  decorate() {
    return (
      <span
        className={`mx-0.5 inline-flex select-all items-center rounded-md border px-1.5 py-0.5 align-baseline text-[11px] font-medium ${
          this.__kind === "object"
            ? "border-blue-500/25 bg-blue-500/10 text-blue-700 dark:text-blue-300"
            : "border-violet-500/25 bg-violet-500/10 text-violet-700 dark:text-violet-300"
        }`}
        title={this.__value}
      >
        {this.__label}
      </span>
    );
  }
}

function $createPromptTokenNode(kind: TokenKind, label: string, value: string) {
  return new PromptTokenNode(kind, label, value);
}

class PromptOption extends MenuOption {
  kind: TokenKind;
  label: string;
  detail: string;
  value: string;

  constructor(key: string, kind: TokenKind, label: string, detail: string, value: string) {
    super(key);
    this.kind = kind;
    this.label = label;
    this.detail = detail;
    this.value = value;
  }
}

const COMMANDS = [
  { name: "build", detail: "Implement the requested change", prompt: "Build this: " },
  { name: "fix", detail: "Diagnose and fix a problem", prompt: "Fix this: " },
  { name: "review", detail: "Review the current implementation", prompt: "Review this: " },
  { name: "explain", detail: "Explain code or behavior", prompt: "Explain this: " },
] as const;

const EMPTY_OBJECT_INDEX: readonly SearchableObject[] = [];

interface SearchableObject {
  node: ExplorerNode;
  searchText: string;
}

function buildObjectSearchIndex(nodes: readonly ExplorerNode[]): SearchableObject[] {
  const index: SearchableObject[] = [];
  const pending = [...nodes].reverse();
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) continue;
    index.push({
      node,
      searchText: `${node.name} ${node.className} ${node.path}`.toLowerCase(),
    });
    for (let childIndex = node.children.length - 1; childIndex >= 0; childIndex -= 1) {
      pending.push(node.children[childIndex]);
    }
  }
  return index;
}

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

function TypeaheadMenuPortal({ anchor, children }: { anchor: HTMLElement; children: ReactNode }) {
  const [position, setPosition] = useState({ left: 8, top: 8, maxHeight: 256 });

  useLayoutEffect(() => {
    const updatePosition = () => {
      const rect = anchor.getBoundingClientRect();
      const menuWidth = 288;
      setPosition({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - menuWidth - 8)),
        top: rect.top - 8,
        maxHeight: Math.max(96, Math.min(256, rect.top - 24)),
      });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    window.visualViewport?.addEventListener("resize", updatePosition);
    window.visualViewport?.addEventListener("scroll", updatePosition);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      window.visualViewport?.removeEventListener("resize", updatePosition);
      window.visualViewport?.removeEventListener("scroll", updatePosition);
    };
  }, [anchor]);

  return createPortal(
    <div
      className="app-scrollbar fixed z-[100] w-72 overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-xl"
      style={{
        left: position.left,
        top: position.top,
        maxHeight: position.maxHeight,
        transform: "translateY(-100%)",
      }}
      role="listbox"
    >
      {children}
    </div>,
    document.body,
  );
}

function TypeaheadPlugin({
  kind,
  objectIndex,
}: {
  kind: TokenKind;
  objectIndex: readonly SearchableObject[];
}) {
  const [query, setQuery] = useState<string | null>(null);
  const triggerFn = useBasicTypeaheadTriggerMatch(kind === "object" ? "@" : "/", {
    minLength: 0,
  });
  const options = useMemo(() => {
    const search = (query ?? "").toLowerCase();
    if (kind === "object") {
      const objectOptions: PromptOption[] = [];
      for (const entry of objectIndex) {
        if (!entry.searchText.includes(search)) continue;
        const { node } = entry;
        objectOptions.push(
          new PromptOption(
            `object:${node.path}`,
            "object",
            `@${node.name}`,
            `${node.className} · ${node.path}`,
            `the ${node.className} named "${node.name}" at ${node.path}`,
          ),
        );
        if (objectOptions.length === 10) break;
      }
      return objectOptions;
    }

    return COMMANDS.filter((command) => command.name.includes(search)).map(
      (command) =>
        new PromptOption(
          `command:${command.name}`,
          "command",
          `/${command.name}`,
          command.detail,
          command.prompt,
        ),
    );
  }, [kind, objectIndex, query]);

  return (
    <LexicalTypeaheadMenuPlugin<PromptOption>
      triggerFn={triggerFn}
      onQueryChange={setQuery}
      options={options}
      onSelectOption={(option, nodeToReplace, closeMenu) => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return;
        const token = $createPromptTokenNode(option.kind, option.label, option.value);
        const trailingSpace = $createTextNode(" ");
        if (nodeToReplace) {
          nodeToReplace.replace(token);
          token.insertAfter(trailingSpace);
        } else {
          selection.insertNodes([token, trailingSpace]);
        }
        trailingSpace.selectEnd();
        posthog.capture(
          option.kind === "object" ? "composer_object_referenced" : "composer_command_inserted",
          analyticsProperties("chat", {
            token_kind: option.kind,
            command: option.kind === "command" ? option.key.replace("command:", "") : undefined,
          }),
        );
        closeMenu();
      }}
      menuRenderFn={(anchorRef, { selectedIndex, selectOptionAndCleanUp, setHighlightedIndex }) =>
        anchorRef.current && options.length > 0 ? (
          <TypeaheadMenuPortal anchor={anchorRef.current}>
            {options.map((option, index) => (
              <button
                key={option.key}
                type="button"
                ref={option.setRefElement}
                className={`flex w-full flex-col rounded-md px-2.5 py-2 text-left ${
                  selectedIndex === index ? "bg-accent" : "hover:bg-accent/70"
                }`}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setHighlightedIndex(index)}
                onClick={() => selectOptionAndCleanUp(option)}
              >
                <span className="text-xs font-medium">{option.label}</span>
                <span className="truncate text-[10px] text-muted-foreground">{option.detail}</span>
              </button>
            ))}
          </TypeaheadMenuPortal>
        ) : null
      }
    />
  );
}

export interface PromptEditorHandle {
  clear(): void;
  focus(): void;
  getText(): string;
  insertText(text: string): void;
}

interface PromptEditorProps {
  objects: readonly ExplorerNode[];
  placeholder: string;
  onChange(text: string): void;
  onSubmit(): void;
  onPaste?: ClipboardEventHandler<HTMLDivElement>;
}

export default forwardRef<PromptEditorHandle, PromptEditorProps>(function PromptEditor(
  { objects, placeholder, onChange, onSubmit, onPaste },
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
              className="app-scrollbar max-h-40 min-h-[20px] overflow-y-auto whitespace-pre-wrap text-[13px] leading-relaxed outline-none"
              aria-label="Message"
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.shiftKey) return;
                if (document.querySelector('[role="listbox"] button')) return;
                event.preventDefault();
                onSubmit();
              }}
              onPaste={onPaste}
            />
          }
          placeholder={
            <div className="pointer-events-none absolute left-0 top-0 text-[13px] text-muted-foreground/50">
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
              onChange(text);
            })
          }
        />
        <DomInputFallbackPlugin />
        <TypeaheadPlugin kind="object" objectIndex={objectIndex} />
        <TypeaheadPlugin kind="command" objectIndex={EMPTY_OBJECT_INDEX} />
        <SetEditorRef editorRef={editorRef} />
      </div>
    </LexicalComposer>
  );
});
