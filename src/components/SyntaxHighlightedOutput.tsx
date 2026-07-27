import { createHighlighterCore } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import json from "@shikijs/langs/json";
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
  const boundaryLines = [sourceLines[2], sourceLines[sourceLines.length - 3]];
  const indentation = Math.min(...boundaryLines.map((line) => line.match(/^\s*/)?.[0].length ?? 0));
  return `${" ".repeat(indentation)}[… ${hiddenCount} hidden ${hiddenCount === 1 ? "line" : "lines"}]`;
}

function collapsedTextPreview(code: string) {
  const lines = code.split("\n");
  if (lines.length <= 7) return code;
  return [...lines.slice(0, 3), hiddenLinesMarker(lines), ...lines.slice(-3)].join("\n");
}

const highlighterPromise = createHighlighterCore({
  themes: [githubLight, githubDark],
  langs: [json],
  engine: createJavaScriptRegexEngine(),
});

export default function SyntaxHighlightedOutput({
  code,
  collapsed = false,
}: {
  code: string;
  collapsed?: boolean;
}) {
  const [lines, setLines] = useState<HighlightedToken[][] | null>(null);

  useEffect(() => {
    let active = true;
    void highlighterPromise.then((highlighter) => {
      const tokenLines = highlighter.codeToTokensWithThemes(code, {
        lang: "json",
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
  }, [code]);

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
  const marker = hiddenLinesMarker(sourceLines);
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
