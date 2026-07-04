import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as readline from "node:readline";
import type { SessionManager } from "../core/SessionManager";
import type { FolderStore } from "./FolderStore";

interface DiscoveredSession {
  sessionId: string;
  file: string;
  cwd: string;
  title: string;
  mtimeMs: number;
  turns: number;
}

interface ImportDeps {
  sessions: SessionManager;
  store: FolderStore;
  tree: { refresh(): void };
  defaultModel?: string;
}

const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

/** Scan ~/.claude/projects, let the user pick sessions, add them as resumable chats. */
export async function importClaudeSessions(deps: ImportDeps): Promise<void> {
  if (!fs.existsSync(PROJECTS_DIR)) {
    void vscode.window.showWarningMessage(
      `No Claude sessions found (${PROJECTS_DIR} does not exist).`
    );
    return;
  }

  const discovered = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Scanning Claude sessions…" },
    () => scanSessions()
  );

  if (discovered.length === 0) {
    void vscode.window.showInformationMessage("No importable Claude sessions found.");
    return;
  }

  // Skip sessions already imported (same sessionId).
  const known = new Set(
    deps.store.chats().map((c) => c.sessionId).filter(Boolean) as string[]
  );

  const items: (vscode.QuickPickItem & { session: DiscoveredSession })[] = discovered
    .filter((s) => !known.has(s.sessionId))
    .map((s) => ({
      label: s.title,
      description: `${s.turns} turn${s.turns === 1 ? "" : "s"} · ${relTime(s.mtimeMs)}`,
      detail: s.cwd,
      session: s,
    }));

  if (items.length === 0) {
    void vscode.window.showInformationMessage(
      "All Claude sessions are already imported."
    );
    return;
  }

  const picks = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: "Import Claude Code sessions",
    placeHolder: "Select sessions to add as resumable chats",
    matchOnDetail: true,
  });
  if (!picks || picks.length === 0) return;

  // Put imports under an "Imported" folder (created once).
  let folder = deps.store.folders().find((f) => f.title === "Imported" && f.parentId === null);
  if (!folder) folder = await deps.store.addFolder("Imported", null);

  for (const pick of picks) {
    const s = pick.session;
    const chat = await deps.sessions.create({
      title: s.title,
      cwd: s.cwd,
      model: deps.defaultModel,
      resumeSessionId: s.sessionId,
    });
    await deps.store.addChat({
      id: chat.id,
      title: s.title,
      parentId: folder.id,
      cwd: s.cwd,
      model: deps.defaultModel,
      sessionId: s.sessionId,
    });
  }
  deps.tree.refresh();
  void vscode.window.showInformationMessage(
    `Imported ${picks.length} session${picks.length === 1 ? "" : "s"} into “Imported”.`
  );
}

/** Locate the on-disk .jsonl for a given SDK session id (searches all projects). */
export function findSessionFile(sessionId: string): string | undefined {
  if (!sessionId || !fs.existsSync(PROJECTS_DIR)) return undefined;
  let dirs: string[];
  try {
    dirs = fs
      .readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(PROJECTS_DIR, d.name));
  } catch {
    return undefined;
  }
  for (const dir of dirs) {
    const candidate = path.join(dir, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

async function scanSessions(): Promise<DiscoveredSession[]> {
  const out: DiscoveredSession[] = [];
  let projectDirs: string[] = [];
  try {
    projectDirs = fs
      .readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(PROJECTS_DIR, d.name));
  } catch {
    return out;
  }

  for (const dir of projectDirs) {
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      const full = path.join(dir, f);
      try {
        const meta = await readSessionMeta(full);
        if (meta) out.push(meta);
      } catch {
        /* skip unreadable / malformed session files */
      }
    }
  }
  // Most recent first.
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/** Read just enough of a .jsonl to derive a title, cwd, and turn count. */
async function readSessionMeta(file: string): Promise<DiscoveredSession | null> {
  const sessionId = path.basename(file, ".jsonl");
  const stat = fs.statSync(file);
  let cwd = "";
  let title = "";
  let turns = 0;

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
      if (!cwd && typeof o.cwd === "string") cwd = o.cwd;
      if (o.type === "user") {
        turns++;
        if (!title) {
          const c = o.message?.content;
          const text =
            typeof c === "string"
              ? c
              : Array.isArray(c)
              ? c.find((b: any) => b?.type === "text")?.text
              : undefined;
          const clean = cleanTitle(text);
          if (clean) title = clean;
        }
      }
    }
  } finally {
    rl.close();
  }

  // A session with no user turns and no cwd is likely a stub (e.g. workflows); skip.
  if (!cwd && turns === 0) return null;

  return {
    sessionId,
    file,
    cwd: cwd || decodeProjectDir(path.basename(path.dirname(file))),
    title: title || `Session ${sessionId.slice(0, 8)}`,
    mtimeMs: stat.mtimeMs,
    turns,
  };
}

/**
 * Turn the first user message into a usable title. Claude Code injects context
 * blocks (opened files, command output, system reminders) that shouldn't become
 * the title, so strip those and fall back to the next line of real prose.
 */
function cleanTitle(raw: unknown): string {
  if (!raw) return "";
  let text = String(raw);
  // Drop injected wrapper blocks like <ide_opened_file>…</…>, <system-reminder>…, etc.
  text = text.replace(/<([a-z_]+)>[\s\S]*?<\/\1>/gi, " ");
  // Drop any remaining lone tags / reminders.
  text = text.replace(/<[^>]+>/g, " ");
  // Collapse whitespace; take the first non-empty line of actual text.
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("#"));
  return (line ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
}

/** ~/.claude/projects encodes the cwd as a dashed path; recover a best-effort path. */
function decodeProjectDir(name: string): string {
  // "-Users-matte-Documents-www" -> "/Users/matte/Documents/www"
  return name.replace(/^-/, "/").replace(/-/g, "/");
}

function relTime(ms: number): string {
  const diff = nowMs() - ms;
  const min = Math.round(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

// Isolated so the rest stays pure; Date is fine in the extension host.
function nowMs(): number {
  return Date.now();
}
