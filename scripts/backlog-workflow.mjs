export const meta = {
  name: 'claude-fleet-backlog',
  description: 'Design + implement the full Claude Fleet backlog via parallel design agents then sequential integration',
  phases: [
    { title: 'Recon', detail: 'read current files + SDK facts' },
    { title: 'Design', detail: 'one agent per feature produces a precise implementation spec' },
    { title: 'Integrate', detail: 'apply specs to shared files in isolated worktree' },
    { title: 'Verify', detail: 'typecheck + build + report' },
  ],
}

const ROOT = '/Users/matte/Documents/www/lab/fleetview'

// ---- Phase 1: recon — read the real current state so design is grounded ----
phase('Recon')
const recon = await agent(
  `You are mapping a VS Code extension codebase before a feature sprint. Read these files in ${ROOT} and return a JSON map of their key exports, message-protocol shapes, and where each concern lives:
- shared/protocol.ts (the wire types)
- src/core/ChatSession.ts (SDK query wrapper, state machine, handleMessage, canUseTool, snapshot)
- src/core/SessionManager.ts
- src/extension/extension.ts (commands, activation)
- src/extension/ChatPanel.ts (webview host, onMessage)
- src/extension/SidebarProvider.ts
- webview/src/App.tsx (chat UI), webview/src/Sidebar.tsx, webview/src/Markdown.tsx, webview/src/styles.css
Also note: the extension uses @anthropic-ai/claude-agent-sdk@0.3.200. Query (streaming mode) exposes interrupt(), setModel(), setPermissionMode(), supportedCommands(): Promise<SlashCommand[]>. SlashCommand = {name, description, argumentHint, aliases?}. Slash commands run by sending the text "/name args" as a normal user message. Plan mode = options.permissionMode:'plan' (no special API); ExitPlanMode is a tool the model calls. SDKResultSuccess has usage + total_cost_usd. Assistant tool_use blocks include TodoWrite (input.todos: [{content,status,activeForm}]) and Edit (input.file_path, old_string, new_string) / Write (file_path, content).
Return concise structured notes, not full file dumps.`,
  { label: 'recon', schema: {
    type: 'object',
    additionalProperties: true,
    properties: {
      protocol: { type: 'string' },
      chatSession: { type: 'string' },
      chatPanel: { type: 'string' },
      extension: { type: 'string' },
      sidebar: { type: 'string' },
      appTsx: { type: 'string' },
      notes: { type: 'string' },
    },
    required: ['notes'],
  } }
)

const reconText = JSON.stringify(recon, null, 2)

// ---- Phase 2: design — one agent per feature, in parallel (no file writes) ----
phase('Design')

const SPEC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    feature: { type: 'string' },
    protocolChanges: { type: 'string', description: 'exact additions to shared/protocol.ts' },
    coreChanges: { type: 'string', description: 'exact changes to ChatSession/SessionManager, with code' },
    extensionChanges: { type: 'string', description: 'exact changes to extension.ts / ChatPanel / SidebarProvider / package.json, with code' },
    webviewChanges: { type: 'string', description: 'exact changes to App.tsx / Sidebar.tsx / new components, with code' },
    cssChanges: { type: 'string', description: 'CSS to append to styles.css' },
    newFiles: { type: 'string', description: 'any new files with full contents' },
    sdkCaveats: { type: 'string', description: 'anything not fully supported by the SDK and the fallback taken' },
    risks: { type: 'string' },
  },
  required: ['feature', 'protocolChanges', 'coreChanges', 'extensionChanges', 'webviewChanges', 'cssChanges', 'newFiles', 'sdkCaveats'],
}

