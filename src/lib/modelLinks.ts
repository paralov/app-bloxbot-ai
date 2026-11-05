// A path can hold balanced brackets, like Crate (1), but a link's closing bracket isn't part of it.
const MODEL_LINK = /file:\/\/(?:[^\s()\]>"'`]|\([^\s()\]>"'`]*\))+\.(?:fbx|glb)\b/gi;
/** A fenced block, to its closing fence or the end of the reply, or a run of inline code. */
const CODE =
  /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[`~]*[ \t]*$|(?![\s\S]))|(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\2(?!`)/gm;
const INDENTED = /^(?: {4}| {0,3}\t)/;
const LIST_ITEM = /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/;

/** Blanks indented code blocks. Indented text in a list item or a paragraph is still text. */
function withoutIndentedCode(text: string): string {
  let inList = false;
  let inCode = false;
  let afterBlank = true;
  return text
    .split("\n")
    .map((line) => {
      const blank = !line.trim();
      const indented = !blank && INDENTED.test(line);
      if (LIST_ITEM.test(line)) inList = true;
      else if (!blank && !indented && afterBlank) inList = false;
      // A block starts after a blank line. An indented line straight after text belongs to that text.
      inCode = indented && (inCode || (afterBlank && !inList));
      afterBlank = blank;
      return inCode ? "" : line;
    })
    .join("\n");
}

/** The model files a reply links to, each once and in order. A path shown as code isn't a link. */
export function modelLinksIn(text: string): string[] {
  return [...new Set(withoutIndentedCode(text.replace(CODE, " ")).match(MODEL_LINK) ?? [])];
}
