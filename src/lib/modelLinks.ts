import { fromMarkdown } from "mdast-util-from-markdown";

// A path can hold balanced brackets, like Crate (1), but a link's closing bracket isn't part of it.
const MODEL_LINK = /file:\/\/(?:[^\s()\]>"'`]|\([^\s()\]>"'`]*\))+\.(?:fbx|glb)\b/gi;

interface MarkdownNode {
  type: string;
  value?: string;
  url?: string;
  identifier?: string;
  children?: MarkdownNode[];
}

/**
 * The model files a reply links to, each once and in order. The reply is read the way the chat
 * shows it, so a path in any kind of code (fenced, indented or inline) or in raw HTML isn't a link.
 */
export function modelLinksIn(text: string): string[] {
  const tree = fromMarkdown(text) as MarkdownNode;
  // A reference link, like [model][asset], keeps its target in a definition elsewhere in the reply.
  const definitions = new Map<string, string>();
  const define = (node: MarkdownNode) => {
    // As in Markdown, the first definition of a name is the one that counts.
    if (
      node.type === "definition" &&
      node.identifier &&
      node.url &&
      !definitions.has(node.identifier)
    ) {
      definitions.set(node.identifier, node.url);
    }
    node.children?.forEach(define);
  };
  define(tree);
  const found: string[] = [];
  const visit = (node: MarkdownNode) => {
    if (node.type === "code" || node.type === "inlineCode" || node.type === "html") return;
    if (node.type === "text" && node.value) found.push(...(node.value.match(MODEL_LINK) ?? []));
    // A link's label comes before its target in the reply.
    node.children?.forEach(visit);
    const target =
      node.type === "link" || node.type === "image"
        ? node.url
        : (node.type === "linkReference" || node.type === "imageReference") && node.identifier
          ? definitions.get(node.identifier)
          : undefined;
    if (target) found.push(...(target.match(MODEL_LINK) ?? []));
  };
  visit(tree);
  return [...new Set(found)];
}
