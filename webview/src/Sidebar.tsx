import React, { useEffect, useMemo, useState } from "react";
import { vscodeRaw } from "./acquire";
import type {
  SidebarTree,
  SidebarChat,
  SidebarFolder,
  SidebarToHost,
  HostToSidebar,
  ChatStatus,
} from "../../shared/protocol";

function post(msg: SidebarToHost) {
  vscodeRaw.postMessage(msg);
}

export function Sidebar() {
  const [tree, setTree] = useState<SidebarTree | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  useEffect(() => {
    const handler = (ev: MessageEvent) => {
      const msg = ev.data as HostToSidebar;
      if (msg.type === "tree") setTree(msg.tree);
    };
    window.addEventListener("message", handler);
    post({ type: "ready" });
    return () => window.removeEventListener("message", handler);
  }, []);

  const rootFolders = useMemo(
    () => (tree ? tree.folders.filter((f) => f.parentId === null) : []),
    [tree]
  );
  const rootChats = useMemo(
    () => (tree ? tree.chats.filter((c) => c.parentId === null) : []),
    [tree]
  );

  if (!tree) return <div className="sb-empty">Loading…</div>;

  const isEmpty = tree.folders.length === 0 && tree.chats.length === 0;

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  return (
    <div className="sb">
      <div className="sb-toolbar">
        <button className="sb-btn primary" onClick={() => post({ type: "newChat" })}>
          + New chat
        </button>
        <button className="sb-icon" title="New folder" onClick={() => post({ type: "newFolder" })}>
          🗂
        </button>
        <button className="sb-icon" title="Import Claude Code sessions" onClick={() => post({ type: "import" })}>
          ⬇
        </button>
        <button
          className={`sb-icon ${tree.showArchived ? "on" : ""}`}
          title={tree.showArchived ? "Hide archived" : "Show archived"}
          onClick={() => post({ type: "toggleArchived" })}
        >
          🗄
        </button>
      </div>

      {isEmpty && (
        <div className="sb-empty">
          No chats yet.<br />Create one or import your Claude Code sessions.
        </div>
      )}

      <div className="sb-list">
        {rootChats.map((c) => (
          <ChatRow key={c.id} chat={c} active={c.id === tree.activeChatId} />
        ))}
        {rootFolders.map((f) => (
          <FolderBlock
            key={f.id}
            folder={f}
            tree={tree}
            collapsed={collapsed}
            onToggle={toggle}
            activeChatId={tree.activeChatId}
          />
        ))}
      </div>
    </div>
  );
}

function FolderBlock({
  folder,
  tree,
  collapsed,
  onToggle,
  activeChatId,
}: {
  folder: SidebarFolder;
  tree: SidebarTree;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
  activeChatId?: string;
}) {
  const chats = tree.chats.filter((c) => c.parentId === folder.id);
  const subfolders = tree.folders.filter((f) => f.parentId === folder.id);
  const isCollapsed = collapsed.has(folder.id);
  const running = chats.filter((c) => c.status === "running").length;

  return (
    <div className="sb-folder">
      <div className="sb-folder-head" onClick={() => onToggle(folder.id)}>
        <span className="sb-caret">{isCollapsed ? "▸" : "▾"}</span>
        <span className="sb-folder-icon">📁</span>
        <span className="sb-folder-title">{folder.title}</span>
        <span className="sb-folder-count">
          {running > 0 && <span className="sb-run-badge">{running}●</span>}
          {chats.length}
        </span>
      </div>
      {!isCollapsed && (
        <div className="sb-folder-body">
          {chats.map((c) => (
            <ChatRow key={c.id} chat={c} active={c.id === activeChatId} />
          ))}
          {subfolders.map((f) => (
            <FolderBlock
              key={f.id}
              folder={f}
              tree={tree}
              collapsed={collapsed}
              onToggle={onToggle}
              activeChatId={activeChatId}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ChatRow({ chat, active }: { chat: SidebarChat; active: boolean }) {
  return (
    <div
      className={`sb-chat ${active ? "active" : ""} ${chat.archived ? "archived" : ""}`}
      onClick={() => post({ type: "open", chatId: chat.id })}
      title={chat.title}
    >
      <StatusDot status={chat.status} archived={chat.archived} />
      <div className="sb-chat-main">
        <div className="sb-chat-title">{chat.title}</div>
        <div className="sb-chat-sub">{subLabel(chat)}</div>
        <div className="sb-meta">
          {chat.model && <span className="sb-meta-model">{shortModel(chat.model)}</span>}
          {(chat.turns ?? 0) > 0 && <span>{chat.turns} turni</span>}
          {(chat.inputTokens || chat.outputTokens) ? (
            <span title="Token">
              {fmt((chat.inputTokens ?? 0) + (chat.outputTokens ?? 0))} tok
            </span>
          ) : null}
          {chat.costUsd ? <span>${chat.costUsd.toFixed(2)}</span> : null}
          {chat.lastActivityTs && <span className="sb-meta-time">{relTime(chat.lastActivityTs)}</span>}
        </div>
        {chat.cwd && <div className="sb-cwd" title={chat.cwd}>{shortCwd(chat.cwd)}</div>}
      </div>
      <div className="sb-actions" onClick={(e) => e.stopPropagation()}>
        {chat.status === "running" && (
          <button className="sb-a" title="Stop" onClick={() => post({ type: "stop", id: chat.id })}>
            ■
          </button>
        )}
        <button className="sb-a" title="Rename" onClick={() => post({ type: "rename", id: chat.id })}>
          ✎
        </button>
        {chat.archived ? (
          <button className="sb-a" title="Unarchive" onClick={() => post({ type: "unarchive", id: chat.id })}>
            ⤴
          </button>
        ) : (
          <button className="sb-a" title="Archive" onClick={() => post({ type: "archive", id: chat.id })}>
            🗄
          </button>
        )}
        <button className="sb-a danger" title="Delete" onClick={() => post({ type: "delete", id: chat.id })}>
          🗑
        </button>
      </div>
    </div>
  );
}

function StatusDot({ status, archived }: { status: ChatStatus; archived: boolean }) {
  const cls = archived ? "archived" : status;
  return <span className={`sb-dot ${cls}`} />;
}

function shortModel(id?: string): string {
  if (!id) return "";
  return id.replace(/^claude-/, "").replace(/-\d{8}$/, "").replace(/\[1m\]$/, "");
}
function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}
function relTime(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "ora";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m fa`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h fa`;
  return `${Math.floor(h / 24)}g fa`;
}
function shortCwd(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts.length <= 2 ? p : "…/" + parts.slice(-2).join("/");
}

function subLabel(chat: SidebarChat): string {
  if (chat.archived) return "archived";
  if (chat.activity) return chat.activity;
  switch (chat.status) {
    case "running":
      return "running…";
    case "waiting-permission":
      return "needs permission";
    case "error":
      return "error";
    default:
      return "idle";
  }
}
