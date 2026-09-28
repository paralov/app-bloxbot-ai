function normalizeMcpResult(result: unknown): any {
  const content = result && typeof result === "object" && !Array.isArray(result)
    ? (result as any).content
    : result;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      if ((part as any).type === "json") return (part as any).json;
      if ((part as any).type === "text" && typeof (part as any).text === "string") {
        return parseMcpText((part as any).text);
      }
    }
  }
  if (typeof content === "string") return parseMcpText(content);
  return content;
}

// Studio MCP can put a note such as "Note: Output limited to N nodes" before
// the JSON, so fall back to parsing from the first bracket.
function parseMcpText(text: string): any {
  try { return JSON.parse(text); } catch {}
  const starts = [text.indexOf("["), text.indexOf("{")].filter((index) => index > 0);
  const start = starts.length > 0 ? Math.min(...starts) : -1;
  if (start > 0) {
    try { return JSON.parse(text.slice(start)); } catch {}
  }
  return text;
}

function mcpErrorText(result: unknown): string | null {
  if (!result || typeof result !== "object" || (result as any).isError !== true) return null;
  const content = (result as any).content;
  const text = Array.isArray(content)
    ? content.map((part: any) => (typeof part?.text === "string" ? part.text : "")).join(" ").trim()
    : "";
  return text || "Studio returned an error";
}

function normalizeMcpIdentifier(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  return typeof value === "number" && Number.isFinite(value) ? String(value) : null;
}
