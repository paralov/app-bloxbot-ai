import { createHighlighterCore } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import githubDark from "@shikijs/themes/github-dark";
import githubLight from "@shikijs/themes/github-light";
import { type CSSProperties, useEffect, useState } from "react";

interface HighlightedToken {
  content: string;
  light?: string;
  dark?: string;
}

function preserveIndentation(value: string) {
  return value.replace(/^( +)/, (indentation) => "\u00a0".repeat(indentation.length));
}

function hiddenLinesMarker(sourceLines: string[]) {
  const hiddenCount = sourceLines.length - 6;
  const tailLine = sourceLines[sourceLines.length - 3] ?? "";
  const indentation = tailLine.match(/^\s*/)?.[0].length ?? 0;
  return `${" ".repeat(indentation)}[… ${hiddenCount} hidden ${hiddenCount === 1 ? "line" : "lines"}]`;
}

function collapsedTextPreview(code: string) {
  const lines = code.split("\n");
  if (lines.length <= 7) return code;
  return [...lines.slice(0, 3), hiddenLinesMarker(lines), ...lines.slice(-3)].join("\n");
}

const highlighterPromise = createHighlighterCore({
  themes: [githubLight, githubDark],
  langs: [],
  engine: createJavaScriptRegexEngine(),
});

export type HighlightLanguage =
  | "json"
  | "bash"
  | "diff"
  | "javascript"
  | "lua"
  | "shellsession"
  | "tsx"
  | "typescript";

const languageLoads = new Map<HighlightLanguage, Promise<void>>();

function ensureLanguage(language: HighlightLanguage) {
  const existing = languageLoads.get(language);
  if (existing) return existing;
  const loading = highlighterPromise.then(async (highlighter) => {
    switch (language) {
      case "bash":
        await highlighter.loadLanguage((await import("@shikijs/langs/bash")).default);
        break;
      case "diff":
        await highlighter.loadLanguage((await import("@shikijs/langs/diff")).default);
        break;
      case "javascript":
        await highlighter.loadLanguage((await import("@shikijs/langs/javascript")).default);
        break;
      case "json":
        await highlighter.loadLanguage((await import("@shikijs/langs/json")).default);
        break;
      case "lua":
        await highlighter.loadLanguage((await import("@shikijs/langs/lua")).default);
        break;
      case "shellsession":
        await highlighter.loadLanguage((await import("@shikijs/langs/shellsession")).default);
        break;
      case "tsx":
        await highlighter.loadLanguage((await import("@shikijs/langs/tsx")).default);
        break;
      case "typescript":
        await highlighter.loadLanguage((await import("@shikijs/langs/typescript")).default);
        break;
    }
  });
  languageLoads.set(language, loading);
  return loading;
}

export default function SyntaxHighlightedOutput({
  code,
  collapsed = false,
  language = "json",
}: {
  code: string;
  collapsed?: boolean;
  language?: HighlightLanguage;
}) {
  const [lines, setLines] = useState<HighlightedToken[][] | null>(null);

  useEffect(() => {
    let active = true;
    void Promise.all([highlighterPromise, ensureLanguage(language)]).then(([highlighter]) => {
      const tokenLines = highlighter.codeToTokensWithThemes(code, {
        lang: language,
        themes: { light: "github-light", dark: "github-dark" },
      });
      if (!active) return;
      setLines(
        tokenLines.map((line) =>
          line.map((token) => ({
            content: token.content,
            light: token.variants.light?.color,
            dark: token.variants.dark?.color,
          })),
        ),
      );
    });
    return () => {
      active = false;
    };
  }, [code, language]);

  if (!lines) {
    return (
      <span className="block overflow-hidden whitespace-pre font-sans text-[13px] leading-relaxed">
        {(collapsed ? collapsedTextPreview(code) : code).split("\n").map((line, index) => (
          <span key={index} className="block overflow-hidden text-ellipsis whitespace-nowrap">
            {preserveIndentation(line) || "\u00a0"}
          </span>
        ))}
      </span>
    );
  }

  const sourceLines = code.split("\n");
  const marker = collapsed && lines.length > 7 ? hiddenLinesMarker(sourceLines) : "";
  const visibleLines: Array<HighlightedToken[] | string> =
    collapsed && lines.length > 7 ? [...lines.slice(0, 3), marker, ...lines.slice(-3)] : lines;

  return (
    <code className="block min-w-0 overflow-hidden font-sans text-[13px] leading-relaxed">
      {visibleLines.map((line, lineIndex) => (
        <span
          key={lineIndex}
          className="block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
        >
          {typeof line === "string" ? (
            <span className="text-muted-foreground/60">{preserveIndentation(line)}</span>
          ) : (
            line.map((token, tokenIndex) => (
              <span
                key={tokenIndex}
                className="syntax-token"
                style={
                  {
                    "--syntax-light": token.light,
                    "--syntax-dark": token.dark,
                  } as CSSProperties
                }
              >
                {tokenIndex === 0 ? preserveIndentation(token.content) : token.content}
              </span>
            ))
          )}
        </span>
      ))}
    </code>
  );
}
