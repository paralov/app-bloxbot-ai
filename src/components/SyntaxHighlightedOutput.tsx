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

function collapsedTextPreview(code: string) {
  const lines = code.split("\n");
  if (lines.length <= 7) return code;
  return [...lines.slice(0, 3), "", ...lines.slice(-3)].join("\n");
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
      <span className="whitespace-pre-wrap">{collapsed ? collapsedTextPreview(code) : code}</span>
    );
  }

  const visibleLines: Array<HighlightedToken[] | null> =
    collapsed && lines.length > 7 ? [...lines.slice(0, 3), null, ...lines.slice(-3)] : lines;

  return (
    <code className="whitespace-pre-wrap font-sans text-[13px] leading-relaxed">
      {visibleLines.map((line, lineIndex) => (
        <span key={lineIndex} className="block">
          {line === null
            ? "\u00a0"
            : line.map((token, tokenIndex) => (
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
                  {token.content}
                </span>
              ))}
        </span>
      ))}
    </code>
  );
}
