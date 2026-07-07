// Shared message protocol between the extension host and the webviews
// (chat panel + sidebar + dashboard). Both sides import these types so the wire
// contract stays in sync.

export type ChatStatus =
  | "idle" // no query running, waiting for user input
  | "running" // a query is in flight
  | "waiting-permission" // a tool wants permission; UI must decide
  | "error"; // last turn ended with an error

/** One entry in a TodoWrite checklist. */
export interface TodoEntry {
  content: string;
  status: "pending" | "in_progress" | "completed";
  /** SDK sometimes sends an imperative form shown while running. */
  activeForm?: string;
}

/**
 * A parsed Edit/Write/MultiEdit operation, ready to render as a line diff.
 * One `hunk` per edit (MultiEdit yields several).
 */
export interface FileEditOp {
  filePath: string;
  /** "edit" = old→new replace; "write" = whole-file create (all added). */
  mode: "edit" | "write";
  hunks: Array<{ oldLines: string[]; newLines: string[] }>;
}

/** A single rendered turn/block in the transcript shown by the webview. */
export type TranscriptItem =
  | { kind: "user"; text: string; ts: number; uuid?: string; images?: number }
  | {
      kind: "assistant";
      text: string;
      ts: number;
      /** Set when produced by a subagent (Task tool). Maps SDK parent_tool_use_id. */
      parentToolUseId?: string;
      /** Subagent type (SDKAssistantMessage.subagent_type). */
      subagent?: string;
    }
  | {
      kind: "thinking";
      text: string;
      ts: number;
      parentToolUseId?: string;
      subagent?: string;
    }
  | {
      kind: "tool";
      name: string;
      input: unknown;
      ts: number;
      /** Stable id from the SDK tool_use block; links to its tool-result. */
      toolUseId?: string;
      /** Present for Edit/Write/MultiEdit so the UI renders a diff. */
      edit?: FileEditOp;
      parentToolUseId?: string;
      subagent?: string;
    }
  | {
      kind: "tool-result";
      name: string;
      ok: boolean;
      summary: string;
      ts: number;
      /** Links this result to its tool_use block (runtime path only). */
      toolUseId?: string;
      /** Full (un-truncated) text for the collapsible preview. */
      full?: string;
      parentToolUseId?: string;
      subagent?: string;
    }
  | { kind: "system"; text: string; ts: number }
  | { kind: "error"; text: string; ts: number }
  | {
      kind: "todos";
      todos: TodoEntry[];
      ts: number;
      /** Stable id so successive TodoWrite calls replace the same block. */
      todoBlockId: string;
    }
  | {
      kind: "compact";
      ts: number;
      trigger: "manual" | "auto";
      preTokens: number;
      postTokens?: number;
    };

/** A pending permission request surfaced to the user. */
export interface PendingPermission {
  requestId: string;
  toolName: string;
  title: string; // human sentence, e.g. "Claude wants to read foo.txt"
  displayName?: string; // short label, e.g. "Read file"
  description?: string; // subtitle
  input: Record<string, unknown>;
}

/** One workspace file returned for an @-mention autocomplete. */
export interface FileMatch {
  /** Workspace-relative path, forward-slashed. Inserted as "@<path>". */
  path: string;
  /** Basename for the primary label (e.g. "protocol.ts"). */
  name: string;
}

/** Reasoning effort levels supported by the SDK. */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";
// The four modes the Agent SDK actually accepts (setPermissionMode / options).
export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "bypassPermissions";

/** One MCP server's connection status, as reported by the SDK init message. */
export type McpConnStatus =
  | "connected"
  | "pending"
  | "needs-auth"
  | "failed"
  | string;
export interface McpServerInfo {
  name: string;
  status: McpConnStatus;
}

/** Per-chat, user-tunable configuration. */
export interface ChatConfig {
  model?: string; // "" / undefined = SDK default
  effort?: EffortLevel;
  permissionMode?: PermissionMode;
  thinking?: "on" | "off"; // undefined = on (SDK default)
}

/** Cumulative usage for a chat (summed across turns). */
export interface UsageStats {
  inputTokens: number;
  outputTokens: number;
  costUsd: number; // 0 when the plan doesn't report cost (subscription)
  turns: number;
}

