import { EventEmitter } from "node:events";
import { ChatSession } from "./ChatSession";
import { buildAuthEnv, type AuthEnvResult } from "./AuthPreflight";
import type { ChatSnapshot, ChatConfig } from "../../shared/protocol";

export interface CreateChatOpts {
  id?: string;
  title?: string;
  cwd: string;
  model?: string;
  config?: ChatConfig;
  resumeSessionId?: string;
}

/**
 * Owns every live ChatSession in the process. The extension talks only to this;
 * it re-emits per-chat "update" events and keeps the shared auth environment.
 */
export class SessionManager extends EventEmitter {
  private chats = new Map<string, ChatSession>();
  private auth?: AuthEnvResult;
  /** Chats that finished a turn while the user wasn't looking (attention badge). */
  private unseenDone = new Set<string>();
  /** When true, each session loads its cwd's `.mcp.json` servers (setting-driven,
   *  set by the extension host at activation). */
  loadProjectMcp = true;

  constructor(private configuredClaudePath: string) {
    super();
  }

  // ---- attention badge (spec: attention-badge) ----
  markUnseen(id: string): void {
    if (!this.chats.has(id)) return;
    this.unseenDone.add(id);
    this.emit("attention-changed");
  }
  clearUnseen(id: string): void {
    if (this.unseenDone.delete(id)) this.emit("attention-changed");
  }
  /** Ids needing attention: unseen-done ∪ chats currently waiting for permission. */
  attentionIds(): string[] {
    const ids = new Set(this.unseenDone);
    for (const [id, chat] of this.chats) {
      if (chat.snapshot().status === "waiting-permission") ids.add(id);
    }
    return [...ids];
  }
  attentionCount(): number {
    return this.attentionIds().length;
  }

  async preflight(): Promise<AuthEnvResult> {
    if (!this.auth) {
      this.auth = await buildAuthEnv(this.configuredClaudePath);
    }
    return this.auth;
  }

  list(): ChatSession[] {
    return [...this.chats.values()];
  }

  get(id: string): ChatSession | undefined {
    return this.chats.get(id);
  }

  async create(opts: CreateChatOpts): Promise<ChatSession> {
    const auth = await this.preflight();
    const chat = new ChatSession({
      id: opts.id,
      title: opts.title,
      cwd: opts.cwd,
      model: opts.model,
      config: opts.config,
      resumeSessionId: opts.resumeSessionId,
      pathToClaudeCodeExecutable: auth.claudePath,
      env: auth.env,
      loadProjectMcp: this.loadProjectMcp,
    });
    chat.on("update", (snap: ChatSnapshot) => {
      this.emit("chat-update", snap);
    });
    chat.on("needs-permission", (snap: ChatSnapshot) => {
      this.emit("needs-permission", snap);
      this.emit("attention-changed");
    });
    chat.on("turn-done", (snap: ChatSnapshot) => {
      this.emit("turn-done", snap);
    });
    this.chats.set(chat.id, chat);
    this.emit("chat-update", chat.snapshot());
    return chat;
  }

  delete(id: string): void {
    const chat = this.chats.get(id);
    if (!chat) return;
    chat.dispose();
    this.chats.delete(id);
    this.unseenDone.delete(id);
    this.emit("chat-removed", id);
  }

  disposeAll(): void {
    for (const chat of this.chats.values()) chat.dispose();
    this.chats.clear();
    this.unseenDone.clear();
  }
}
