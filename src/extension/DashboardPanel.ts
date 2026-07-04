import * as vscode from "vscode";
import type { SessionManager } from "../core/SessionManager";
import type { FolderStore } from "./FolderStore";
import type {
  DashboardToHost,
  HostToDashboard,
  DashboardData,
  DashboardCard,
} from "../../shared/protocol";

/** A standalone panel showing every chat as a card in a responsive grid. */
export class DashboardPanel {
  private static current?: DashboardPanel;
  private panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private showArchived = false;
  private pushTimer?: ReturnType<typeof setTimeout>;

  static show(
    ctx: vscode.ExtensionContext,
    sessions: SessionManager,
    store: FolderStore
  ): void {
    if (!DashboardPanel.current) {
      DashboardPanel.current = new DashboardPanel(ctx, sessions, store);
    }
    DashboardPanel.current.panel.reveal(vscode.ViewColumn.Active);
    DashboardPanel.current.push();
  }

  private constructor(
    private ctx: vscode.ExtensionContext,
    private sessions: SessionManager,
    private store: FolderStore
  ) {
    this.panel = vscode.window.createWebviewPanel(
      "claudeFleet.dashboard",
      "Claude Fleet — Dashboard",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(ctx.extensionUri, "dist", "webview"),
        ],
      }
    );
    this.panel.webview.html = this.html();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (m: DashboardToHost) => this.onMessage(m),
      null,
      this.disposables
    );

    // Auto-refresh: any session change or store change re-pushes the grid.
    const onChange = () => this.schedulePush();
    this.sessions.on("chat-update", onChange);
    this.sessions.on("chat-removed", onChange);
    const storeSub = this.store.onChange(onChange);
    this.disposables.push(
      { dispose: () => this.sessions.off("chat-update", onChange) },
      { dispose: () => this.sessions.off("chat-removed", onChange) },
      storeSub
    );
  }

  /** Coalesce bursts of "chat-update" (streaming fires many per second). */
  private schedulePush(): void {
    if (this.pushTimer) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = undefined;
      this.push();
    }, 120);
  }

  private folderPath(parentId: string | null): string | undefined {
    if (parentId === null) return undefined;
    const parts: string[] = [];
    let cur: string | null = parentId;
    const folders = this.store.folders();
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const f = folders.find((x) => x.id === cur);
      if (!f) break;
      parts.unshift(f.title);
      cur = f.parentId;
    }
    return parts.length ? parts.join(" / ") : undefined;
  }

  private push(): void {
    const cards: DashboardCard[] = this.store
      .chats()
      .filter((c) => this.showArchived || !c.archived)
      .map((c) => {
        const snap = this.sessions.get(c.id)?.snapshot();
        const status = snap?.status ?? "idle";
        const lastTs = snap?.transcript?.length
          ? snap.transcript[snap.transcript.length - 1].ts
          : undefined;
        return {
          id: c.id,
          title: c.title,
          folderPath: this.folderPath(c.parentId),
          status,
          activity: snap?.activity,
          model: snap?.model ?? c.model,
          cwd: c.cwd,
          archived: c.archived ?? false,
          usage:
            snap?.usage ?? {
              inputTokens: 0,
              outputTokens: 0,
              costUsd: 0,
              turns: 0,
            },
          needsPermission: status === "waiting-permission",
          lastActivityTs: lastTs,
        };
      });
    // Attention (needs-permission) first, then running, then the rest.
    const rank = (s: string) =>
      s === "waiting-permission" ? 0 : s === "running" ? 1 : 2;
    cards.sort((a, b) => rank(a.status) - rank(b.status));

    const data: DashboardData = {
      cards,
      showArchived: this.showArchived,
      activeChatId: undefined,
    };
    const msg: HostToDashboard = { type: "dashboard", data };
    void this.panel.webview.postMessage(msg);
  }

  private onMessage(m: DashboardToHost): void {
    switch (m.type) {
      case "ready":
        this.push();
        break;
      case "open":
        void vscode.commands.executeCommand("claudeFleet.openChat", m.chatId);
        break;
      case "newChat":
        void vscode.commands.executeCommand("claudeFleet.newChat");
        break;
      case "toggleArchived":
        this.showArchived = !this.showArchived;
        this.push();
        break;
      case "stop":
        void this.sessions.get(m.id)?.interrupt();
        this.push();
        break;
    }
  }

  private html(): string {
    const webview = this.panel.webview;
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
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>Claude Fleet — Dashboard</title>
</head>
<body>
  <div id="root" data-view="dashboard"></div>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    DashboardPanel.current = undefined;
    if (this.pushTimer) clearTimeout(this.pushTimer);
    while (this.disposables.length) this.disposables.pop()?.dispose();
    this.panel.dispose();
  }
}
