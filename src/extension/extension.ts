import * as vscode from "vscode";
import { SessionManager } from "../core/SessionManager";
import { FolderStore } from "./FolderStore";
import { SidebarProvider } from "./SidebarProvider";
import { ChatPanel } from "./ChatPanel";
import { registerNotifications } from "./Notifications";
import { importClaudeSessions, findSessionFile } from "./ImportSessions";
import { DashboardPanel } from "./DashboardPanel";
import type { ChatSnapshot } from "../../shared/protocol";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Commands may be invoked from the sidebar webview ({kind,id}) or elsewhere. */
type NodeArg = { kind?: string; id: string } | string | undefined;
function nodeId(arg: NodeArg): string | undefined {
  if (!arg) return undefined;
  return typeof arg === "string" ? arg : arg.id;
}

// --- Working-directory picker (per-chat cwd, chosen at creation only) --------

const RECENT_CWDS_KEY = "claudeFleet.recentCwds.v1";
const MAX_RECENT_CWDS = 8;

function getRecentCwds(ctx: vscode.ExtensionContext): string[] {
  return ctx.globalState.get<string[]>(RECENT_CWDS_KEY, []);
}

async function pushRecentCwd(
  ctx: vscode.ExtensionContext,
  dir: string
): Promise<void> {
  const prev = getRecentCwds(ctx).filter((d) => d !== dir);
  const next = [dir, ...prev].slice(0, MAX_RECENT_CWDS);
  await ctx.globalState.update(RECENT_CWDS_KEY, next);
}

