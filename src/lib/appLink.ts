/** Marks a link to our own sites, so they can tell a visit came from the app and from where. */
export function appLink(url: string, placement: "about" | "loading" | "privacy"): string {
  const link = new URL(url);
  link.searchParams.set("utm_source", "bloxbot");
  link.searchParams.set("utm_medium", "desktop_app");
  link.searchParams.set("utm_campaign", "app_links");
  link.searchParams.set("utm_content", placement);
  return link.href;
}