/** One rate-limit window (subscription plan). utilization is % used, 0–100. */
export interface RateWindow {
  label: string; // "Session (5hr)", "Weekly (7 day)", "Weekly Fable", …
  utilization: number; // 0–100
  resetsAtMs: number | null; // epoch ms
  severity?: "normal" | "warning" | "reached" | string;
}

/** Subscription plan usage, fetched from the SDK usage endpoint (like `/usage`). */
export interface RateLimits {
  available: boolean;
  subscriptionType?: string | null;
  windows: RateWindow[]; // ordered: session, weekly, then per-model
}

/** One slash command advertised by the SDK for this session's cwd/config. */
export interface AvailableCommand {
  name: string; // without leading slash, e.g. "review"
  description: string;
  argumentHint: string; // e.g. "<file>" or "" when the command takes no args
  aliases?: string[];
}

/** An image attached to an outgoing user message. */
export interface OutgoingImage {
  mediaType: string; // e.g. "image/png"
  dataBase64: string; // raw base64 (no data: prefix)
}

/** A quick-action button in the chat toolbar. Sends `prompt` to the chat,
 *  which runs it in the chat's repo cwd. Delivered via HostToWebview "quickActions". */
export interface QuickAction {
  label: string; // button text (also the merge key)
  prompt: string; // prompt sent to the chat when the button is clicked
  title?: string; // optional tooltip
  /** Shown in the always-visible row. Others live behind "Mostra altro".
   *  User-defined actions (claudeFleet.quickActions) are treated as primary. */
  primary?: boolean;
}

/** Local slash commands handled by Claude Fleet itself (not sent as text). */
export type LocalSlashCommand = "clear" | "compact";

/** Snapshot of one chat, enough for the sidebar and the chat view. */
export interface ChatSnapshot {
  id: string; // our stable id (not the SDK session id)
  title: string;
  status: ChatStatus;
  sessionId?: string; // SDK session id once known (for resume)
  cwd: string;
  model?: string;
  transcript: TranscriptItem[];
  pendingPermission?: PendingPermission;
  streamingText?: string; // partial assistant text mid-turn
  streamingThinking?: string; // partial extended-reasoning text mid-turn (before/with the answer)
  /** Short human phrase describing what the chat is doing right now. */
  activity?: string;
  config: ChatConfig;
  usage: UsageStats;
  /** Slash commands available for this chat (from SDK supportedCommands()).
   *  Empty until the query has started and init has completed. */
  availableCommands: AvailableCommand[];
  /** Subscription rate limits (session / week), if reported by the plan. */
  limits?: RateLimits;
  /** Number of user messages queued but not yet processed (sent while busy). */
  queued: number;
  /** True when file checkpointing is on, so rewind is offered. */
  canRewind: boolean;
  /** Approx. context tokens used in the latest turn (input + cache). */
  contextTokens?: number;
  /** The model's context window (e.g. 200000, 1000000). */
  contextWindow?: number;
  /** MCP servers configured for this chat + their connection status (from init). */
  mcpServers?: McpServerInfo[];
}

// ===== Chat panel protocol =====

// ---- panel -> extension ----
export type WebviewToHost =
  | { type: "ready" }
  | { type: "send"; chatId: string; text: string; images?: OutgoingImage[] }
  | { type: "interrupt"; chatId: string }
  | { type: "rewind"; chatId: string; userMessageId: string }
  | { type: "setConfig"; chatId: string; config: ChatConfig }
  | { type: "setPermissionMode"; chatId: string; mode: PermissionMode }
  | { type: "openSettings" }
  | { type: "manageMcp" }
  | { type: "refreshUsage"; chatId: string }
  | { type: "openFile"; chatId: string; path: string }
  | { type: "openDiff"; chatId: string; path: string }
  | { type: "searchFiles"; query: string; requestId: number }
  | { type: "openExternal"; url: string }
  | { type: "clientError"; message: string } // webview-side uncaught error, for diagnostics
  | { type: "slash"; chatId: string; command: LocalSlashCommand; args?: string }
  | {
      type: "permission";
      chatId: string;
      requestId: string;
      decision: "allow" | "deny";
      remember?: boolean;
      /** Set by the ExitPlanMode card's "Approve & run": after the allow
       *  resolves, the host flips this chat's permissionMode back to "default". */
      exitPlan?: boolean;
    };