/** Ask which working directory a new chat should run in (fixed for its life). */
async function pickCwd(
  ctx: vscode.ExtensionContext,
  fallbackCwd: string
): Promise<string | undefined> {
  const BROWSE = "$__browse__";
  const seen = new Set<string>();
  const items: (vscode.QuickPickItem & { path?: string })[] = [];
  const add = (p: string | undefined, label: string, description: string) => {
    if (!p || seen.has(p)) return;
    seen.add(p);
    items.push({ label, description, detail: p, path: p });
  };
  for (const wf of vscode.workspace.workspaceFolders ?? []) {
    add(wf.uri.fsPath, `$(folder) ${wf.name}`, "workspace folder");
  }
  add(fallbackCwd, "$(home) Default", "claudeFleet.defaultCwd / workspace / home");
  add(os.homedir(), "$(home) Home", os.homedir());
  for (const r of getRecentCwds(ctx)) add(r, `$(history) ${r}`, "recent");
  items.push({
    label: "$(folder-opened) Browse…",
    description: "pick a folder…",
    path: BROWSE,
  });

  const picked = await vscode.window.showQuickPick(items, {
    title: "Working directory for this chat",
    placeHolder: "Where should Claude run? (cwd is fixed once the chat starts)",
    matchOnDetail: true,
  });
  if (!picked) return undefined;

  let chosen: string | undefined;
  if (picked.path === BROWSE) {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "Use as working directory",
      defaultUri: vscode.Uri.file(fallbackCwd),
      title: "Select working directory for this chat",
    });
    chosen = uris?.[0]?.fsPath;
    if (!chosen) return undefined;
  } else {
    chosen = picked.path;
  }
  try {
    if (!fs.statSync(chosen!).isDirectory()) throw new Error("not a directory");
  } catch {
    void vscode.window.showErrorMessage(`Not a valid directory: ${chosen}`);
    return undefined;
  }
  await pushRecentCwd(ctx, chosen!);
  return chosen;
}

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("claudeFleet");
  const configuredClaudePath = cfg.get<string>("pathToClaudeExecutable", "");

  const sessions = new SessionManager(configuredClaudePath);
  const store = new FolderStore(ctx);
  const sidebar = new SidebarProvider(ctx, store, sessions);
  const tree = { refresh: () => {} }; // sidebar auto-refreshes via events

  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewId, sidebar, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    { dispose: () => sessions.disposeAll() }
  );

  registerNotifications(ctx, sessions);

  // Attention badge: a turn that finishes while its panel isn't focused is "unseen".
  const onTurnDoneBadge = (snap: ChatSnapshot) => {
    const focused = ChatPanel.isFocused() && ChatPanel.boundId() === snap.id;
    if (!focused) sessions.markUnseen(snap.id);
  };
  sessions.on("turn-done", onTurnDoneBadge);
  ctx.subscriptions.push({
    dispose: () => sessions.off("turn-done", onTurnDoneBadge),
  });
  // Clear a chat's unseen flag the moment its panel becomes focused.
  ChatPanel.setFocusListener((chatId) => sessions.clearUnseen(chatId));

  // Rehydrate persisted chats as (idle, resumable) sessions on startup.
  for (const meta of store.chats()) {
    await sessions.create({
      id: meta.id,
      title: meta.title,
      cwd: meta.cwd,
      model: meta.model,
      config: meta.config,
      resumeSessionId: meta.sessionId,
    });
  }

  const defaultCwd = (): string => {
    const configured = cfg.get<string>("defaultCwd", "");
    if (configured) return configured;
    return (
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
      process.env.HOME ??
      process.cwd()
    );
  };

  ctx.subscriptions.push(
    vscode.commands.registerCommand("claudeFleet.newChat", async () => {
      // Warn once if preflight had to strip an API key or couldn't find claude.
      const auth = await sessions.preflight();
      if (auth.strippedApiKey) {
        void vscode.window.showInformationMessage(
          "Claude Fleet: using your Claude subscription login (ignored ANTHROPIC_API_KEY)."
        );
      }
      const title = await vscode.window.showInputBox({
        prompt: "Chat title",
        value: "New chat",
      });
      if (title === undefined) return;
      // Let the user choose the working directory (fixed for the chat's lifetime).
      const cwd = await pickCwd(ctx, defaultCwd());
      if (cwd === undefined) return; // user cancelled the cwd picker
      // Read the per-extension defaults from Settings (moved out of the panel).
      const s = vscode.workspace.getConfiguration("claudeFleet");
      const model = s.get<string>("model", "") || undefined;
      const effort = (s.get<string>("defaultEffort", "") || undefined) as any;
      const permissionMode = (s.get<string>("defaultPermissionMode", "default") ||
        undefined) as any;
      const config = { model, effort, permissionMode };
      const chat = await sessions.create({ title, cwd, model, config });
      await store.addChat({
        id: chat.id,
        title,
        parentId: null,
        cwd,
        model,
        config,
      });
      sidebar.setActive(chat.id);
      ChatPanel.show(ctx, sessions, store, chat.id);
    }),

    vscode.commands.registerCommand("claudeFleet.newFolder", async () => {
      const title = await vscode.window.showInputBox({
        prompt: "Folder name",
      });
      if (!title) return;
      await store.addFolder(title, null);
    }),

    vscode.commands.registerCommand(
      "claudeFleet.openChat",
      (chatId: string) => {
        sessions.clearUnseen(chatId); // opening a chat means you've seen it
        sidebar.setActive(chatId);
        ChatPanel.show(ctx, sessions, store, chatId);
      }
    ),

    vscode.commands.registerCommand("claudeFleet.openDashboard", () => {
      DashboardPanel.show(ctx, sessions, store);
    }),

    vscode.commands.registerCommand(
      "claudeFleet.togglePlanMode",
      async (arg: NodeArg) => {
        const id = nodeId(arg) ?? ChatPanel.boundId();
        if (!id) return;
        const session = sessions.get(id);
        if (!session) return;
        const cur = session.snapshot().config.permissionMode;
        const next = cur === "plan" ? "default" : "plan";
        await session.setPermissionMode(next);
        await store.updateChat(id, {
          config: { ...session.snapshot().config, permissionMode: next },
        });
      }
    ),

    vscode.commands.registerCommand("claudeFleet.openSettings", () => {
      // Use the actual extension id so this doesn't break if the publisher changes.
      void vscode.commands.executeCommand(
        "workbench.action.openSettings",
        `@ext:${ctx.extension.id}`
      );
    }),

    vscode.commands.registerCommand("claudeFleet.manageMcp", async () => {
      // Target dir: the active chat's cwd, else workspace/default.
      const activeId = ChatPanel.boundId();
      const activeCwd = activeId ? store.getChat(activeId)?.cwd : undefined;
      const cwd = activeCwd ?? defaultCwd();
      const mcpPath = path.join(cwd, ".mcp.json");

      const action = await vscode.window.showQuickPick(
        [
          { label: "$(add) Aggiungi server MCP", id: "add" },
          { label: "$(edit) Apri .mcp.json", id: "open" },
        ],
        { title: `Server MCP per ${cwd}`, placeHolder: ".mcp.json di questo progetto" }
      );
      if (!action) return;

      if (action.id === "open") {
        if (!fs.existsSync(mcpPath))
          fs.writeFileSync(mcpPath, JSON.stringify({ mcpServers: {} }, null, 2));
        const doc = await vscode.workspace.openTextDocument(mcpPath);
        await vscode.window.showTextDocument(doc);
        return;
      }

      // Guided add.
      const name = await vscode.window.showInputBox({
        title: "Nome del server MCP",
        placeHolder: "es. github, playwright, filesystem",
        validateInput: (v) => (/^[a-zA-Z0-9_-]+$/.test(v) ? null : "Solo lettere, numeri, - e _"),
      });
      if (!name) return;
      const kind = await vscode.window.showQuickPick(
        [
          { label: "Comando locale (stdio)", id: "stdio", detail: "es. npx -y @modelcontextprotocol/server-…" },
          { label: "Server remoto (HTTP/SSE)", id: "http", detail: "es. https://mcp.esempio.com" },
        ],
        { title: `Tipo di server "${name}"` }
      );
      if (!kind) return;

      let entry: Record<string, unknown>;
      if (kind.id === "stdio") {
        const cmd = await vscode.window.showInputBox({
          title: "Comando + argomenti",
          placeHolder: "npx -y @modelcontextprotocol/server-github",
        });
        if (!cmd) return;
        const parts = cmd.trim().split(/\s+/);
        entry = { command: parts[0], args: parts.slice(1) };
      } else {
        const url = await vscode.window.showInputBox({
          title: "URL del server",
          placeHolder: "https://mcp.esempio.com/sse",
          validateInput: (v) => (/^https?:\/\//.test(v) ? null : "Deve iniziare con http(s)://"),
        });
        if (!url) return;
        entry = { type: "http", url };
      }

      // Merge into .mcp.json.
      let data: any = { mcpServers: {} };
      try {
        if (fs.existsSync(mcpPath)) data = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
      } catch {
        void vscode.window.showErrorMessage(`${mcpPath} non è un JSON valido — correggilo a mano.`);
        return;
      }
      if (!data.mcpServers || typeof data.mcpServers !== "object") data.mcpServers = {};
      data.mcpServers[name] = entry;
      fs.writeFileSync(mcpPath, JSON.stringify(data, null, 2));

      const choice = await vscode.window.showInformationMessage(
        `Server MCP "${name}" aggiunto a ${mcpPath}. Riavvia la chat (o creane una nuova in questa cartella) per caricarlo.`,
        "Apri .mcp.json"
      );
      if (choice === "Apri .mcp.json") {
        const doc = await vscode.workspace.openTextDocument(mcpPath);
        await vscode.window.showTextDocument(doc);
      }
    }),

    vscode.commands.registerCommand("claudeFleet.stopChat", (arg: NodeArg) => {
      const id = nodeId(arg);
      if (id) void sessions.get(id)?.interrupt();
    }),

    vscode.commands.registerCommand(
      "claudeFleet.renameItem",
      async (arg: NodeArg) => {
        const id = nodeId(arg);
        if (!id) return;
        const current =
          store.getChat(id)?.title ??
          store.folders().find((f) => f.id === id)?.title ??
          "";
        const title = await vscode.window.showInputBox({
          prompt: "New name",
          value: current,
        });
        if (!title) return;
        await store.rename(id, title);
      }
    ),

    vscode.commands.registerCommand(
      "claudeFleet.deleteItem",
      async (arg: NodeArg) => {
        const id = nodeId(arg);
        if (!id) return;
        const name =
          store.getChat(id)?.title ??
          store.folders().find((f) => f.id === id)?.title ??
          "this item";
        const confirm = await vscode.window.showWarningMessage(
          `Remove "${name}" from Claude Fleet?\n\n(This does NOT delete the transcript on disk — use "Delete from disk" for that.)`,
          { modal: true },
          "Remove"
        );
        if (confirm !== "Remove") return;
        const removedChatIds = await store.remove(id);
        for (const cid of removedChatIds) sessions.delete(cid);
      }
    ),

    vscode.commands.registerCommand("claudeFleet.importSessions", async () => {
      await importClaudeSessions({
        sessions,
        store,
        tree,
        defaultModel: cfg.get<string>("model", "") || undefined,
      });
    }),

    vscode.commands.registerCommand(
      "claudeFleet.archiveChat",
      async (arg: NodeArg) => {
        const id = nodeId(arg);
        if (!id) return;
        // Stop any running turn before archiving so it doesn't keep working hidden.
        await sessions.get(id)?.interrupt();
        sessions.clearUnseen(id); // archived chats shouldn't hold the badge
        await store.setArchived(id, true);
      }
    ),

    vscode.commands.registerCommand(
      "claudeFleet.unarchiveChat",
      async (arg: NodeArg) => {
        const id = nodeId(arg);
        if (!id) return;
        await store.setArchived(id, false);
      }
    ),

    vscode.commands.registerCommand(
      "claudeFleet.deleteFromDisk",
      async (arg: NodeArg) => {
        const id = nodeId(arg);
        if (!id) return;
        const meta = store.getChat(id);
        const title = meta?.title ?? "this chat";
        const file = meta?.sessionId ? findSessionFile(meta.sessionId) : undefined;
        if (!file) {
          void vscode.window.showWarningMessage(
            `No on-disk session file found for “${title}”. Removing it from Claude Fleet only.`
          );
          const removed = await store.remove(id);
          for (const cid of removed) sessions.delete(cid);
          return;
        }
        // Double confirmation — this permanently deletes the transcript file.
        const first = await vscode.window.showWarningMessage(
          `Permanently DELETE the session file for “${title}” from disk?\n\n${file}\n\nThis cannot be undone.`,
          { modal: true },
          "Delete from disk"
        );
        if (first !== "Delete from disk") return;
        const second = await vscode.window.showWarningMessage(
          `Are you absolutely sure? The transcript will be gone forever.`,
          { modal: true },
          "Yes, delete permanently"
        );
        if (second !== "Yes, delete permanently") return;
        try {
          fs.rmSync(file, { force: true });
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Failed to delete file: ${err instanceof Error ? err.message : String(err)}`
          );
          return;
        }
        const removed = await store.remove(id);
        for (const cid of removed) sessions.delete(cid);
        void vscode.window.showInformationMessage(
          `Deleted session “${title}” from disk.`
        );
      }
    )
  );
}

export function deactivate(): void {
  /* SessionManager.disposeAll runs via ctx.subscriptions */
}
