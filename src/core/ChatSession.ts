import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
// Types only — erased at build time so this stays a `type` import (no runtime require).
import type {
  Query,
  Options,
  SDKMessage,
  SDKUserMessage,
  PermissionResult,
  SlashCommand,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  ChatSnapshot,
  ChatStatus,
  ChatConfig,
  PendingPermission,
  TranscriptItem,
  UsageStats,
  TodoEntry,
  FileEditOp,
  AvailableCommand,
  McpServerInfo,
  RateLimits,
} from "../../shared/protocol";
import {
  parseTodos,
  parseEdit,
  nameForToolUse,
  summarizeResult,
  contextWindowForModel,
} from "../../shared/parsers";

// The SDK is a pure-ESM package; the extension bundle is CJS. A static
// `require()` of it throws ERR_REQUIRE_ESM, so we load it via dynamic import()
// (which esbuild preserves as a real runtime import) and cache the module.
type SdkModule = typeof import("@anthropic-ai/claude-agent-sdk");
let sdkPromise: Promise<SdkModule> | undefined;
function loadSdk(): Promise<SdkModule> {
  if (!sdkPromise) {
    sdkPromise = import("@anthropic-ai/claude-agent-sdk");
  }
  return sdkPromise;
}

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}-${process.pid}`;
}

export interface ChatSessionInit {
  id?: string;
  title?: string;
  cwd: string;
  model?: string;
  config?: ChatConfig;
  resumeSessionId?: string;
  pathToClaudeCodeExecutable?: string;
  /** Environment for the subprocess. We deliberately strip ANTHROPIC_API_KEY
   *  so the SDK falls back to the logged-in subscription (see AuthPreflight). */
  env: NodeJS.ProcessEnv;
  /** When true, load the cwd's `.mcp.json` and pass its servers to the SDK
   *  (project `.mcp.json` servers aren't auto-approved in headless mode). */
  loadProjectMcp?: boolean;
}

/**
 * Wraps one Claude Agent SDK `query()` as a long-lived, interactive chat.
 *
 * Uses **streaming input mode** (prompt = AsyncIterable) so we can:
 *  - send many user turns into the same session, and
 *  - use interrupt() / setPermissionMode() (only available in that mode).
 *
 * The class is an EventEmitter emitting a single "update" event whenever the
 * snapshot changes; the SessionManager relays that to the sidebar and webview.
 */
export class ChatSession extends EventEmitter {
  readonly id: string;
  title: string;
  cwd: string;
  model?: string;
  sessionId?: string;

  private status: ChatStatus = "idle";
  private transcript: TranscriptItem[] = [];
  private streamingText = "";
  private streamingThinking = "";
  private pending?: PendingPermission;
  private activity?: string;
  /** todoBlockId of the current live TodoWrite checklist (replace-in-place). */
  private todoBlockId?: string;
  /** Slash commands from the SDK (populated after init). */
  private availableCommands: AvailableCommand[] = [];
  /** Subscription rate limits captured from the SDK init message. */
  private limits?: RateLimits;
  /** MCP servers + connection status, captured from the SDK init message. */
  private mcpServers: McpServerInfo[] = [];
  /** Context-window meter (latest turn). */
  private contextTokens?: number;
  private contextWindow?: number;
  /** One-shot: resume the session only up to this message uuid (for rewind). */
  private resumeAt?: string;
  private config: ChatConfig;
  private usage: UsageStats = {
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    turns: 0,
  };

  private q?: Query;
  private starting = false;
  private inbox: SDKUserMessage[] = [];
  private inboxNotify?: () => void;
  private closed = false;
  private readonly env: NodeJS.ProcessEnv;
  private readonly pathToClaude?: string;
  private readonly loadProjectMcp: boolean;

  constructor(init: ChatSessionInit) {
    super();
    this.id = init.id ?? nextId("chat");
    this.title = init.title ?? "New chat";
    this.cwd = init.cwd;
    this.config = init.config ?? {};
    // model lives in config; keep the legacy field in sync for display.
    this.model = init.config?.model || init.model;
    if (!this.config.model && init.model) this.config.model = init.model;
    this.sessionId = init.resumeSessionId;
    this.env = init.env;
    this.pathToClaude = init.pathToClaudeCodeExecutable;
    this.loadProjectMcp = init.loadProjectMcp ?? false;
  }

  /** Read the cwd's `.mcp.json` so its servers can be passed to the SDK. The SDK
   *  won't load project `.mcp.json` servers on its own (they need approval), so
   *  we hand them over explicitly. Re-read on each (re)start to pick up edits. */
  private projectMcpServers(): Record<string, unknown> | undefined {
    if (!this.loadProjectMcp) return undefined;
    try {
      const raw = fs.readFileSync(path.join(this.cwd, ".mcp.json"), "utf8");
      const servers = JSON.parse(raw)?.mcpServers;
      if (servers && typeof servers === "object" && Object.keys(servers).length) {
        return servers as Record<string, unknown>;
      }
    } catch {
      /* no .mcp.json / unreadable / malformed → nothing to add */
    }
    return undefined;
  }

  // ---- public API used by SessionManager / commands ----

  /** True if this chat has no transcript yet (candidate for history load). */
  get isEmpty(): boolean {
    return this.transcript.length === 0;
  }

  private historyLoaded = false;
  get needsHistory(): boolean {
    return !this.historyLoaded && this.isEmpty && !!this.sessionId;
  }

  /** Seed the transcript with reconstructed history (from disk). No-op if not empty. */
  seedTranscript(items: TranscriptItem[]): void {
    this.historyLoaded = true;
    if (items.length === 0 || this.transcript.length > 0) return;
    this.transcript = items;
    this.emitUpdate();
  }

  snapshot(): ChatSnapshot {
    return {
      id: this.id,
      title: this.title,
      status: this.status,
      sessionId: this.sessionId,
      cwd: this.cwd,
      model: this.model,
      transcript: this.transcript,
      pendingPermission: this.pending,
      streamingText: this.streamingText || undefined,
      streamingThinking: this.streamingThinking || undefined,
      activity: this.activity,
      config: this.config,
      usage: this.usage,
      availableCommands: this.availableCommands,
      limits: this.limits,
      queued: this.inbox.length,
      canRewind: true,
      contextTokens: this.contextTokens,
      contextWindow: this.contextWindow,
      mcpServers: this.mcpServers,
    };
  }

  private contextWindowFromResult(msg: any): number {
    const mu = msg?.modelUsage as
      | Record<string, { contextWindow?: number }>
      | undefined;
    let win = 0;
    if (mu) {
      for (const k of Object.keys(mu)) {
        const cwv = mu[k]?.contextWindow;
        if (typeof cwv === "number" && cwv > win) win = cwv;
      }
    }
    if (win > 0) return win;
    return contextWindowForModel(this.model);
  }

  /** Rewind tracked files to their state at a given user message. */
  async rewindFiles(
    userMessageId: string,
    dryRun = false
  ): Promise<{ ok: boolean; error?: string; filesChanged?: string[] }> {
    if (!this.q || typeof (this.q as any).rewindFiles !== "function") {
      return { ok: false, error: "Checkpointing non attivo (invia prima un messaggio)." };
    }
    try {
      const r = await this.q.rewindFiles(userMessageId, { dryRun });
      return { ok: r.canRewind, error: r.error, filesChanged: r.filesChanged };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Full rewind (files + conversation) to a user message: revert tracked files,
   *  truncate the local transcript to before that message, and restart the query
   *  resumed only up to that point. Falls back to file-only if the resume fails. */
  async rewindTo(
    userMessageId: string
  ): Promise<{ ok: boolean; error?: string; filesChanged?: string[] }> {
    const fileRes = await this.rewindFiles(userMessageId);
    // Truncate the local transcript to before the target user message.
    const idx = this.transcript.findIndex(
      (t) => t.kind === "user" && t.uuid === userMessageId
    );
    if (idx >= 0) this.transcript = this.transcript.slice(0, idx);
    // Rewind the SDK conversation: restart resumed up to that message.
    this.resumeAt = userMessageId;
    try {
      this.q?.close();
    } catch {
      /* noop */
    }
    this.q = undefined;
    this.streamingText = "";
    this.streamingThinking = "";
    this.pending = undefined;
    this.activity = undefined;
    this.setStatus("idle");
    this.ensureStarted();
    this.emitUpdate();
    return fileRes;
  }

  /**
   * Apply a new per-chat config. Model & permission-mode changes take effect
   * live (streaming-input control requests); effort applies on the next turn,
   * so if it changed we drop the query so it restarts with the new option.
   */
  async setConfig(next: ChatConfig): Promise<void> {
    const prev = this.config;
    this.config = { ...prev, ...next };
    this.model = this.config.model || this.model;

    if (this.q) {
      try {
        if (next.model !== undefined && next.model !== prev.model) {
          await this.q.setModel(this.config.model || undefined);
        }
        if (
          next.permissionMode !== undefined &&
          next.permissionMode !== prev.permissionMode
        ) {
          await this.q.setPermissionMode(this.config.permissionMode as any);
        }
      } catch {
        /* control requests only valid mid-stream; ignore if not applicable */
      }
      // effort & thinking have no live setter — restart the query to apply.
      const effortChanged = next.effort !== undefined && next.effort !== prev.effort;
      const thinkingChanged =
        next.thinking !== undefined && next.thinking !== prev.thinking;
      if (effortChanged || thinkingChanged) {
        try {
          this.q.close();
        } catch {
          /* noop */
        }
        this.q = undefined;
        // Re-open right away so commands/usage/limits stay live after the swap.
        this.ensureStarted();
      }
    }
    this.emitUpdate();
  }

  /** Convenience for the plan-mode toggle: flip permissionMode live. */
  async setPermissionMode(mode: ChatConfig["permissionMode"]): Promise<void> {
    await this.setConfig({ permissionMode: mode });
  }

  /** Start the query without sending a turn, so init fires and we learn the
   *  available slash-commands + subscription rate limits immediately (before the
   *  user's first message). Called when a chat is opened. No-op if already up. */
  ensureStarted(): void {
    if (this.closed || this.q || this.starting) return;
    // Don't auto-start a plain new chat with no history — only worth it once
    // there's something to resume OR the user has opened it (we always call this
    // on open). Starting is cheap: the query blocks on the empty prompt stream.
    void this.startQuery();
  }

  /** Send a user turn (optionally with images). Lazily starts the query. */
  send(text: string, images?: { mediaType: string; dataBase64: string }[]): void {
    if (this.closed) return;
    this.transcript.push({
      kind: "user",
      text,
      ts: Date.now(),
      ...(images && images.length ? { images: images.length } : {}),
    });
    // Build the message content: text + optional image blocks (Anthropic format).
    const content: any =
      images && images.length
        ? [
            ...(text ? [{ type: "text", text }] : []),
            ...images.map((im) => ({
              type: "image",
              source: { type: "base64", media_type: im.mediaType, data: im.dataBase64 },
            })),
          ]
        : text;
    const msg: SDKUserMessage = {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: this.sessionId ?? "",
    } as unknown as SDKUserMessage;
    this.inbox.push(msg);
    this.setStatus("running");
    if (!this.q && !this.starting) {
      void this.startQuery();
    } else {
      // Wake the async prompt generator so it yields the queued message.
      this.inboxNotify?.();
    }
    this.emitUpdate();
  }

  async interrupt(): Promise<void> {
    try {
      await this.q?.interrupt();
    } catch {
      /* interrupt only valid mid-turn; ignore otherwise */
    }
    this.setStatus("idle");
    this.emitUpdate();
  }

  /** /clear — start a brand-new conversation: drop resume, clear transcript +
   *  usage, restart the query (new session_id on next init). Keeps the chat entry. */
  async clearSession(): Promise<void> {
    if (this.closed) return;
    try {
      this.q?.close();
    } catch {
      /* noop */
    }
    this.q = undefined;
    this.sessionId = undefined;
    this.transcript = [];
    this.streamingText = "";
    this.streamingThinking = "";
    this.pending = undefined;
    this.activity = undefined;
    this.todoBlockId = undefined;
    this.inbox = [];
    this.usage = { inputTokens: 0, outputTokens: 0, costUsd: 0, turns: 0 };
    this.contextTokens = undefined;
    this.setStatus("idle");
    this.ensureStarted();
    this.emitUpdate();
  }

  /** /compact — trigger context compaction. The SDK Query has no compact()
   *  method, so we feed "/compact" through the prompt stream WITHOUT a visible
   *  user turn; the subprocess reports it via a system/compact_boundary message. */
  compact(instructions?: string): void {
    if (this.closed) return;
    const arg = instructions?.trim();
    this.enqueueText(arg ? `/compact ${arg}` : "/compact");
    this.activity = "compattazione…";
    this.setStatus("running");
    this.emitUpdate();
  }

  /** Resolve a pending permission request from the UI. */
  resolvePermission(
    requestId: string,
    decision: "allow" | "deny",
    remember = false
  ): void {
    const p = this.permissionResolvers.get(requestId);
    if (!p) return;
    this.permissionResolvers.delete(requestId);
    // Capture the tool input BEFORE clearing `pending`; the SDK's PermissionResult
    // validator requires `updatedInput` (a record) on an "allow" result — omitting
    // it throws a ZodError and the tool call fails. Echo the original input.
    const originalInput = this.pending?.input ?? {};
    const suggestions = this.pendingSuggestions.get(requestId);
    this.pendingSuggestions.delete(requestId);
    if (this.pending?.requestId === requestId) this.pending = undefined;
    p(
      decision === "allow"
        ? {
            behavior: "allow",
            updatedInput: originalInput,
            // "Allow always" applies the SDK's suggested permission rules so
            // this tool won't prompt again this session.
            ...(remember && suggestions
              ? { updatedPermissions: suggestions as any }
              : {}),
          }
        : { behavior: "deny", message: "Denied by user" }
    );
    // Back to running while the tool executes / model continues.
    if (this.status === "waiting-permission") this.setStatus("running");
    this.activity = decision === "allow" ? "working…" : undefined;
    this.emitUpdate();
  }

  dispose(): void {
    this.closed = true;
    if (this.usageTimer) clearInterval(this.usageTimer);
    try {
      this.q?.close();
    } catch {
      /* noop */
    }
    // Reject any dangling permission prompts so the subprocess doesn't hang.
    for (const [, resolve] of this.permissionResolvers) {
      resolve({ behavior: "deny", message: "Chat closed" });
    }
    this.permissionResolvers.clear();
    this.inboxNotify?.();
  }

  // ---- internals ----

  private permissionResolvers = new Map<
    string,
    (r: PermissionResult) => void
  >();

  /** SDK-provided permission suggestions per request, used for "Allow always". */
  private pendingSuggestions = new Map<string, unknown[]>();

  private canUseTool = (
    toolName: string,
    input: Record<string, unknown>,
    opts: {
      title?: string;
      displayName?: string;
      description?: string;
      requestId: string;
      suggestions?: unknown[];
    }
  ): Promise<PermissionResult | null> => {
    const requestId = opts.requestId;
    this.pending = {
      requestId,
      toolName,
      title: opts.title ?? `Claude wants to use ${toolName}`,
      displayName: opts.displayName,
      description: opts.description,
      input,
    };
    if (opts.suggestions) this.pendingSuggestions.set(requestId, opts.suggestions);
    this.activity = `waiting: ${opts.displayName ?? toolName}`;
    this.setStatus("waiting-permission");
    this.emit("needs-permission", this.snapshot());
    this.emitUpdate();
    return new Promise<PermissionResult>((resolve) => {
      this.permissionResolvers.set(requestId, resolve);
    });
  };

  /** Async generator feeding queued user messages into the SDK. Blocks (awaits)
   *  when the inbox is empty so the session stays open between turns. */
  private async *promptStream(): AsyncGenerator<SDKUserMessage> {
    while (!this.closed) {
      while (this.inbox.length > 0) {
        yield this.inbox.shift()!;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.inboxNotify = resolve;
      });
      this.inboxNotify = undefined;
    }
  }

  /** Push a raw text turn into the prompt stream WITHOUT a user transcript item
   *  (for command-style prompts like /compact). Mirrors send()'s inbox wiring. */
  private enqueueText(text: string): void {
    const msg: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: this.sessionId ?? "",
    } as unknown as SDKUserMessage;
    this.inbox.push(msg);
    if (!this.q && !this.starting) {
      void this.startQuery();
    } else {
      this.inboxNotify?.();
    }
  }

  private async startQuery(): Promise<void> {
    this.starting = true;
    try {
      const { query } = await loadSdk();
      const c = this.config;
      const projectMcp = this.projectMcpServers();
      const options: Options = {
        cwd: this.cwd,
        env: this.env,
        ...(projectMcp ? { mcpServers: projectMcp as Options["mcpServers"] } : {}),
        includePartialMessages: true,
        enableFileCheckpointing: true, // enables rewindFiles()
        forwardSubagentText: true, // forward subagent text/thinking for nested transcripts
        canUseTool: this.canUseTool as unknown as Options["canUseTool"],
        ...(c.model ? { model: c.model } : {}),
        ...(c.effort ? { effort: c.effort as any } : {}),
        ...(c.thinking === "off" ? { thinking: { type: "disabled" } as any } : {}),
        ...(c.permissionMode
          ? { permissionMode: c.permissionMode as any }
          : {}),
        ...(this.sessionId ? { resume: this.sessionId } : {}),
        ...(this.resumeAt ? { resumeSessionAt: this.resumeAt } : {}),
        ...(this.pathToClaude
          ? { pathToClaudeCodeExecutable: this.pathToClaude }
          : {}),
      };
      this.resumeAt = undefined; // one-shot: only the restart right after rewind uses it
      if (this.closed) return;
      this.q = query({ prompt: this.promptStream(), options });
      void this.consume(this.q);
    } catch (err) {
      this.transcript.push({
        kind: "error",
        text: `Failed to start Claude: ${
          err instanceof Error ? err.message : String(err)
        }`,
        ts: Date.now(),
      });
      this.setStatus("error");
      this.emitUpdate();
    } finally {
      this.starting = false;
    }
  }

  private async consume(q: Query): Promise<void> {
    try {
      for await (const msg of q) {
        this.handleMessage(msg);
      }
      // Generator completed: no more turns queued.
      if (this.status === "running") this.setStatus("idle");
      this.emitUpdate();
    } catch (err) {
      this.transcript.push({
        kind: "error",
        text: err instanceof Error ? err.message : String(err),
        ts: Date.now(),
      });
      this.setStatus("error");
      this.emitUpdate();
    }
  }

  private handleMessage(msg: SDKMessage): void {
    switch (msg.type) {
      case "system": {
        const subtype = (msg as any).subtype;
        if (subtype === "init") {
          this.sessionId = (msg as any).session_id;
          if (!this.model) this.model = (msg as any).model;
          // MCP servers + their connection status (connected / failed / needs-auth / pending).
          const mcp = (msg as any).mcp_servers;
          if (Array.isArray(mcp)) {
            this.mcpServers = mcp.map((s: any) => ({
              name: String(s?.name ?? "?"),
              status: String(s?.status ?? "pending"),
            }));
          }
          // supportedCommands() is only valid in streaming mode AFTER init.
          void this.fetchCommands();
          // Fetch plan usage (session/week windows) shortly after init, then
          // refresh periodically so the meters stay current.
          this.scheduleUsage();
        } else if (subtype === "commands_changed") {
          const cmds = (msg as any).commands;
          if (Array.isArray(cmds)) {
            this.availableCommands = cmds.map(toAvailableCommand);
            this.emitUpdate();
          }
        } else if (subtype === "compact_boundary") {
          const meta: any = (msg as any).compact_metadata ?? {};
          const trigger: "manual" | "auto" = meta.trigger === "auto" ? "auto" : "manual";
          const preTokens =
            typeof meta.pre_tokens === "number" ? meta.pre_tokens : this.contextTokens ?? 0;
          const postTokens =
            typeof meta.post_tokens === "number" ? meta.post_tokens : undefined;
          this.transcript.push({ kind: "compact", ts: Date.now(), trigger, preTokens, postTokens });
          this.contextTokens = postTokens;
          this.activity = undefined;
        }
        break;
      }
      case "assistant": {
        const subMeta = (msg as any).parent_tool_use_id
          ? {
              parentToolUseId: (msg as any).parent_tool_use_id as string,
              subagent: (msg as any).subagent_type as string | undefined,
            }
          : undefined;
        const content = (msg as any).message?.content;
        const text = extractText(content);
        if (text) {
          this.transcript.push({ kind: "assistant", text, ts: Date.now(), ...subMeta });
        }
        for (const block of Array.isArray(content) ? content : []) {
          if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
            this.transcript.push({ kind: "thinking", text: block.thinking, ts: Date.now(), ...subMeta });
            continue;
          }
          if (block?.type !== "tool_use") continue;
          const name = block.name as string;
          const input = block.input;
          const toolUseId = block.id as string | undefined;

          if (name === "TodoWrite") {
            const todos = parseTodos(input);
            const idx = this.todoBlockId
              ? this.transcript.findIndex(
                  (t) => t.kind === "todos" && t.todoBlockId === this.todoBlockId
                )
              : -1;
            if (idx >= 0) {
              this.transcript[idx] = {
                kind: "todos",
                todos,
                ts: Date.now(),
                todoBlockId: this.todoBlockId!,
              };
            } else {
              this.todoBlockId = nextId("todos");
              this.transcript.push({
                kind: "todos",
                todos,
                ts: Date.now(),
                todoBlockId: this.todoBlockId,
              });
            }
            this.activity = describeTool(name, input);
            continue;
          }

          const edit = parseEdit(name, input);
          this.transcript.push({
            kind: "tool",
            name,
            input,
            ts: Date.now(),
            toolUseId,
            ...(edit ? { edit } : {}),
            ...subMeta,
          });
          this.activity = describeTool(name, input);
        }
        this.streamingText = "";
        this.streamingThinking = "";
        break;
      }
      case "stream_event":
      case "partial_assistant": {
        // Keep subagent partials out of the main streaming caret.
        if ((msg as any).parent_tool_use_id) return;
        // Extended reasoning streams first as thinking deltas — surface it live
        // so the user sees Claude is reasoning (not a blank spinner).
        const think = extractPartialThinking(msg);
        if (think) {
          this.streamingThinking += think;
          this.activity = "sta ragionando…";
          this.emitUpdate();
          return;
        }
        // Then the answer streams as text deltas — live "typing" effect.
        const delta = extractPartialText(msg);
        if (delta) {
          this.streamingText += delta;
          this.activity = "sta scrivendo…";
          this.emitUpdate();
        }
        return; // avoid double emit below
      }
      case "result": {
        const sub = (msg as any).subtype;
        this.activity = undefined;
        // Accumulate token/cost usage reported at the end of each turn.
        const u = (msg as any).usage;
        if (u) {
          this.usage = {
            inputTokens:
              this.usage.inputTokens +
              (u.input_tokens ?? 0) +
              (u.cache_read_input_tokens ?? 0) +
              (u.cache_creation_input_tokens ?? 0),
            outputTokens: this.usage.outputTokens + (u.output_tokens ?? 0),
            costUsd: this.usage.costUsd + ((msg as any).total_cost_usd ?? 0),
            turns: this.usage.turns + 1,
          };
        }
        // Context-window meter: size of the LATEST turn only (overwrite).
        const cu: any = (msg as any).usage ?? {};
        this.contextTokens =
          (cu.input_tokens ?? 0) +
          (cu.cache_read_input_tokens ?? 0) +
          (cu.cache_creation_input_tokens ?? 0);
        const cw = this.contextWindowFromResult(msg);
        if (cw > 0) this.contextWindow = cw;
        if (sub && sub !== "success") {
          this.transcript.push({
            kind: "error",
            text: `Turn ended: ${sub}`,
            ts: Date.now(),
          });
          this.setStatus("error");
        } else {
          this.setStatus("idle");
        }
        this.streamingText = "";
        this.streamingThinking = "";
        // Notify listeners a turn just completed (for sounds/toasts).
        this.emit("turn-done", this.snapshot());
        break;
      }
      case "user": {
        // The SDK echoes tool_result blocks back as a synthetic user message.
        const content = (msg as any).message?.content;
        const subMeta = (msg as any).parent_tool_use_id
          ? {
              parentToolUseId: (msg as any).parent_tool_use_id as string,
              subagent: (msg as any).subagent_type as string | undefined,
            }
          : undefined;
        // Capture the SDK uuid of a real user turn (for file rewind), attaching
        // it to the most recent user transcript item that lacks one.
        const uuid = (msg as any).uuid;
        const hasText =
          typeof content === "string" ||
          (Array.isArray(content) && content.some((b: any) => b?.type === "text"));
        if (uuid && hasText) {
          for (let i = this.transcript.length - 1; i >= 0; i--) {
            const t = this.transcript[i];
            if (t.kind === "user" && !t.uuid) {
              t.uuid = uuid;
              break;
            }
          }
        }
        for (const block of Array.isArray(content) ? content : []) {
          if (block?.type !== "tool_result") continue;
          const full = summarizeResult(block.content);
          this.transcript.push({
            kind: "tool-result",
            name: nameForToolUse(this.transcript, block.tool_use_id),
            ok: block.is_error !== true,
            summary: full.length > 200 ? full.slice(0, 200) + "…" : full,
            full: full.length > 200 ? full : undefined,
            ts: Date.now(),
            toolUseId: block.tool_use_id,
            ...subMeta,
          });
        }
        break;
      }
      default:
        // Many message types (status, tool progress, hooks…) — ignored for now.
        return;
    }
    this.emitUpdate();
  }

  private usageTimer?: ReturnType<typeof setInterval>;
  private usageStarted = false;

  /** Fetch plan usage now, then refresh every 60s while the query is alive. */
  private scheduleUsage(): void {
    if (this.usageStarted) return;
    this.usageStarted = true;
    setTimeout(() => void this.refreshUsage(), 800);
    this.usageTimer = setInterval(() => void this.refreshUsage(), 60000);
  }

  /** Force a usage fetch on demand (from the footer's refresh button). Starts
   *  the query first if needed, then fetches once it has initialized. */
  requestUsage(): void {
    if (!this.q && !this.starting) {
      this.ensureStarted();
      setTimeout(() => void this.refreshUsage(), 1500);
    } else {
      void this.refreshUsage();
    }
  }

  /** Fetch subscription usage (session/week/model windows) like Claude Code's
   *  /usage. Uses the experimental control method; guarded so failures are silent. */
  private async refreshUsage(): Promise<void> {
    const q = this.q as any;
    const fn = q?.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
    if (!q || typeof fn !== "function") return;
    try {
      const u = await fn.call(q);
      if (this.closed || this.q !== q) return;
      const rl = u?.rate_limits;
      if (!u?.rate_limits_available || !rl) {
        this.limits = { available: false, windows: [], subscriptionType: u?.subscription_type };
        this.emitUpdate();
        return;
      }
      const iso = (s: any) => (s ? Date.parse(s) || null : null);
      const windows: {
        label: string;
        utilization: number;
        resetsAtMs: number | null;
        severity?: string;
      }[] = [];
      if (rl.five_hour)
        windows.push({
          label: "Sessione (5h)",
          utilization: Math.round(rl.five_hour.utilization ?? 0),
          resetsAtMs: iso(rl.five_hour.resets_at),
        });
      if (rl.seven_day)
        windows.push({
          label: "Settimana (7g)",
          utilization: Math.round(rl.seven_day.utilization ?? 0),
          resetsAtMs: iso(rl.seven_day.resets_at),
        });
      if (Array.isArray(rl.model_scoped)) {
        for (const m of rl.model_scoped) {
          windows.push({
            label: `Settimana ${m.display_name}`,
            utilization: Math.round(m.utilization ?? 0),
            resetsAtMs: iso(m.resets_at),
          });
        }
      }
      this.limits = {
        available: true,
        subscriptionType: u.subscription_type,
        windows,
      };
      this.emitUpdate();
    } catch {
      /* usage endpoint unavailable — leave prior limits */
    }
  }

  /** Fetch the SDK's slash-command list once after init. Streaming-mode only;
   *  swallow errors so a query that doesn't support it never breaks the chat. */
  private async fetchCommands(): Promise<void> {
    const q = this.q;
    if (!q || typeof (q as any).supportedCommands !== "function") return;
    try {
      const cmds = await q.supportedCommands();
      if (this.closed || this.q !== q) return;
      if (Array.isArray(cmds) && cmds.length > 0) {
        this.availableCommands = cmds.map(toAvailableCommand);
        this.emitUpdate();
      }
    } catch {
      /* supportedCommands unsupported/not-ready — leave the list empty */
    }
  }

  private setStatus(s: ChatStatus): void {
    this.status = s;
  }

  private emitUpdate(): void {
    this.emit("update", this.snapshot());
  }
}

/** Turn a tool_use into a short human phrase for the activity line. */
function describeTool(name: string, input: any): string {
  const short = (s: unknown, n = 40) => {
    const str = String(s ?? "");
    return str.length > n ? str.slice(0, n) + "…" : str;
  };
  const base = (p?: string) => (p ? p.split("/").pop() || p : "");
  switch (name) {
    case "TodoWrite":
      return `updating todos`;
    case "Read":
      return `reading ${base(input?.file_path)}`;
    case "Edit":
    case "Write":
    case "MultiEdit":
      return `editing ${base(input?.file_path)}`;
    case "Bash":
      return `running: ${short(input?.command)}`;
    case "Grep":
      return `searching ${short(input?.pattern, 24)}`;
    case "Glob":
      return `globbing ${short(input?.pattern, 24)}`;
    case "WebFetch":
      return `fetching ${base(input?.url)}`;
    case "WebSearch":
      return `searching web`;
    case "Task":
      return `running subagent`;
    default:
      return `using ${name}`;
  }
}

/** Narrow the SDK SlashCommand to our wire-safe AvailableCommand. */
function toAvailableCommand(c: SlashCommand): AvailableCommand {
  return {
    name: c.name,
    description: c.description ?? "",
    argumentHint: c.argumentHint ?? "",
    ...(c.aliases && c.aliases.length ? { aliases: c.aliases } : {}),
  };
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

function extractPartialText(msg: SDKMessage): string {
  // Partial/stream events carry a nested delta; be defensive about the shape.
  const anyMsg = msg as any;
  const ev = anyMsg.event ?? anyMsg;
  if (ev?.delta?.text) return ev.delta.text as string;
  if (ev?.delta?.type === "text_delta" && ev.delta.text) return ev.delta.text;
  const content = anyMsg.message?.content;
  if (typeof content === "string") return content;
  return "";
}

function extractPartialThinking(msg: SDKMessage): string {
  // Extended-reasoning deltas arrive as thinking_delta events during a turn.
  const anyMsg = msg as any;
  const ev = anyMsg.event ?? anyMsg;
  if (ev?.delta?.type === "thinking_delta" && ev.delta.thinking) return ev.delta.thinking as string;
  if (typeof ev?.delta?.thinking === "string") return ev.delta.thinking;
  return "";
}
