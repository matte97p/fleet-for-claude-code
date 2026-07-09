import * as vscode from "vscode";
import * as fs from "node:fs";
import type { FolderStore, FolderMeta } from "./FolderStore";
import type { SessionManager } from "../core/SessionManager";
import { findSessionFile } from "./ImportSessions";
import type {
  SidebarToHost,
  HostToSidebar,
  SidebarTree,
} from "../../shared/protocol";

/**
 * Renders the chat list as a webview in the activity-bar container (instead of
 * a native TreeView) so we control font size, row height, icons and hover
 * actions — fixing the "too small / hard to read / confusing icons" problems.
 */
export class SidebarProvider implements vscode.WebviewViewProvider {
  static readonly viewId = "claudeFleet.tree";
  private view?: vscode.WebviewView;
  private showArchived = false;
  private activeChatId?: string;

  constructor(
    private ctx: vscode.ExtensionContext,
    private store: FolderStore,
    private sessions: SessionManager
  ) {
    store.onChange(() => this.pushTree());
    sessions.on("chat-update", () => {
      this.pushTree();
      this.updateBadge();
    });
    sessions.on("chat-removed", () => {
      this.pushTree();
      this.updateBadge();
    });
    sessions.on("needs-permission", () => this.updateBadge());
    sessions.on("turn-done", () => this.updateBadge());
    sessions.on("attention-changed", () => this.updateBadge());
  }

  /** Reflect the number of chats demanding attention on the activity-bar icon. */
  private updateBadge(): void {
    if (!this.view) return;
    const count = this.sessions.attentionCount();
    if (count <= 0) {
      this.view.badge = undefined;
      return;
    }
    this.view.badge = {
      value: count,
      tooltip:
        count === 1 ? "1 chat needs attention" : `${count} chats need attention`,
    };
  }

