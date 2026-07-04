import * as vscode from "vscode";
import type { FolderStore } from "./FolderStore";
import type { SessionManager } from "../core/SessionManager";
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
    view.webview.onDidReceiveMessage((m: SidebarToHost) => this.onMessage(m));
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

  private onMessage(m: SidebarToHost): void {
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
