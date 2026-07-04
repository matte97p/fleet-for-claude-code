import * as vscode from "vscode";
import * as path from "node:path";
import type { SessionManager } from "../core/SessionManager";
import type { ChatSession } from "../core/ChatSession";
import type { FolderStore } from "./FolderStore";
import { loadTranscript } from "./TranscriptLoader";
import type {
  HostToWebview,
  WebviewToHost,
  SoundPlay,
  QuickAction,
} from "../../shared/protocol";
import { DEFAULT_QUICK_ACTIONS } from "../../shared/protocol";

/**
 * One reusable webview panel that shows the currently-selected chat. Selecting
 * a different chat in the tree swaps which session this panel is bound to.
 */
export class ChatPanel {
  private static current?: ChatPanel;
  /** Host hook fired whenever a chat becomes the focused panel (open or refocus). */
  private static onFocusChat?: (chatId: string) => void;
  static setFocusListener(fn: (chatId: string) => void): void {
    ChatPanel.onFocusChat = fn;
  }
  private panel: vscode.WebviewPanel;
  private boundChatId?: string;
  private updateSub?: () => void;
  private disposables: vscode.Disposable[] = [];

  static show(
    ctx: vscode.ExtensionContext,
    sessions: SessionManager,
    store: FolderStore,
    chatId: string
  ): void {
    if (!ChatPanel.current) {
      ChatPanel.current = new ChatPanel(ctx, sessions, store);
    }
    ChatPanel.current.bind(chatId);
    ChatPanel.current.panel.reveal(vscode.ViewColumn.Active);
  }

  /** Whether the panel is currently the focused, visible editor. */
  static isFocused(): boolean {
    return ChatPanel.current?.panel.active ?? false;
  }

  /** The chat id currently shown by the panel, if any. */
  static boundId(): string | undefined {
    return ChatPanel.current?.boundChatId;
  }

  /** Play a notification sound via the (retained) webview, if one exists. */
  static playSound(play: SoundPlay): void {
    ChatPanel.current?.post({ type: "sound", play });
  }

