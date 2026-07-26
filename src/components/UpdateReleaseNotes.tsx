export interface ReleaseNoteSection {
  title: string;
  items: string[];
}

export function parseReleaseNotes(html: string | null): ReleaseNoteSection[] {
  if (!html) return [];
  const document = new DOMParser().parseFromString(html, "text/html");
  return Array.from(document.querySelectorAll("h3"))
    .map((heading) => {
      const items: string[] = [];
      let sibling = heading.nextElementSibling;
      while (sibling && !/^H[1-6]$/.test(sibling.tagName)) {
        for (const item of sibling.querySelectorAll("li")) {
          const text = item.textContent?.replace(/\s+/g, " ").trim();
          if (text) items.push(text);
        }
        sibling = sibling.nextElementSibling;
      }
      return { title: heading.textContent?.trim() ?? "", items };
    })
    .filter((section) => section.title && section.items.length > 0);
}

export function UpdateReleaseNotes({ body }: { body: string | null }) {
  const sections = parseReleaseNotes(body);
  if (sections.length === 0) return <span>A new version is ready to install.</span>;

  return (
    <div className="update-release-notes">
      {sections.map((section) => (
        <div key={section.title}>
          <div className="update-release-notes-title">{section.title}</div>
          <ul>
            {section.items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
