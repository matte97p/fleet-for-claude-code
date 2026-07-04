import * as fs from "node:fs";
import * as readline from "node:readline";
import type { TranscriptItem } from "../../shared/protocol";
import { findSessionFile } from "./ImportSessions";

/**
 * Rebuilds a chat transcript from a Claude Code session .jsonl on disk, so an
 * imported/resumed chat shows its full history instead of an empty panel.
 *
 * Mapping (verified against real session files):
 *  - user + text block            -> user turn (injected <ide_*> context stripped)
 *  - user + tool_result block      -> tool-result row (is_error, content summary)
 *  - assistant + text block        -> assistant turn
 *  - assistant + tool_use block    -> tool row (name, input)
 *  - assistant + thinking block    -> skipped (internal reasoning, noisy)
 */
export async function loadTranscript(
  sessionId: string,
  opts: { maxItems?: number } = {}
): Promise<TranscriptItem[]> {
  const file = findSessionFile(sessionId);
  if (!file || !fs.existsSync(file)) return [];

  const items: TranscriptItem[] = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let o: any;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o.type !== "user" && o.type !== "assistant") continue;
      const ts = o.timestamp ? Date.parse(o.timestamp) || Date.now() : Date.now();
      const content = o.message?.content;
      const blocks = Array.isArray(content)
        ? content
        : typeof content === "string"
        ? [{ type: "text", text: content }]
        : [];

      for (const b of blocks) {
        if (o.type === "user") {
          if (b.type === "text") {
            const text = stripInjected(b.text);
            if (text) items.push({ kind: "user", text, ts });
          } else if (b.type === "tool_result") {
            items.push({
              kind: "tool-result",
              name: "tool",
              ok: b.is_error !== true,
              summary: summarize(b.content),
              ts,
            });
          }
        } else {
          // assistant
          if (b.type === "text" && b.text?.trim()) {
            items.push({ kind: "assistant", text: b.text, ts });
          } else if (b.type === "tool_use") {
            items.push({ kind: "tool", name: b.name, input: b.input, ts });
          }
          // thinking blocks intentionally skipped
        }
      }
    }
  } finally {
    rl.close();
  }

  // Optionally keep only the last N items for very long sessions.
  if (opts.maxItems && items.length > opts.maxItems) {
    const dropped = items.length - opts.maxItems;
    const tail = items.slice(-opts.maxItems);
    tail.unshift({
      kind: "system",
      text: `… ${dropped} earlier message(s) hidden (showing last ${opts.maxItems}).`,
      ts: tail[0]?.ts ?? Date.now(),
    });
    return tail;
  }
  return items;
}

/** Remove IDE-injected wrapper blocks so restored user turns read cleanly. */
function stripInjected(raw: unknown): string {
  if (!raw) return "";
  let t = String(raw);
  t = t.replace(/<([a-z_]+)>[\s\S]*?<\/\1>/gi, " ");
  t = t.replace(/<[^>]+>/g, " ");
  return t.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function summarize(content: unknown): string {
  const s =
    typeof content === "string"
      ? content
      : Array.isArray(content)
      ? content
          .map((c: any) => (typeof c === "string" ? c : c?.text ?? ""))
          .join("")
      : JSON.stringify(content ?? "");
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > 120 ? oneLine.slice(0, 120) + "…" : oneLine;
}
