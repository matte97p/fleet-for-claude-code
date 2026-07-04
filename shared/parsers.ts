// Pure, side-effect-free parsing/formatting helpers shared by the extension host
// and the webview. Kept separate so they can be unit-tested in isolation.
import type { TodoEntry, FileEditOp, TranscriptItem, LocalSlashCommand } from "./protocol";

export function parseTodos(input: any): TodoEntry[] {
  const raw = Array.isArray(input?.todos) ? input.todos : [];
  return raw.map((t: any) => ({
    content: String(t?.content ?? ""),
    status:
      t?.status === "in_progress" || t?.status === "completed"
        ? t.status
        : "pending",
    ...(t?.activeForm ? { activeForm: String(t.activeForm) } : {}),
  }));
}

export const splitLines = (s: unknown): string[] =>
  String(s ?? "").replace(/\r\n/g, "\n").split("\n");

export function parseEdit(name: string, input: any): FileEditOp | undefined {
  if (!input || typeof input !== "object") return undefined;
  const filePath = String(input.file_path ?? "");
  if (!filePath) return undefined;
  if (name === "Write") {
    return {
      filePath,
      mode: "write",
      hunks: [{ oldLines: [], newLines: splitLines(input.content) }],
    };
  }
  if (name === "Edit") {
    return {
      filePath,
      mode: "edit",
      hunks: [
        {
          oldLines: splitLines(input.old_string),
          newLines: splitLines(input.new_string),
        },
      ],
    };
  }
  if (name === "MultiEdit" && Array.isArray(input.edits)) {
    return {
      filePath,
      mode: "edit",
      hunks: input.edits.map((e: any) => ({
        oldLines: splitLines(e?.old_string),
        newLines: splitLines(e?.new_string),
      })),
    };
  }
  return undefined;
}

export function nameForToolUse(
  transcript: TranscriptItem[],
  toolUseId?: string
): string {
  if (!toolUseId) return "tool";
  for (let i = transcript.length - 1; i >= 0; i--) {
    const t = transcript[i];
    if (t.kind === "tool" && t.toolUseId === toolUseId) return t.name;
  }
  return "tool";
}

export function summarizeResult(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (typeof c === "string" ? c : c?.text ?? ""))
      .join("")
      .trim();
  }
  try {
    return JSON.stringify(content ?? "").trim();
  } catch {
    return "";
  }
}

/** Parse a bare local slash command (/clear, /compact, /model) from composer text. */
export function parseLocalSlash(
  raw: string
): { cmd: LocalSlashCommand | "model"; arg: string } | null {
  const m = /^\/(clear|compact|model)(?:\s+([\s\S]*))?$/i.exec(raw);
  if (!m) return null;
  return {
    cmd: m[1].toLowerCase() as LocalSlashCommand | "model",
    arg: (m[2] ?? "").trim(),
  };
}

/** Best-effort context-window size for a model id ([1m]/context-1m ⇒ 1M). */
export function contextWindowForModel(model?: string): number {
  if (model && /\[1m\]|context-1m/i.test(model)) return 1_000_000;
  return 200_000;
}
