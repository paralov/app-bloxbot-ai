/** "/Users/a" or "/C:/Users/a". Anything else can reach a network share on Windows, however it's spelled. */
const LOCAL_PATH = /^\/(?!\/)(?!.*%(?:5c|2f))/i;

/**
 * What a link is allowed to open. A file link only reveals a file on this computer: opening one
 * could run it, and one naming a host would send credentials to that host on Windows.
 */
export function isOpenableUrl(url: URL): boolean {
  if (url.protocol === "file:") return url.hostname === "" && LOCAL_PATH.test(url.pathname);
  return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:";
}