const FEATURES = [
  {
    key: 'rich-rendering',
    prompt: `Design RICH LIVE RENDERING for the chat transcript so it matches Claude Code's native UI. Specifically:
1) TodoWrite tool_use → render the todo list as a live checklist (☐/◐/☑ by status pending/in_progress/completed), updating in place as new TodoWrite calls arrive (dedupe: the latest TodoWrite replaces the prior list).
2) Edit/Write/MultiEdit tool_use → render a DIFF view: filename header + old_string in red lines, new_string in green lines (simple line-based diff, monospace). Write shows the new content as added lines.
3) Other tools keep the compact ⏺ marker row but render input more readably.
4) Tool results (⎿) show a collapsible/truncated preview.
The transcript items come from ChatSession.handleMessage parsing assistant.message.content blocks. Propose: (a) protocol TranscriptItem additions (e.g. a 'todos' kind and a richer 'tool' with structured fields), (b) ChatSession.handleMessage changes to emit them, (c) App.tsx React components + Markdown reuse, (d) CSS. Keep it CSP-safe (no external libs; render React elements, not innerHTML).`,
  },
  {
    key: 'dashboard',
    prompt: `Design a DASHBOARD GRID view: a webview showing ALL chats at once as cards (title, folder, live status dot, current activity, token usage, last-activity). Cards are clickable to open the chat; a running chat pulses; a chat needing permission is highlighted. It should live as a separate command "claudeFleet.openDashboard" opening a WebviewPanel, reusing the existing webview bundle with a data-view="dashboard" root (main.tsx already switches on data-view for 'sidebar'/panel). Propose: the SidebarTree-like data feed (reuse SessionManager snapshots), a new Dashboard.tsx React component, protocol messages (host->dashboard 'chats' with an array incl. usage; dashboard->host 'open'), the ChatPanel/provider or a new DashboardPanel.ts to host it, the command + menu registration, and CSS. Must auto-refresh on chat-update.`,
  },
  {
    key: 'cwd-per-chat',
    prompt: `Design CHOOSE WORKING DIRECTORY PER CHAT. When creating a new chat, let the user pick the cwd (default: workspace folders via a QuickPick that also offers "Browse…" using vscode.window.showOpenDialog, plus recent cwds). Persist cwd in ChatMeta (already exists). Also allow changing a chat's cwd? (no — cwd is fixed once the SDK session starts; only settable at creation). Propose exact changes to extension.ts newChat command. Keep it minimal. Also: the import flow already sets cwd from the session file — leave that. protocol/core/webview/css changes likely empty.`,
  },
  {
    key: 'slash-commands',
    prompt: `Design SLASH COMMANDS in the composer. The SDK Query has supportedCommands(): Promise<SlashCommand[]> (SlashCommand={name,description,argumentHint,aliases?}); commands run by sending "/name args" as a normal user message. Design: (a) ChatSession fetches supportedCommands() after init and exposes them in the snapshot (new field availableCommands: {name,description,argumentHint}[]); (b) App.tsx composer shows an autocomplete popup when the input starts with "/", filtering commands, arrow-key + enter to complete; (c) sending still uses the existing 'send' message (the text starts with /). Propose protocol additions (availableCommands on ChatSnapshot), ChatSession changes (call this.q.supportedCommands() once, guard errors), App.tsx composer UI + CSS. sdkCaveats: note supportedCommands only valid in streaming mode after init.`,
  },
  {
    key: 'plan-mode',
    prompt: `Design PLAN MODE + plan approval. Plan mode = options.permissionMode:'plan' (already supported via config). The model, in plan mode, calls the ExitPlanMode tool with input {plan: string} when done planning — this arrives as a tool_use permission request via canUseTool (toolName 'ExitPlanMode'). Design: (a) a toolbar toggle / command to set a chat into plan mode (calls session.setConfig({permissionMode:'plan'}) live) and out of it; (b) special-case the ExitPlanMode permission in App.tsx: render the plan (markdown) in a prominent card with "Approve & run" (allow, then switch permissionMode back to default) and "Keep planning" (deny); (c) show a "PLAN MODE" badge in the header when active. Propose protocol/core/extension/webview/css changes. Reuse the existing permission plumbing; ExitPlanMode is just a specially-rendered permission.`,
  },
  {
    key: 'attention-badge',
    prompt: `Design an ATTENTION BADGE on the activity-bar icon. Use vscode window/view badge APIs: the WebviewView (SidebarProvider) can set view.badge = {value, tooltip} (vscode.ViewBadge). Set the badge to the count of chats that are 'waiting-permission' OR that finished ('turn-done') while their panel wasn't focused (unseen). Clear a chat's "unseen" flag when its panel is opened/focused. Propose: SidebarProvider.updateBadge() driven by SessionManager events, an "unseen done" set tracked in extension.ts or SessionManager, and clearing on openChat. Minimal protocol/webview changes.`,
  },
  {
    key: 'mention-files',
    prompt: `Design @-MENTION FILES / drag files into the composer. (a) Typing "@" in the composer opens a file picker autocomplete (fuzzy over workspace files — the webview can't read the fs, so App.tsx posts a 'searchFiles' query to the host, which uses vscode.workspace.findFiles and returns matches; selecting inserts the path as "@path"). (b) Dragging a file from the VS Code explorer onto the composer inserts its path (handle drop event; VS Code provides text/uri-list). The mention text is just included in the message the user sends (Claude Code resolves @paths). Propose protocol messages (webview->host 'searchFiles' {query}; host->webview 'fileResults' {paths}), ChatPanel handling with findFiles, App.tsx composer autocomplete + drop handler, CSS. Keep it simple; the @path is sent as plain text in the prompt.`,
  },
]