  private constructor(
    private ctx: vscode.ExtensionContext,
    private sessions: SessionManager,
    private store: FolderStore
  ) {
    this.panel = vscode.window.createWebviewPanel(
      "claudeFleet.chat",
      "Claude Fleet",
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
      (m: WebviewToHost) => this.onMessage(m),
      null,
      this.disposables
    );
    this.panel.onDidChangeViewState(
      () => this.notifyFocusIfActive(),
      null,
      this.disposables
    );
    // Re-push quick actions when the user edits claudeFleet.quickActions.
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("claudeFleet.quickActions")) {
          this.postQuickActions();
        }
      })
    );

    // React to live session updates for whichever chat is bound.
    const listener = (snap: any) => {
      if (snap.id === this.boundChatId) {
        this.post({ type: "patch", chat: snap });
        // Keep persisted sessionId fresh so we can resume after a restart.
        if (snap.sessionId) {
          void this.store.updateChat(snap.id, { sessionId: snap.sessionId });
        }
      }
    };
    this.sessions.on("chat-update", listener);
    this.disposables.push({
      dispose: () => this.sessions.off("chat-update", listener),
    });
  }

  private bind(chatId: string): void {
    this.boundChatId = chatId;
    const session = this.sessions.get(chatId);
    const meta = this.store.getChat(chatId);
    this.panel.title = meta?.title ? `Claude — ${meta.title}` : "Claude Fleet";
    if (session) {
      // Start the query on open so slash-commands + rate limits load immediately.
      session.ensureStarted();
      this.post({ type: "open", chat: session.snapshot() });
      // Lazily reconstruct history from disk for imported/resumed chats.
      if (session.needsHistory) {
        void loadTranscript(session.sessionId!, { maxItems: 400 })
          .then((items) => {
            // The chat may have been re-bound while loading; guard on identity.
            if (this.boundChatId === chatId) session.seedTranscript(items);
            else session.seedTranscript(items);
          })
          .catch(() => session.seedTranscript([]));
      }
    }
    this.notifyFocusIfActive();
  }

  private notifyFocusIfActive(): void {
    if (this.panel.active && this.boundChatId) {
      ChatPanel.onFocusChat?.(this.boundChatId);
    }
  }

  private onMessage(m: WebviewToHost): void {
    switch (m.type) {
      case "ready": {
        // Webview finished loading; push current chat if bound.
        if (this.boundChatId) this.bind(this.boundChatId);
        this.postQuickActions();
        break;
      }
      case "send": {
        this.sessions.get(m.chatId)?.send(m.text, m.images);
        break;
      }
      case "interrupt": {
        void this.sessions.get(m.chatId)?.interrupt();
        break;
      }
      case "rewind": {
        const session = this.sessions.get(m.chatId);
        if (!session) break;
        void session.rewindTo(m.userMessageId).then((r) => {
          if (r.ok) {
            const n = r.filesChanged?.length ?? 0;
            void vscode.window.showInformationMessage(
              `Rewind: conversazione riportata indietro${
                n ? ` · ${n} file ripristinati` : ""
              }.`
            );
          } else {
            void vscode.window.showWarningMessage(
              `Rewind file non riuscito (${r.error ?? "impossibile"}); conversazione comunque riportata indietro.`
            );
          }
        });
        break;
      }
      case "openDiff": {
        void this.openDiff(m.chatId, m.path);
        break;
      }
      case "permission": {
        const session = this.sessions.get(m.chatId);
        session?.resolvePermission(m.requestId, m.decision, m.remember);
        // "Approve & run" on an ExitPlanMode card: allow, then leave plan mode.
        if (m.exitPlan && m.decision === "allow" && session) {
          void session.setPermissionMode("default").then(() => {
            void this.store.updateChat(m.chatId, {
              config: {
                ...session.snapshot().config,
                permissionMode: "default",
              },
            });
          });
        }
        break;
      }
      case "setConfig": {
        void this.sessions.get(m.chatId)?.setConfig(m.config);
        void this.store.updateChat(m.chatId, {
          config: m.config,
          model: m.config.model,
        });
        break;
      }
      case "setPermissionMode": {
        const session = this.sessions.get(m.chatId);
        void session?.setPermissionMode(m.mode);
        void this.store.updateChat(m.chatId, {
          config: { ...(session?.snapshot().config ?? {}), permissionMode: m.mode },
        });
        break;
      }
      case "openSettings": {
        void vscode.commands.executeCommand("claudeFleet.openSettings");
        break;
      }
      case "manageMcp": {
        void vscode.commands.executeCommand("claudeFleet.manageMcp");
        break;
      }
      case "refreshUsage": {
        this.sessions.get(m.chatId)?.requestUsage();
        break;
      }
      case "openFile": {
        void this.openFile(m.chatId, m.path);
        break;
      }
      case "slash": {
        const session = this.sessions.get(m.chatId);
        if (!session) break;
        if (m.command === "clear") {
          void session.clearSession();
          void this.store.updateChat(m.chatId, { sessionId: undefined });
        } else if (m.command === "compact") {
          session.compact(m.args);
        }
        break;
      }
      case "openExternal": {
        // Only open web/mail links externally.
        if (/^(https?|mailto):/i.test(m.url)) {
          void vscode.env.openExternal(vscode.Uri.parse(m.url));
        }
        break;
      }
      case "searchFiles": {
        void this.searchFiles(m.query, m.requestId);
        break;
      }
    }
  }

  /** Open a file referenced in the transcript, resolved against the chat's cwd. */
  private async openFile(chatId: string, p: string): Promise<void> {
    const cwd = this.store.getChat(chatId)?.cwd;
    const abs = path.isAbsolute(p) ? p : cwd ? path.join(cwd, p) : p;
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
      await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.One });
    } catch {
      void vscode.window.showWarningMessage(`Impossibile aprire il file: ${abs}`);
    }
  }

  /** Open the native VS Code git diff (working tree vs HEAD) for an edited file. */
  private async openDiff(chatId: string, p: string): Promise<void> {
    const cwd = this.store.getChat(chatId)?.cwd;
    const abs = path.isAbsolute(p) ? p : cwd ? path.join(cwd, p) : p;
    const uri = vscode.Uri.file(abs);
    try {
      // VS Code's built-in Git extension provides this command (working ⇄ HEAD).
      await vscode.commands.executeCommand("git.openChange", uri);
    } catch {
      // Fallback: just open the file if git diff isn't available.
      void this.openFile(chatId, p);
    }
  }

  private async searchFiles(query: string, requestId: number): Promise<void> {
    const q = query.trim();
    const glob = q ? `**/*${q}*` : "**/*";
    const exclude =
      "**/{node_modules,.git,dist,out,.next,build,.venv,__pycache__}/**";
    let uris: vscode.Uri[] = [];
    try {
      uris = await vscode.workspace.findFiles(glob, exclude, 200);
    } catch {
      uris = [];
    }
    const ql = q.toLowerCase();
    const matches = uris
      .map((u) => {
        const rel = vscode.workspace.asRelativePath(u, false).replace(/\\/g, "/");
        return { path: rel, name: rel.split("/").pop() ?? rel };
      })
      .map((m) => {
        const nl = m.name.toLowerCase();
        const pl = m.path.toLowerCase();
        let score = 3;
        if (!ql) score = 0;
        else if (nl.startsWith(ql)) score = 0;
        else if (nl.includes(ql)) score = 1;
        else if (pl.includes(ql)) score = 2;
        return { m, score };
      })
      .filter((x) => x.score < 3)
      .sort((a, b) => a.score - b.score || a.m.path.length - b.m.path.length)
      .slice(0, 12)
      .map((x) => x.m);
    this.post({ type: "fileResults", requestId, matches });
  }

  /** Merge built-in defaults with claudeFleet.quickActions and push to webview. */
  private postQuickActions(): void {
    const raw = vscode.workspace
      .getConfiguration("claudeFleet")
      .get<Array<{ label?: unknown; prompt?: unknown; title?: unknown }>>(
        "quickActions",
        []
      );
    const merged: QuickAction[] = [...DEFAULT_QUICK_ACTIONS];
    if (Array.isArray(raw)) {
      for (const a of raw) {
        if (!a || typeof a.label !== "string" || typeof a.prompt !== "string") continue;
        const label = a.label.trim();
        if (!label || !a.prompt.trim()) continue;
        const action: QuickAction = {
          label,
          prompt: a.prompt,
          title: typeof a.title === "string" ? a.title : undefined,
        };
        const i = merged.findIndex((m) => m.label === label);
        if (i >= 0) merged[i] = action;
        else merged.push(action);
      }
    }
    this.post({ type: "quickActions", actions: merged });
  }

  private post(msg: HostToWebview): void {
    void this.panel.webview.postMessage(msg);
  }

  private html(): string {
    const webview = this.panel.webview;
    const base = vscode.Uri.joinPath(
      this.ctx.extensionUri,
      "dist",
      "webview"
    );
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
      `media-src data:`,
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
  <title>Claude Fleet</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    ChatPanel.current = undefined;
    while (this.disposables.length) this.disposables.pop()?.dispose();
    this.panel.dispose();
  }
}
