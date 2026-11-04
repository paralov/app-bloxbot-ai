/**
 * What a link is allowed to open. A file link only reveals a file on this computer: opening one
 * could run it, and one naming a host would send credentials to that host on Windows.
 */
export function isOpenableUrl(url: URL): boolean {
  if (url.protocol === "file:") return url.hostname === "";
  return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:";
}
