import * as vscode from "vscode";
import type { ChatConfig } from "../../shared/protocol";

/** Persistent metadata for one chat (the live session lives in SessionManager). */
export interface ChatMeta {
  id: string;
  title: string;
  parentId: string | null; // folder id, or null for root
  cwd: string;
  model?: string;
  config?: ChatConfig; // per-chat model/effort/permissionMode
  sessionId?: string; // SDK session id, for resume across restarts
  archived?: boolean; // hidden from the default view, not deleted
}

export interface FolderMeta {
  id: string;
  title: string;
  parentId: string | null;
}

interface StoreData {
  folders: FolderMeta[];
  chats: ChatMeta[];
}

const KEY = "claudeFleet.store.v1";

/**
 * Persists the tree structure (folders + chat placeholders) in **globalState**
 * so chats are visible in every VS Code window regardless of which folder is
 * open (workspaceState is per-workspace — the cause of "chats disappear on
 * reopen"). Migrates any data previously saved in workspaceState.
 *
 * The actual conversation transcripts live on disk in Claude Code's session
 * files; we only keep enough to rebuild the tree and resume sessions.
 */
export class FolderStore {
  private data: StoreData;
  private readonly onChangeEmitter = new vscode.EventEmitter<void>();
  readonly onChange = this.onChangeEmitter.event;

  constructor(private ctx: vscode.ExtensionContext) {
    const global = ctx.globalState.get<StoreData>(KEY);
    const legacy = ctx.workspaceState.get<StoreData>(KEY);
    if (global) {
      this.data = global;
    } else if (legacy) {
      // One-time migration from the old per-workspace store.
      this.data = legacy;
      void ctx.globalState.update(KEY, this.data);
      void ctx.workspaceState.update(KEY, undefined);
    } else {
      this.data = { folders: [], chats: [] };
    }
  }

  private async persist(): Promise<void> {
    await this.ctx.globalState.update(KEY, this.data);
    this.onChangeEmitter.fire();
  }

  folders(): FolderMeta[] {
    return this.data.folders;
  }
  chats(): ChatMeta[] {
    return this.data.chats;
  }

  childFolders(parentId: string | null): FolderMeta[] {
    return this.data.folders.filter((f) => f.parentId === parentId);
  }
  childChats(parentId: string | null, includeArchived = false): ChatMeta[] {
    return this.data.chats.filter(
      (c) => c.parentId === parentId && (includeArchived || !c.archived)
    );
  }
  archivedCount(): number {
    return this.data.chats.filter((c) => c.archived).length;
  }
  async setArchived(id: string, archived: boolean): Promise<void> {
    const c = this.data.chats.find((x) => x.id === id);
    if (!c) return;
    c.archived = archived;
    await this.persist();
  }

  getChat(id: string): ChatMeta | undefined {
    return this.data.chats.find((c) => c.id === id);
  }

  async addFolder(title: string, parentId: string | null): Promise<FolderMeta> {
    const folder: FolderMeta = {
      id: `folder-${Date.now()}-${Math.floor(this.data.folders.length + 1)}`,
      title,
      parentId,
    };
    this.data.folders.push(folder);
    await this.persist();
    return folder;
  }

  async addChat(meta: ChatMeta): Promise<void> {
    this.data.chats.push(meta);
    await this.persist();
  }

  async updateChat(id: string, patch: Partial<ChatMeta>): Promise<void> {
    const c = this.data.chats.find((x) => x.id === id);
    if (!c) return;
    Object.assign(c, patch);
    await this.persist();
  }

  async rename(id: string, title: string): Promise<void> {
    const f = this.data.folders.find((x) => x.id === id);
    if (f) {
      f.title = title;
      return this.persist();
    }
    const c = this.data.chats.find((x) => x.id === id);
    if (c) {
      c.title = title;
      return this.persist();
    }
  }

  /** Reparent a folder, guarding against cycles (can't move it into itself
   *  or one of its own descendants). No-op if that would create a loop. */
  async moveFolder(id: string, parentId: string | null): Promise<void> {
    if (id === parentId) return;
    const f = this.data.folders.find((x) => x.id === id);
    if (!f) return;
    let cur = parentId;
    while (cur) {
      if (cur === id) return; // parentId is a descendant of id → would loop
      cur = this.data.folders.find((x) => x.id === cur)?.parentId ?? null;
    }
    f.parentId = parentId;
    await this.persist();
  }

  async remove(id: string): Promise<string[]> {
    // Returns the ids of chats that were removed (so their sessions can be disposed).
    const removedChats: string[] = [];
    const removeFolderRec = (folderId: string) => {
      for (const c of this.data.chats.filter((x) => x.parentId === folderId)) {
        removedChats.push(c.id);
      }
      this.data.chats = this.data.chats.filter((x) => x.parentId !== folderId);
      const subs = this.data.folders.filter((x) => x.parentId === folderId);
      this.data.folders = this.data.folders.filter((x) => x.id !== folderId);
      for (const s of subs) removeFolderRec(s.id);
    };

    if (this.data.folders.some((f) => f.id === id)) {
      removeFolderRec(id);
    } else {
      const c = this.data.chats.find((x) => x.id === id);
      if (c) {
        removedChats.push(c.id);
        this.data.chats = this.data.chats.filter((x) => x.id !== id);
      }
    }
    await this.persist();
    return removedChats;
  }
}