const specs = await parallel(
  FEATURES.map((f) => () =>
    agent(
      `You are designing ONE feature for the "Claude Fleet" VS Code extension (multi-session Claude Code manager built on @anthropic-ai/claude-agent-sdk@0.3.200). Here is the current codebase map:\n\n${reconText}\n\nProduce a PRECISE, implementation-ready spec (with real code snippets) for this feature. Do NOT write files — return the spec. Be concrete about exact edits to shared files (protocol.ts, ChatSession.ts, extension.ts, ChatPanel.ts, App.tsx, styles.css) so a single integrator can apply several specs without conflicts. Prefer additive changes. Feature:\n\n${f.prompt}`,
      { label: `design:${f.key}`, phase: 'Design', schema: SPEC_SCHEMA }
    )
  )
)

const goodSpecs = specs.filter(Boolean)
log(`Designed ${goodSpecs.length}/${FEATURES.length} feature specs.`)

// ---- Phase 3: a reviewer consolidates specs to flag cross-feature conflicts ----
phase('Integrate')
const consolidation = await agent(
  `You are the integration lead. Below are ${goodSpecs.length} feature specs for the Claude Fleet extension. Produce a single CONSOLIDATED integration plan that merges all changes to each shared file WITHOUT conflicts, in the correct order, calling out any collisions (e.g. two features adding to the same TranscriptItem union or the composer) and how to reconcile them. Output per-file change lists (protocol.ts, ChatSession.ts, SessionManager.ts, extension.ts, ChatPanel.ts, SidebarProvider.ts, package.json, App.tsx, Sidebar.tsx, new files, styles.css). Keep the actual code from the specs; your job is to order and de-conflict.\n\nSPECS:\n${JSON.stringify(goodSpecs, null, 2)}`,
  { label: 'consolidate', phase: 'Integrate', schema: {
    type: 'object',
    additionalProperties: true,
    properties: {
      perFilePlan: { type: 'string' },
      conflicts: { type: 'string' },
      newFiles: { type: 'string' },
      buildNotes: { type: 'string' },
    },
    required: ['perFilePlan'],
  } }
)

return {
  featureSpecs: goodSpecs,
  consolidation,
  note: 'Specs + consolidated plan ready. The main session applies these to shared files, then builds & reinstalls.',
}