  setActive(chatId: string): void {
    this.activeChatId = chatId;
    this.pushTree();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.ctx.extensionUri, "dist", "webview"),
      ],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m: SidebarToHost) => void this.onMessage(m));
    view.onDidChangeVisibility(() => {
      if (view.visible) this.pushTree();
    });
    this.pushTree();
    this.updateBadge();
  }

  private pushTree(): void {
    if (!this.view) return;
    const tree: SidebarTree = {
      folders: this.store
        .folders()
        .map((f) => ({ id: f.id, title: f.title, parentId: f.parentId })),
      chats: this.store
        .chats()
        .filter((c) => this.showArchived || !c.archived)
        .map((c) => {
          const snap = this.sessions.get(c.id)?.snapshot();
          const lastTs = snap?.transcript?.length
            ? snap.transcript[snap.transcript.length - 1].ts
            : undefined;
          return {
            id: c.id,
            title: c.title,
            parentId: c.parentId,
            status: snap?.status ?? "idle",
            activity: snap?.activity,
            phase:
              snap?.status === "running"
                ? snap.streamingThinking && !snap.streamingText
                  ? "thinking"
                  : "writing"
                : undefined,
            archived: c.archived ?? false,
            model: snap?.model ?? c.model,
            cwd: c.cwd,
            inputTokens: snap?.usage.inputTokens,
            outputTokens: snap?.usage.outputTokens,
            turns: snap?.usage.turns,
            costUsd: snap?.usage.costUsd,
            lastActivityTs: lastTs,
            needsPermission: snap?.status === "waiting-permission",
          };
        }),
      showArchived: this.showArchived,
      activeChatId: this.activeChatId,
    };
    const msg: HostToSidebar = { type: "tree", tree };
    void this.view.webview.postMessage(msg);
  }

  /** Title of a chat or folder by id (for confirmation dialogs). */
  private titleOf(id: string): string {
    return (
      this.store.getChat(id)?.title ??
      this.store.folders().find((f) => f.id === id)?.title ??
      "?"
    );
  }

  private isFolder(id: string): boolean {
    return this.store.folders().some((f) => f.id === id);
  }

  /** Expand a mixed list of chat/folder ids to every chat id they cover
   *  (folders recurse into their descendants). Used to find on-disk files. */
  private affectedChats(ids: string[]): string[] {
    const out = new Set<string>();
    const addFolder = (folderId: string) => {
      for (const c of this.store.chats())
        if (c.parentId === folderId) out.add(c.id);
      for (const f of this.store.folders())
        if (f.parentId === folderId) addFolder(f.id);
    };
    for (const id of ids) {
      if (this.store.getChat(id)) out.add(id);
      else if (this.isFolder(id)) addFolder(id);
    }
    return [...out];
  }

  /** Breadcrumb path of a folder, e.g. "Work / Backend". */
  private folderPath(f: FolderMeta): string {
    const parts = [f.title];
    let p = f.parentId;
    while (p) {
      const pf = this.store.folders().find((x) => x.id === p);
      if (!pf) break;
      parts.unshift(pf.title);
      p = pf.parentId;
    }
    return parts.join(" / ");
  }

  private async onMessage(m: SidebarToHost): Promise<void> {
    const cmd = vscode.commands.executeCommand.bind(vscode.commands);
    switch (m.type) {
      case "ready":
        this.pushTree();
        break;
      case "open":
        void cmd("claudeFleet.openChat", m.chatId);
        break;
      case "newChat":
        void cmd("claudeFleet.newChat");
        break;
      case "newFolder":
        void cmd("claudeFleet.newFolder");
        break;
      case "import":
        void cmd("claudeFleet.importSessions");
        break;
      case "toggleArchived":
        this.showArchived = !this.showArchived;
        this.pushTree();
        break;
      case "rename":
        void cmd("claudeFleet.renameItem", { kind: "chat", id: m.id });
        break;
      case "archive":
        void cmd("claudeFleet.archiveChat", { kind: "chat", id: m.id });
        break;
      case "unarchive":
        void cmd("claudeFleet.unarchiveChat", { kind: "chat", id: m.id });
        break;
      case "delete":
        void cmd("claudeFleet.deleteItem", { kind: "chat", id: m.id });
        break;
      case "deleteDisk":
        void cmd("claudeFleet.deleteFromDisk", { kind: "chat", id: m.id });
        break;
      case "stop":
        void this.sessions.get(m.id)?.interrupt();
        break;
      case "move":
        void this.store
          .updateChat(m.id, { parentId: m.folderId })
          .then(() => this.pushTree());
        break;

      case "bulkDelete": {
        if (!m.ids.length) break;
        const label =
          m.ids.length === 1
            ? `"${this.titleOf(m.ids[0])}"`
            : `${m.ids.length} elementi`;
        // Two outcomes: "from list" leaves the .jsonl on disk (re-importable);
        // "from disk" also deletes the transcript files (permanent).
        const LIST = "Rimuovi dalla lista";
        const DISK = "Elimina anche da disco";
        const choice = await vscode.window.showWarningMessage(
          `Come vuoi eliminare ${label}?\n\n• "${LIST}": toglie le chat da Claude Fleet ma lascia i transcript su disco (potrai re-importarle).\n• "${DISK}": cancella anche i file .jsonl in ~/.claude/projects — definitivo.`,
          { modal: true },
          LIST,
          DISK
        );
        if (choice !== LIST && choice !== DISK) break;

        if (choice === DISK) {
          const files = this.affectedChats(m.ids)
            .map((cid) => this.store.getChat(cid)?.sessionId)
            .filter((sid): sid is string => !!sid)
            .map((sid) => findSessionFile(sid))
            .filter((f): f is string => !!f);
          const second = await vscode.window.showWarningMessage(
            `Cancellare definitivamente ${files.length} file di sessione da disco? L'operazione non è reversibile.`,
            { modal: true },
            "Sì, elimina da disco"
          );
          if (second !== "Sì, elimina da disco") break;
          for (const f of files) {
            try {
              fs.rmSync(f, { force: true });
            } catch (err) {
              void vscode.window.showErrorMessage(
                `Impossibile eliminare ${f}: ${err instanceof Error ? err.message : String(err)}`
              );
            }
          }
        }

        for (const id of m.ids) {
          // remove() on a folder cascades; a stale child id is then a no-op.
          const removed = await this.store.remove(id);
          for (const cid of removed) this.sessions.delete(cid);
        }
        if (choice === DISK) {
          void vscode.window.showInformationMessage(
            "Chat eliminate da Claude Fleet e da disco."
          );
        }
        break;
      }

      case "bulkArchive":
        for (const id of m.ids) {
          if (!this.store.getChat(id)) continue; // folders can't be archived
          await this.sessions.get(id)?.interrupt();
          this.sessions.clearUnseen(id);
          await this.store.setArchived(id, true);
        }
        break;

      case "bulkUnarchive":
        for (const id of m.ids) {
          if (!this.store.getChat(id)) continue;
          await this.store.setArchived(id, false);
        }
        break;

      case "bulkMove": {
        if (!m.ids.length) break;
        const selectedFolders = new Set(m.ids.filter((id) => this.isFolder(id)));
        const wouldLoop = (folderId: string): boolean => {
          let cur: string | null = folderId;
          while (cur) {
            if (selectedFolders.has(cur)) return true;
            cur = this.store.folders().find((f) => f.id === cur)?.parentId ?? null;
          }
          return false;
        };
        const targets: (vscode.QuickPickItem & { folderId: string | null })[] = [
          { label: "$(home) Root (nessuna cartella)", folderId: null },
          ...this.store
            .folders()
            .filter((f) => !wouldLoop(f.id))
            .map((f) => ({
              label: `$(folder) ${this.folderPath(f)}`,
              folderId: f.id as string | null,
            })),
        ];
        const picked = await vscode.window.showQuickPick(targets, {
          title: `Sposta ${m.ids.length} element${m.ids.length === 1 ? "o" : "i"} in…`,
          placeHolder: "Scegli la cartella di destinazione",
        });
        if (!picked) break;
        for (const id of m.ids) {
          if (this.store.getChat(id)) {
            await this.store.updateChat(id, { parentId: picked.folderId });
          } else if (this.isFolder(id)) {
            await this.store.moveFolder(id, picked.folderId);
          }
        }
        break;
      }

      case "bulkRename": {
        if (!m.ids.length) break;
        const mode = await vscode.window.showQuickPick(
          [
            { label: "$(add) Aggiungi prefisso", id: "prefix" },
            { label: "$(replace-all) Trova e sostituisci", id: "replace" },
          ],
          {
            title: `Rinomina ${m.ids.length} element${m.ids.length === 1 ? "o" : "i"}`,
          }
        );
        if (!mode) break;
        const apply = async (fn: (old: string) => string) => {
          for (const id of m.ids) {
            const cur =
              this.store.getChat(id)?.title ??
              this.store.folders().find((f) => f.id === id)?.title;
            if (cur == null) continue;
            const next = fn(cur);
            if (next && next !== cur) await this.store.rename(id, next);
          }
        };
        if (mode.id === "prefix") {
          const prefix = await vscode.window.showInputBox({
            title: "Prefisso da aggiungere",
            placeHolder: "es. WIP – ",
          });
          if (!prefix) break;
          await apply((old) => prefix + old);
        } else {
          const find = await vscode.window.showInputBox({
            title: "Testo da trovare",
          });
          if (!find) break;
          const replace = await vscode.window.showInputBox({
            title: "Sostituisci con (lascia vuoto per eliminare il testo)",
          });
          if (replace === undefined) break; // cancelled (empty string is valid)
          await apply((old) => old.split(find).join(replace));
        }
        break;
      }
    }
  }

  private html(webview: vscode.Webview): string {
    const base = vscode.Uri.joinPath(this.ctx.extensionUri, "dist", "webview");
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(base, "webview.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(base, "webview.css")
    );
    const nonce = String(Date.now()) + Math.random().toString(36).slice(2);
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <link rel="stylesheet" href="${styleUri}" />
</head>
<body>
  <div id="root" data-view="sidebar"></div>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
