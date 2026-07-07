import * as vscode from "vscode";
import type { SessionManager } from "../core/SessionManager";
import type { ChatSnapshot } from "../../shared/protocol";
import { ChatPanel } from "./ChatPanel";
import { playNotificationSound } from "./SystemSound";

/**
 * Plays a sound and shows a VS Code toast when a chat needs a permission or
 * finishes a turn. The sound is played from the extension host (see
 * SystemSound) so it fires even when no chat panel is open — the common case in
 * a multi-session tool. Sounds always fire (user preference); toasts are
 * informational and let you jump straight to the chat.
 */
export function registerNotifications(
  ctx: vscode.ExtensionContext,
  sessions: SessionManager
): void {
  const onPermission = (snap: ChatSnapshot) => {
    playNotificationSound("permission");
    void vscode.window
      .showWarningMessage(
        `“${snap.title}” needs permission: ${
          snap.pendingPermission?.displayName ??
          snap.pendingPermission?.toolName ??
          "a tool"
        }`,
        "Open"
      )
      .then((choice) => {
        if (choice === "Open") {
          void vscode.commands.executeCommand("claudeFleet.openChat", snap.id);
        }
      });
  };

  const onTurnDone = (snap: ChatSnapshot) => {
    playNotificationSound("done");
    // Keep the "done" toast quiet if you're already looking at this chat.
    if (ChatPanel.isFocused()) return;
    void vscode.window
      .showInformationMessage(`“${snap.title}” finished responding.`, "Open")
      .then((choice) => {
        if (choice === "Open") {
          void vscode.commands.executeCommand("claudeFleet.openChat", snap.id);
        }
      });
  };

  sessions.on("needs-permission", onPermission);
  sessions.on("turn-done", onTurnDone);
  ctx.subscriptions.push({
    dispose: () => {
      sessions.off("needs-permission", onPermission);
      sessions.off("turn-done", onTurnDone);
    },
  });
}
