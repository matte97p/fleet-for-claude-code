import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

// Register languages (registerLanguage also registers each language's own aliases).
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("css", css);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("dockerfile", dockerfile);
hljs.registerLanguage("go", go);
hljs.registerLanguage("ini", ini);
hljs.registerLanguage("java", java);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("python", python);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);

// Extra aliases commonly used in chat fences.
hljs.registerAliases(["ts", "tsx"], { languageName: "typescript" });
hljs.registerAliases(["js", "jsx", "mjs", "cjs"], { languageName: "javascript" });
hljs.registerAliases(["sh", "shell", "zsh"], { languageName: "bash" });
hljs.registerAliases(["yml"], { languageName: "yaml" });
hljs.registerAliases(["py"], { languageName: "python" });
hljs.registerAliases(["html", "xhtml", "svg"], { languageName: "xml" });
hljs.registerAliases(["docker"], { languageName: "dockerfile" });
hljs.registerAliases(["toml"], { languageName: "ini" });
hljs.registerAliases(["md"], { languageName: "markdown" });

export interface Highlighted {
  /** HTML-escaped, safe to inject via dangerouslySetInnerHTML on a <code>. */
  html: string;
  /** Resolved language name, or "" when unknown (escaped-only fallback). */
  language: string;
}

/**
 * Highlight `code` for the given fence language. Output is ALWAYS escaped:
 * either highlight.js output (which HTML-escapes the source and only adds its
 * own <span class="hljs-*">) or, for unknown/absent languages, plain
 * escapeHtml(code). No auto-detect — too costly and flickers during streaming.
 */
export function highlight(code: string, lang?: string): Highlighted {
  const l = (lang || "").toLowerCase().trim();
  if (l && hljs.getLanguage(l)) {
    try {
      const r = hljs.highlight(code, { language: l, ignoreIllegals: true });
      return { html: r.value, language: r.language || l };
    } catch {
      /* fall through to escaped plain text */
    }
  }
  return { html: escapeHtml(code), language: "" };
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"
  );
}
