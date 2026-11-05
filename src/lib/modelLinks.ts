import { fromMarkdown } from "mdast-util-from-markdown";

// A path can hold balanced brackets, like Crate (1), but a link's closing bracket isn't part of it.
const MODEL_LINK = /file:\/\/(?:[^\s()\]>"'`]|\([^\s()\]>"'`]*\))+\.(?:fbx|glb)\b/gi;

interface MarkdownNode {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
}

/**
 * The model files a reply links to, each once and in order. The reply is read the way the chat
 * shows it, so a path in any kind of code (fenced, indented or inline) or in raw HTML isn't a link.
 */
export function modelLinksIn(text: string): string[] {
  const found: string[] = [];
  const visit = (node: MarkdownNode) => {
    if (node.type === "code" || node.type === "inlineCode" || node.type === "html") return;
    if (node.type === "text" && node.value) found.push(...(node.value.match(MODEL_LINK) ?? []));
    // A link's label comes before its target in the reply.
    node.children?.forEach(visit);
    if (node.type === "link" && node.url) found.push(...(node.url.match(MODEL_LINK) ?? []));
  };
  visit(fromMarkdown(text) as MarkdownNode);
  return [...new Set(found)];
}
