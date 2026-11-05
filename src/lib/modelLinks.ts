const MODEL_LINK = /file:\/\/[^\s)\]>"'`]+\.(?:fbx|glb)\b/gi;
/** A fenced block, to its closing fence or the end of the reply, or a run of inline code. */
const CODE =
  /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[`~]*[ \t]*$|(?![\s\S]))|(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\2(?!`)/gm;

/** The model files a reply links to, each once and in order. A path shown as code isn't a link. */
export function modelLinksIn(text: string): string[] {
  return [...new Set(text.replace(CODE, " ").match(MODEL_LINK) ?? [])];
}