// ---- extension -> panel ----
export type HostToWebview =
  | { type: "open"; chat: ChatSnapshot } // load a chat into the view
  | { type: "patch"; chat: ChatSnapshot } // full snapshot refresh (simple + robust)
  | { type: "sound"; play: SoundPlay } // play a notification sound
  | { type: "fileResults"; requestId: number; matches: FileMatch[] } // @-mention search results
  | { type: "quickActions"; actions: QuickAction[] }; // built-in defaults merged with claudeFleet.quickActions

// ===== Sidebar protocol =====

export interface SidebarFolder {
  id: string;
  title: string;
  parentId: string | null;
}
export interface SidebarChat {
  id: string;
  title: string;
  parentId: string | null;
  status: ChatStatus;
  activity?: string;
  archived: boolean;
  // Enriched info for a richer sidebar row:
  model?: string;
  cwd?: string;
  inputTokens?: number;
  outputTokens?: number;
  turns?: number;
  costUsd?: number;
  lastActivityTs?: number;
  needsPermission?: boolean;
}
export interface SidebarTree {
  folders: SidebarFolder[];
  chats: SidebarChat[];
  showArchived: boolean;
  activeChatId?: string;
}

// ---- sidebar -> extension ----
export type SidebarToHost =
  | { type: "ready" }
  | { type: "open"; chatId: string }
  | { type: "newChat" }
  | { type: "newFolder" }
  | { type: "import" }
  | { type: "toggleArchived" }
  | { type: "rename"; id: string }
  | { type: "archive"; id: string }
  | { type: "unarchive"; id: string }
  | { type: "delete"; id: string }
  | { type: "deleteDisk"; id: string }
  | { type: "stop"; id: string }
  | { type: "move"; id: string; folderId: string | null }
  // ---- bulk (multi-select) operations; each carries the selected chat/folder ids ----
  | { type: "bulkDelete"; ids: string[] }
  | { type: "bulkArchive"; ids: string[] }
  | { type: "bulkUnarchive"; ids: string[] }
  | { type: "bulkMove"; ids: string[] } // host prompts for the target folder
  | { type: "bulkRename"; ids: string[] }; // host prompts for prefix / find-replace

// ---- extension -> sidebar ----
export type HostToSidebar = { type: "tree"; tree: SidebarTree };

// ===== Sounds =====

export type SoundKind = "permission" | "done";
export type SoundPreset =
  | "ping"
  | "chime"
  | "blip"
  | "marimba"
  | "knock"
  | "custom"
  | "none";

/** Everything the webview needs to render one notification sound. */
export interface SoundPlay {
  event: SoundKind;
  preset: SoundPreset;
  volume: number; // 0–1
  dataUri?: string; // data: URI of a custom audio file, when preset === "custom"
}

// ===== Dashboard protocol =====

/** One card in the dashboard grid — a flattened, render-ready view of a chat. */
export interface DashboardCard {
  id: string; // stable chat id (same id openChat expects)
  title: string;
  folderPath?: string; // breadcrumb e.g. "Work / Backend"; undefined = root
  status: ChatStatus;
  activity?: string;
  model?: string;
  cwd: string;
  archived: boolean;
  usage: UsageStats;
  needsPermission: boolean;
  lastActivityTs?: number;
}

export interface DashboardData {
  cards: DashboardCard[];
  showArchived: boolean;
  activeChatId?: string;
}

// ---- dashboard -> extension ----
export type DashboardToHost =
  | { type: "ready" }
  | { type: "open"; chatId: string }
  | { type: "newChat" }
  | { type: "toggleArchived" }
  | { type: "stop"; id: string };

// ---- extension -> dashboard ----
export type HostToDashboard = { type: "dashboard"; data: DashboardData };

/** Built-in quick actions. Used by the webview as the fallback list, and by the
 *  host (ChatPanel) as the base it merges claudeFleet.quickActions onto before
 *  sending the "quickActions" message. */
