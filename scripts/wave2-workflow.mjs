export const meta = {
  name: 'claude-fleet-parity',
  description: 'Design remaining Claude-Code-parity features for Claude Fleet, then consolidate for integration',
  phases: [
    { title: 'Recon', detail: 'read current files' },
    { title: 'Design', detail: 'one agent per feature → implementation spec' },
    { title: 'Consolidate', detail: 'de-conflicted per-file plan' },
  ],
}

const ROOT = '/Users/matte/Documents/www/lab/fleetview'

phase('Recon')
const recon = await agent(
  `Map the current state of a VS Code extension "Claude Fleet" (multi-session Claude Code manager on @anthropic-ai/claude-agent-sdk@0.3.200). Read these files under ${ROOT} and summarize their key exports/shapes concisely (NOT full dumps):
- shared/protocol.ts (wire types: TranscriptItem union incl kinds user/assistant/thinking/tool/tool-result/todos/system/error; ChatSnapshot incl usage{inputTokens,outputTokens,costUsd,turns}, config{model,effort,permissionMode,thinking}, limits, availableCommands, queued, canRewind; WebviewToHost / HostToWebview / Sidebar* / Dashboard* unions)
- src/core/ChatSession.ts (query() wrapper: startQuery builds Options {cwd,env,includePartialMessages,enableFileCheckpointing,canUseTool,model,effort,thinking,permissionMode,resume,pathToClaudeCodeExecutable}; handleMessage switch on system(init/commands_changed)/assistant/user/result/stream_event/partial_assistant; snapshot(); send(text,images); setConfig; ensureStarted; scheduleUsage/refreshUsage using q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(); rewindFiles; fetchCommands via q.supportedCommands())
- src/extension/ChatPanel.ts (webview host; onMessage switch: ready/send/interrupt/rewind/permission/setConfig/setPermissionMode/openSettings/manageMcp/refreshUsage/openFile/searchFiles; CSP in html())
- src/extension/extension.ts (commands; activate; newChat with pickCwd; SidebarProvider; DashboardPanel)
- webview/src/App.tsx (chat UI: header with 3 selects+thinking toggle+mcp; QUICK_ACTIONS bar; Composer with slash+mention+images; Row renders TranscriptItem kinds; Markdown component; UsageButton footer; helpers shortModel/fmt/shortPath/diffLines/toolArg)
- webview/src/Markdown.tsx (minimal markdown→React: paragraphs, headings, ul/ol, fenced code, inline code/bold/italic — NO tables/blockquote/nested lists/syntax highlighting)
- webview/src/styles.css (theme-var based)
Also note the SDK Query interface has methods (verify by reading node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts): interrupt, setModel, setPermissionMode, supportedCommands, rewindFiles, usage_EXPERIMENTAL..., and possibly compaction-related methods — LIST any method whose name contains 'compact' or 'clear' or 'context'. Also read SDKResultSuccess.usage fields and any context-window / model info (ModelInfo, contextWindow, max tokens) to compute context usage. And check SDKCompactBoundaryMessage shape and the Options 'forwardSubagentText' and how subagent messages arrive (parent_tool_use_id, subagent_type on SDKAssistantMessage).
Return concise structured notes.`,
  { label: 'recon', schema: {
    type: 'object', additionalProperties: true,
    properties: {
      sdkQueryMethods: { type: 'string' },
      contextUsageFacts: { type: 'string' },
      compactionFacts: { type: 'string' },
      subagentFacts: { type: 'string' },
      fileNotes: { type: 'string' },
    }, required: ['fileNotes'],
  } }
)
const reconText = JSON.stringify(recon, null, 2)

phase('Design')
const SPEC_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    feature: { type: 'string' },
    protocolChanges: { type: 'string' },
    coreChanges: { type: 'string' },
    extensionChanges: { type: 'string' },
    webviewChanges: { type: 'string' },
    cssChanges: { type: 'string' },
    packageJsonChanges: { type: 'string' },
    newFiles: { type: 'string' },
    sdkCaveats: { type: 'string' },
  },
  required: ['feature', 'protocolChanges', 'coreChanges', 'extensionChanges', 'webviewChanges', 'cssChanges', 'newFiles', 'sdkCaveats'],
}

