import React from "react";
import { vscode } from "./vscodeApi";
import { highlight } from "./highlight";

/**
 * Minimal markdown -> React renderer for the chat transcript.
 *
 * All output is real React elements. The SINGLE exception is the highlighted
 * code body (HighlightedCode), which uses dangerouslySetInnerHTML — this is
 * XSS-safe because the HTML comes ONLY from highlight() (see highlight.ts):
 * the source is HTML-escaped and only highlight.js's own <span class="hljs-*">
 * wrappers are inserted. No user/model text ever reaches the DOM unescaped.
 * Do NOT feed any other string into that <code>.
 *
 * Supports: fenced code (highlighted), GFM pipe tables, blockquotes (nested),
 * ordered/unordered lists (nested), horizontal rules, headings (h1-h4), links,
 * inline `code` / **bold** / *italic*. Not a full CommonMark parser.
 * KNOWN LIMITS: loose lists separated by many blank lines may split; no setext
 * headings; no reference links; no images.
 */
export function Markdown({ text }: { text: string }) {
  return <Blocks blocks={parseBlocks(text)} />;
}

function Blocks({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} />
      ))}
    </>
  );
}

function BlockView({ block: b }: { block: Block }) {
  switch (b.type) {
    case "code":
      return <HighlightedCode code={b.content} lang={b.lang} />;
    case "heading": {
      const H = `h${b.level}` as keyof JSX.IntrinsicElements;
      return <H className="md-h">{inline(b.content)}</H>;
    }
    case "hr":
      return <hr className="md-hr" />;
    case "quote":
      return (
        <blockquote className="md-quote">
          <Blocks blocks={b.blocks} />
        </blockquote>
      );
    case "list":
      return b.ordered ? (
        <ol className="md-list">
          {b.items.map((it, j) => (
            <ListItemView key={j} item={it} />
          ))}
        </ol>
      ) : (
        <ul className="md-list">
          {b.items.map((it, j) => (
            <ListItemView key={j} item={it} />
          ))}
        </ul>
      );
    case "table":
      return (
        <div className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {b.header.map((c, j) => (
                  <th key={j} style={alignStyle(b.align[j])}>
                    {inline(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((c, j) => (
                    <td key={j} style={alignStyle(b.align[j])}>
                      {inline(c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    default:
      return <p className="md-p">{inline(b.content)}</p>;
  }
}

function ListItemView({ item }: { item: ListItem }) {
  return (
    <li>
      {inline(item.content)}
      {item.children.length > 0 && <Blocks blocks={item.children} />}
    </li>
  );
}

/**
 * Highlighted fenced-code body. `html` is produced solely by highlight() and is
 * always HTML-escaped (see highlight.ts) — the dangerouslySetInnerHTML below is
 * the one sanctioned use in this file. memo + useMemo keep streaming cheap.
 */
const HighlightedCode = React.memo(function HighlightedCode({
  code,
  lang,
}: {
  code: string;
  lang: string;
}) {
  const { html, language } = React.useMemo(() => highlight(code, lang), [code, lang]);
  return (
    <pre className="md-code">
      <code
        className={language ? `hljs language-${language}` : "hljs"}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </pre>
  );
});

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

type Align = "left" | "center" | "right" | null;

type Block =
  | { type: "code"; lang: string; content: string }
  | { type: "heading"; level: number; content: string }
  | { type: "hr" }
  | { type: "quote"; blocks: Block[] }
  | { type: "list"; ordered: boolean; items: ListItem[] }
  | { type: "table"; header: string[]; align: Align[]; rows: string[][] }
  | { type: "p"; content: string };

type ListItem = { content: string; children: Block[] };

const RE_FENCE = /^\s*```+\s*([^\s`]*)/;
const RE_FENCE_CLOSE = /^\s*```+\s*$/;
const RE_HEADING = /^(#{1,4})\s+(.*)$/;
const RE_HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const RE_LIST = /^(\s*)([-*+]|\d+[.)])(\s+)(.*)$/;

function alignStyle(a: Align): React.CSSProperties | undefined {
  return a ? { textAlign: a } : undefined;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function nextNonBlank(lines: string[], from: number): number {
  for (let k = from; k < lines.length; k++) if (lines[k].trim() !== "") return k;
  return -1;
}

function parseBlocks(text: string): Block[] {
  return parseLines(text.replace(/\r\n/g, "\n").split("\n"));
}

function parseLines(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i++;
      continue;
    }

    // Fenced code block.
    const fence = RE_FENCE.exec(line);
    if (fence && line.trimStart().startsWith("```")) {
      const lang = fence[1] || "";
      const buf: string[] = [];
      i++;
      while (i < lines.length && !RE_FENCE_CLOSE.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // consume closing fence if present
      blocks.push({ type: "code", lang, content: buf.join("\n") });
      continue;
    }

    // Blockquote.
    if (/^\s*>/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      blocks.push({ type: "quote", blocks: parseLines(buf) });
      continue;
    }

    // Table: header row followed by a delimiter row.
    if (line.includes("|") && i + 1 < lines.length && isTableDelimiter(lines[i + 1])) {
      const header = splitRow(line);
      const align = splitRow(lines[i + 1]).map(cellAlign);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim() !== "" && lines[i].includes("|")) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      blocks.push({ type: "table", header, align, rows });
      continue;
    }

    // Horizontal rule.
    if (RE_HR.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    // Heading.
    const h = RE_HEADING.exec(line);
    if (h) {
      blocks.push({ type: "heading", level: h[1].length, content: h[2] });
      i++;
      continue;
    }

    // List (nested).
    if (RE_LIST.test(line)) {
      const parsed = parseList(lines, i);
      blocks.push(parsed.block);
      i = parsed.next;
      continue;
    }

    // Paragraph: consecutive "plain" lines.
    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !(RE_FENCE.test(lines[i]) && lines[i].trimStart().startsWith("```")) &&
      !/^\s*>/.test(lines[i]) &&
      !RE_HR.test(lines[i]) &&
      !RE_HEADING.test(lines[i]) &&
      !RE_LIST.test(lines[i]) &&
      !(lines[i].includes("|") && i + 1 < lines.length && isTableDelimiter(lines[i + 1]))
    ) {
      buf.push(lines[i]);
      i++;
    }
    blocks.push({ type: "p", content: buf.join("\n") });
  }
  return blocks;
}

function parseList(lines: string[], start: number): { block: Block; next: number } {
  const first = RE_LIST.exec(lines[start])!;
  const indent = indentOf(lines[start]);
  const ordered = /\d/.test(first[2]);
  const items: ListItem[] = [];
  let i = start;

  while (i < lines.length) {
    // Allow a single blank line between sibling items (loose list).
    if (lines[i].trim() === "") {
      const n = nextNonBlank(lines, i);
      if (n >= 0 && RE_LIST.test(lines[n]) && indentOf(lines[n]) === indent) {
        i = n;
      } else {
        break;
      }
    }
    const m = RE_LIST.exec(lines[i]);
    if (!m || indentOf(lines[i]) !== indent) break;

    const contentCol = indent + m[2].length + m[3].length;
    const content = m[4];
    i++;

    const childBuf: string[] = [];
    while (i < lines.length) {
      const l = lines[i];
      if (l.trim() === "") {
        const n = nextNonBlank(lines, i);
        if (n >= 0 && indentOf(lines[n]) > indent) {
          childBuf.push("");
          i++;
          continue;
        }
        break;
      }
      if (indentOf(l) > indent) {
        childBuf.push(l.slice(Math.min(contentCol, indentOf(l))));
        i++;
        continue;
      }
      break;
    }

    items.push({ content, children: childBuf.length ? parseLines(childBuf) : [] });
  }

  return { block: { type: "list", ordered, items }, next: i };
}

function isTableDelimiter(line: string | undefined): boolean {
  if (line == null || line.indexOf("|") < 0) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c.trim()));
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function cellAlign(cell: string): Align {
  const c = cell.trim();
  const l = c.startsWith(":");
  const r = c.endsWith(":");
  if (l && r) return "center";
  if (r) return "right";
  if (l) return "left";
  return null;
}

// ---------------------------------------------------------------------------
// Inline formatting: `code`, **bold**, *italic*, [text](url). No HTML injection.
// ---------------------------------------------------------------------------

const INLINE_RE =
  /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*|_[^_]+_|\[[^\]]+\]\([^)\s]+\))/g;

function inline(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("`")) {
      nodes.push(
        <code className="md-inline-code" key={key++}>
          {tok.slice(1, -1)}
        </code>
      );
    } else if (tok.startsWith("**")) {
      nodes.push(<strong key={key++}>{inline(tok.slice(2, -2))}</strong>);
    } else if (tok.startsWith("[")) {
      const lm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok)!;
      nodes.push(<LinkView key={key++} href={lm[2]} label={lm[1]} />);
    } else {
      nodes.push(<em key={key++}>{inline(tok.slice(1, -1))}</em>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function LinkView({ href, label }: { href: string; label: string }) {
  const external = /^(https?:|mailto:)/i.test(href);
  if (external) {
    return (
      <a
        className="md-link"
        title={href}
        role="link"
        tabIndex={0}
        onClick={() => openExternal(href)}
        onKeyDown={(e) => {
          if (e.key === "Enter") openExternal(href);
        }}
      >
        {inline(label)}
      </a>
    );
  }
  // Relative paths / anchors / unknown schemes: non-navigable text, target in title.
  return (
    <span className="md-link-plain" title={href}>
      {inline(label)}
    </span>
  );
}

function openExternal(url: string) {
  vscode.postMessage({ type: "openExternal", url });
}