export const DEFAULT_QUICK_ACTIONS: QuickAction[] = [
  // --- Primary: always visible (frequent, low-risk, self-explanatory) ---
  { label: "Commit + Push", primary: true, title: "Committa le modifiche e fa push sul branch corrente (crea un branch se sei su main)",
    prompt: "Fai il commit delle modifiche correnti con un buon messaggio (Conventional Commits) e poi esegui il push sul branch corrente. Se il branch è main/master, crea prima un branch di feature." },
  { label: "Apri PR", primary: true, title: "Apre una Pull Request con gh (titolo e descrizione dai commit del branch)",
    prompt: "Apri una Pull Request con `gh pr create`: genera titolo e descrizione a partire dai commit e dal diff del branch corrente rispetto al branch base. Riportami l'URL della PR." },
  { label: "Rivedi diff", primary: true, title: "Rivede le modifiche non committate (git diff) e segnala bug/rischi/migliorie",
    prompt: "Rivedi le mie modifiche correnti (`git diff`): segnala bug, rischi, e migliorie concrete. Sii sintetico e ordina per gravità." },
  { label: "Esegui test", primary: true, title: "Rileva il runner (npm/pnpm/pytest/uv…) ed esegue i test, poi propone i fix se falliscono",
    prompt: "Esegui i test del progetto (rileva il runner: npm/pnpm/pytest/uv, ecc.) e riportami i risultati. Se qualcosa fallisce, proponi i fix." },
  { label: "Aggiorna Linear", primary: true, title: "Aggiorna l'issue Linear collegata (stato + commento) via MCP; chiede l'ID se ambiguo",
    prompt: "Aggiorna l'issue Linear collegata a questo lavoro usando gli strumenti Linear (MCP): imposta lo stato appropriato e aggiungi un commento che riassume cosa è stato fatto. Se non è chiaro quale issue, chiedimi l'ID." },
  { label: "Riassumi chat", primary: true, title: "Riassume QUESTA conversazione: cosa fatto, decisioni, prossimi passi",
    prompt: "Riassumi questa conversazione in punti chiave: cosa è stato fatto, decisioni prese, e prossimi passi." },

  // --- Secondary: behind "Mostra altro" (meno frequenti, più pesanti o rischiose) ---
  { label: "Commit (no push)", primary: false, title: "Committa in locale senza fare push",
    prompt: "Fai il commit delle modifiche correnti. Mostra prima `git status` e `git diff --stat`, poi committa con un messaggio conciso in stile Conventional Commits. Non fare push." },
  { label: "Cosa è cambiato", primary: false, title: "Mostra git status + git diff --stat e riassume le modifiche in corso",
    prompt: "Mostrami cosa è cambiato nel repo: esegui `git status` e `git diff --stat`, poi riassumi in breve le modifiche in corso." },
  { label: "Scrivi test", primary: false, title: "Scrive i test per il file più rilevante alle modifiche (chiede se ambiguo) e li esegue",
    prompt: "Scrivi i test per il file più rilevante alle modifiche correnti (se non è chiaro quale, chiedimelo), seguendo le convenzioni di test già presenti nel repo, poi eseguili." },
  { label: "Crea branch", primary: false, title: "Crea un nuovo branch git per il lavoro corrente (chiede il nome se ambiguo)",
    prompt: "Crea un nuovo branch git con un nome sensato per il lavoro corrente e spostati su di esso. Se non è chiaro quale nome usare, chiedimelo prima di crearlo." },
  { label: "Aggiorna CLAUDE.md", primary: false, title: "Aggiorna/crea il CLAUDE.md del repo (mostra prima il diff proposto)",
    prompt: "Aggiorna (o crea, se manca) il file CLAUDE.md di questo repo con un riassunto aggiornato di architettura, comandi e convenzioni del progetto. Mostrami prima un diff di cosa cambieresti." },
  { label: "Aggiorna memoria", primary: false, title: "Salva i fatti/decisioni di questa chat nella memoria del progetto (ti mostra cosa aggiunge)",
    prompt: "Aggiorna la memoria persistente del progetto: individua i fatti chiave, le decisioni e lo stato emersi in questa conversazione e salvali nel posto giusto (CLAUDE.md, file in .claude/, o le note di memoria del progetto), così restano disponibili nelle sessioni future. Mostrami cosa hai aggiunto." },
  { label: "Applica Terraform ⚠", primary: false, title: "plan → ti mostra il piano → attende il tuo OK → apply. Operazione distruttiva.",
    prompt: "Applica l'infrastruttura Terraform di questo repo. IMPORTANTE, in ordine: 1) esegui prima il PLAN (usa `terragrunt` se il repo lo usa, altrimenti `terraform`); 2) MOSTRAMI il piano completo; 3) attendi la mia conferma esplicita; 4) SOLO dopo il mio ok esegui l'apply. È un'operazione distruttiva: non applicare mai nulla senza il piano e la mia conferma." },
];