const FEATURES = [
  { key: 'quick-actions-plus', prompt: `Expand QUICK_ACTIONS in App.tsx and make them user-customizable. (A) Add these actions (Italian labels, clear prompts that Claude runs in the chat's repo cwd): "Crea branch" (create a new git branch, ask name if unclear), "Scrivi test" (write tests for the most relevant/changed file), "Aggiorna CLAUDE.md" (update/generate CLAUDE.md summarizing the project), "Cosa è cambiato" (git status + git diff --stat summary), "Continua" (continue the previous task from where it left off), "Applica Terraform" (run terraform/terragrunt: plan first, SHOW the plan, ask explicit confirmation, then apply; use terragrunt if present — DESTRUCTIVE so must plan+confirm), "Aggiorna memoria" (persist the key facts/decisions from this conversation into the project's persistent memory / CLAUDE.md / .claude memory). (B) Make quick actions customizable: add a setting claudeFleet.quickActions (array of {label:string, prompt:string}) in package.json; extension reads it and sends the merged list (defaults + custom) to the webview (e.g. include in ChatSnapshot or a dedicated message); App renders defaults+custom in the bar. Design the plumbing precisely (protocol field, where extension reads config, App render). Keep defaults hardcoded as fallback.` },
  { key: 'syntax-markdown', prompt: `Upgrade webview/src/Markdown.tsx to (1) syntax-highlight fenced code blocks and (2) support tables, blockquotes, nested lists, horizontal rules, and links (rendered as plain non-navigable text or vscode-open). CONSTRAINT: strict webview CSP (no external fetch, no CDN, no eval). So syntax highlighting must be a BUNDLED library or hand-rolled. Recommend the approach: evaluate bundling 'highlight.js' (sync, ~common languages, CSP-safe when bundled into webview.js via vite) vs 'prismjs' vs a minimal tokenizer. Pick one, give the exact npm dependency to add (devDependency/dependency), the import, and how to apply it to code blocks producing React elements (NOT dangerouslySetInnerHTML unless the highlighter output is sanitized — prefer building spans, or use highlight.js highlightAuto returning HTML then set via a sanitized dangerouslySetInnerHTML on a <code> — assess XSS: highlight.js output is safe/escaped). Provide the full new Markdown.tsx and CSS (a theme using vscode token colors or a bundled hljs theme adapted to vscode vars). Note bundle-size impact.` },
  { key: 'context-bar', prompt: `Add a CONTEXT-WINDOW usage indicator (like Claude Code's "context left"). Using the recon facts about SDKResultSuccess.usage (input_tokens + cache_read_input_tokens + cache_creation_input_tokens = current context size) and the model's context window (200k default; models tagged [1m] or context-1m beta = 1,000,000), compute "% of context used" for the LATEST turn (not cumulative). Add a field to ChatSnapshot (e.g. contextTokens, contextWindow) populated in ChatSession from the result message. Render a small meter in the header or footer showing e.g. "ctx 42% · 84k/200k". Also handle SDKCompactBoundaryMessage: when it arrives, show a subtle "context compacted" marker in the transcript and reset the meter. Spec protocol + core + webview + css.` },
  { key: 'real-slash', prompt: `Make the key slash-commands actually DO something instead of being sent as literal text. Based on recon (which SDK Query methods exist): implement at least /clear and /compact, plus /model (already have model select — /model could open it). /clear = start a fresh conversation (reset transcript, drop resume/sessionId, close & restart the query as a brand-new session; keep the chat entry). /compact = trigger context compaction (if the SDK Query has a compact method use it; otherwise send "/compact" as a message which the CLI-backed subprocess may interpret, and rely on SDKCompactBoundaryMessage to confirm — state which path per recon). Design: in ChatSession add methods clearSession() and compact(); in the composer's send path (App.tsx), when the submitted text is exactly a known local slash command (/clear, /compact), intercept it and post a dedicated message (protocol: {type:'slash', chatId, command}) instead of {type:'send'}; ChatPanel routes to session.clearSession()/compact(). Keep other slash text passing through to send() as today. Spec protocol + core + extension + webview.` },
  { key: 'virtualization-subagents', prompt: `Two things. (1) PERFORMANCE: the transcript renders ALL items (App.tsx maps chat.transcript) — on 1000+ item sessions this lags. Add lightweight windowing: render only the last N (e.g. 250) items with a "Mostra messaggi precedenti" button that reveals older ones in chunks; keep auto-scroll working. No external virtualization lib (keep it simple/robust). (2) NESTED SUBAGENTS: enable Options.forwardSubagentText=true so subagent text/thinking arrives; subagent messages carry parent_tool_use_id (and SDKAssistantMessage has subagent_type/task_description). In ChatSession.handleMessage, tag transcript items produced by a subagent (parent_tool_use_id != null) so the UI can indent/group them under a "Subagent: <type>" collapsible block. Spec protocol (TranscriptItem gets optional subagent?:string / parentToolUseId?:string), core changes, App rendering (indented/grouped), css.` },
]

const specs = await parallel(FEATURES.map((f) => () =>
  agent(
    `You are designing ONE feature for the "Claude Fleet" VS Code extension. Current codebase map:\n\n${reconText}\n\nProduce a PRECISE, implementation-ready spec with real code snippets and exact edit locations, so a single integrator can apply several specs to shared files (protocol.ts, ChatSession.ts, ChatPanel.ts, extension.ts, App.tsx, Markdown.tsx, styles.css, package.json) without conflicts. Prefer additive changes; call out any shared-line edits. Do NOT write files. Feature:\n\n${f.prompt}`,
    { label: `design:${f.key}`, phase: 'Design', schema: SPEC_SCHEMA }
  )
))
const good = specs.filter(Boolean)
log(`Designed ${good.length}/${FEATURES.length} specs.`)

phase('Consolidate')
const consolidation = await agent(
  `Integration lead. Merge these ${good.length} feature specs for Claude Fleet into ONE conflict-free, ordered per-file plan (protocol.ts, ChatSession.ts, ChatPanel.ts, extension.ts, App.tsx, Markdown.tsx, styles.css, package.json, new files). Call out collisions (e.g. multiple TranscriptItem edits, multiple ChatSnapshot fields, App.tsx header/composer edits, package.json) and how to reconcile. Give application order and where to run typecheck. Keep the actual code from the specs.\n\nSPECS:\n${JSON.stringify(good, null, 2)}`,
  { label: 'consolidate', phase: 'Consolidate', schema: {
    type: 'object', additionalProperties: true,
    properties: { perFilePlan: { type: 'string' }, conflicts: { type: 'string' }, newDependencies: { type: 'string' }, buildNotes: { type: 'string' } },
    required: ['perFilePlan'],
  } }
)

return { featureSpecs: good, consolidation }
