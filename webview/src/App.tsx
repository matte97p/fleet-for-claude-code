import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { vscode, onHostMessage } from "./vscodeApi";
import { Markdown } from "./Markdown";
import { play as playSound } from "./sound";
import type {
  ChatSnapshot,
  TranscriptItem,
  TodoEntry,
  FileEditOp,
  AvailableCommand,
  FileMatch,
  QuickAction,
} from "../../shared/protocol";
import { DEFAULT_QUICK_ACTIONS } from "../../shared/protocol";
import { parseLocalSlash } from "../../shared/parsers";

const WINDOW_SIZE = 60; // items rendered initially / after chat switch (scroll up loads more)
const WINDOW_CHUNK = 250; // items revealed per "show previous" click

export function App() {
  const [chat, setChat] = useState<ChatSnapshot | null>(null);
  const [draft, setDraft] = useState("");
  const [quickActions, setQuickActions] = useState<QuickAction[]>(DEFAULT_QUICK_ACTIONS);
  const [visibleCount, setVisibleCount] = useState(WINDOW_SIZE);
  const scrollRef = useRef<HTMLDivElement>(null);
  const modelSelRef = useRef<HTMLSelectElement>(null);
  const pendingAnchorRef = useRef<{ h: number; top: number } | null>(null);

  useEffect(() => {
    const off = onHostMessage((msg) => {
      if (msg.type === "open" || msg.type === "patch") setChat(msg.chat);
      else if (msg.type === "sound") playSound(msg.play);
      else if (msg.type === "quickActions") setQuickActions(msg.actions);
    });
    vscode.postMessage({ type: "ready" });
    return off;
  }, []);

  // Reset the transcript window when switching chats.
  const chatId = chat?.id;
  useEffect(() => {
    setVisibleCount(WINDOW_SIZE);
  }, [chatId]);

  // Restore scroll position after older items are prepended (no jump on reveal).
  useLayoutEffect(() => {
    const a = pendingAnchorRef.current;
    const el = scrollRef.current;
    if (a && el) {
      el.scrollTop = a.top + (el.scrollHeight - a.h);
      pendingAnchorRef.current = null;
    }
  }, [visibleCount]);

  // Auto-scroll on new content AND when a permission prompt / status appears.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [
    chat?.transcript.length,
    chat?.streamingText,
    chat?.pendingPermission?.requestId,
    chat?.status,
  ]);

  if (!chat) {
    return (
      <div className="empty">
        <div className="empty-badge">◧◧</div>
        <p>Seleziona una chat, o creane una nuova.</p>
      </div>
    );
  }

  const send = (images?: { mediaType: string; dataBase64: string }[]) => {
    const text = draft.trim();
    if (!text && !(images && images.length)) return;
    // Intercept bare local slash commands (no attached images) → run them.
    if (text && !(images && images.length)) {
      const local = parseLocalSlash(text);
      if (local) {
        setDraft("");
        if (local.cmd === "model") applyModelCommand(local.arg);
        else
          vscode.postMessage({
            type: "slash",
            chatId: chat.id,
            command: local.cmd,
            args: local.arg || undefined,
          });
        return;
      }
    }
    vscode.postMessage({ type: "send", chatId: chat.id, text, images });
    setDraft("");
  };

  const applyModelCommand = (arg: string) => {
    if (!arg) {
      modelSelRef.current?.focus();
      return;
    }
    const q = arg.toLowerCase();
    const hit = MODELS.find(
      (m) => m.id && (m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q))
    );
    if (hit) setConfig({ model: hit.id });
    else modelSelRef.current?.focus();
  };

  // Checkpoint navigation: jump between your own messages in the transcript.
  const jumpUserMessage = (dir: 1 | -1) => {
    const root = scrollRef.current;
    if (!root) return;
    const nodes = Array.from(
      root.querySelectorAll<HTMLElement>(".cc-block.user")
    );
    if (nodes.length === 0) return;
    const top = root.scrollTop;
    // Offsets of each user message relative to the scroll container.
    const offs = nodes.map((n) => n.offsetTop);
    let target: number;
    if (dir === 1) {
      target = offs.find((o) => o > top + 4) ?? offs[offs.length - 1];
    } else {
      const prev = [...offs].reverse().find((o) => o < top - 4);
      target = prev ?? offs[0];
    }
    root.scrollTo({ top: Math.max(0, target - 12), behavior: "smooth" });
  };
  const userMsgCount = chat.transcript.filter((t) => t.kind === "user").length;

  const setConfig = (patch: Partial<ChatSnapshot["config"]>) =>
    vscode.postMessage({
      type: "setConfig",
      chatId: chat.id,
      config: { ...chat.config, ...patch },
    });

  // Windowed transcript: render only the last `visibleCount` items for perf.
  const transcript = chat.transcript;
  const windowStart = Math.max(0, transcript.length - visibleCount);
  const visibleTranscript = windowStart > 0 ? transcript.slice(windowStart) : transcript;
  const hiddenCount = windowStart;
  const showPrevious = () => {
    const el = scrollRef.current;
    pendingAnchorRef.current = el ? { h: el.scrollHeight, top: el.scrollTop } : null;
    setVisibleCount((c) => Math.min(transcript.length, c + WINDOW_CHUNK));
  };
  const renderRow = (item: TranscriptItem, index: number) => (
    <Row key={index} item={item} chatId={chat.id} canRewind={chat.canRewind} />
  );

  return (
    <div className="app">
      <header className="header">
        <StatusDot status={chat.status} />
        <span className="title">{chat.title}</span>
        {chat.activity && <span className="activity">{chat.activity}</span>}
        {chat.queued > 0 && (
          <span className="queued-badge" title="Messaggi in coda">
            {chat.queued} in coda
          </span>
        )}
        <div className="spacer" />
        {userMsgCount > 1 && (
          <span className="msg-nav" title="Salta tra i tuoi messaggi">
            <button className="msg-nav-btn" onClick={() => jumpUserMessage(-1)} title="Messaggio precedente">
              ↑
            </button>
            <button className="msg-nav-btn" onClick={() => jumpUserMessage(1)} title="Messaggio successivo">
              ↓
            </button>
          </span>
        )}
        <label className="hfield">
          <span>Modello</span>
          <select
            className="hsel"
            value={chat.config.model ?? ""}
            onChange={(e) => setConfig({ model: e.target.value })}
          >
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
        </label>
        <label className="hfield">
          <span>Ragionamento</span>
          <select
            className="hsel"
            value={chat.config.effort ?? ""}
            onChange={(e) => setConfig({ effort: (e.target.value || undefined) as any })}
          >
            {EFFORTS.map((e) => (
              <option key={e.id} value={e.id}>{e.label}</option>
            ))}
          </select>
        </label>
        <label className="hfield">
          <span>Modalità</span>
          <select
            className="hsel"
            value={chat.config.permissionMode ?? "default"}
            onChange={(e) => setConfig({ permissionMode: e.target.value as any })}
            title={MODES.find((m) => m.id === (chat.config.permissionMode ?? "default"))?.help}
          >
            {MODES.map((p) => (
              <option key={p.id} value={p.id} title={p.help}>{p.label}</option>
            ))}
          </select>
        </label>
        <label className="hfield">
          <span>Thinking</span>
          <button
            className={`hbtn wide ${chat.config.thinking === "off" ? "" : "on"}`}
            title="Attiva/disattiva il ragionamento esteso (thinking)"
            onClick={() =>
              setConfig({ thinking: chat.config.thinking === "off" ? "on" : "off" })
            }
          >
            {chat.config.thinking === "off" ? "🧠 off" : "🧠 on"}
          </button>
        </label>
        <label className="hfield">
          <span>MCP</span>
          <McpButton servers={chat.mcpServers} />
        </label>
        {chat.status === "running" && (
          <button
            className="stop"
            onClick={() =>
              vscode.postMessage({ type: "interrupt", chatId: chat.id })
            }
          >
            Ferma
          </button>
        )}
        <button
          className="gear"
          title="Impostazioni Claude Fleet"
          onClick={() => vscode.postMessage({ type: "openSettings" })}
        >
          ⚙
        </button>
      </header>

      <div className="transcript" ref={scrollRef}>
        {chat.transcript.length === 0 && !chat.streamingText && (
          <div className="hint">Invia un messaggio per iniziare.</div>
        )}
        {hiddenCount > 0 && (
          <button className="cc-load-more" onClick={showPrevious}>
            Mostra messaggi precedenti ({hiddenCount})
          </button>
        )}
        {groupTranscript(visibleTranscript, windowStart).map((node) =>
          node.type === "item" ? (
            renderRow(node.item, node.index)
          ) : (
            <SubagentGroup key={`sub-${node.startIndex}`} node={node} renderRow={renderRow} />
          )
        )}
        {chat.streamingThinking && !chat.streamingText && (
          <LiveThinking text={chat.streamingThinking} />
        )}
        {chat.streamingText && (
          <div className="cc-block assistant">
            <div className="cc-gutter">✳</div>
            <div className="cc-body">
              <Markdown text={chat.streamingText} />
              <span className="caret" />
            </div>
          </div>
        )}
        {chat.status === "running" && !chat.streamingText && !chat.streamingThinking && (
          <div className="cc-block assistant">
            <div className="cc-gutter">✳</div>
            <div className="cc-body typing">
              <span className="think-label">{chat.activity || "sta lavorando…"}</span>
              <span className="dot-typing" />
              <span className="dot-typing" />
              <span className="dot-typing" />
            </div>
          </div>
        )}
        {chat.pendingPermission &&
          (chat.pendingPermission.toolName === "ExitPlanMode" ? (
            <PlanApprovalCard chatId={chat.id} p={chat.pendingPermission} />
          ) : (
            <PermissionCard chatId={chat.id} p={chat.pendingPermission} />
          ))}
      </div>

      <UsageAlert limits={chat.limits} chatId={chat.id} />

      <QuickBar actions={quickActions} chatId={chat.id} disabled={chat.status === "running"} />

      <Composer
        draft={draft}
        setDraft={setDraft}
        onSend={send}
        commands={chat.availableCommands}
      />

      <div className="usage-bar">
        <ContextMeter tokens={chat.contextTokens} window={chat.contextWindow} />
        <span title="Token di questa chat">
          {fmt(chat.usage.inputTokens)}↓ {fmt(chat.usage.outputTokens)}↑ token
        </span>
        {chat.usage.costUsd > 0 && <span>${chat.usage.costUsd.toFixed(3)}</span>}
        <span>{chat.usage.turns} turni</span>
        <span className="spacer" />
        <UsageButton limits={chat.limits} chatId={chat.id} />
      </div>
    </div>
  );
}

/** Built-in Claude Code slash commands, shown even before a query has started
 *  (SDK supportedCommands() only populates after the first turn's init). Merged
 *  with the SDK list; SDK entries win on name collision. */
const BUILTIN_COMMANDS: AvailableCommand[] = [
  { name: "clear", description: "Cancella la cronologia della conversazione", argumentHint: "" },
  { name: "compact", description: "Riassumi e compatta il contesto", argumentHint: "[istruzioni]" },
  { name: "cost", description: "Mostra token e costo", argumentHint: "" },
  { name: "help", description: "Elenca i comandi disponibili", argumentHint: "" },
  { name: "model", description: "Cambia il modello", argumentHint: "[modello]" },
  { name: "review", description: "Rivedi le modifiche correnti", argumentHint: "" },
  { name: "init", description: "Riassumi il progetto in CLAUDE.md", argumentHint: "" },
];


// Group consecutive subagent-produced transcript items under a collapsible block.
type RNode =
  | { type: "item"; item: TranscriptItem; index: number }
  | {
      type: "sub";
      pid: string;
      subagent?: string;
      items: { item: TranscriptItem; index: number }[];
      startIndex: number;
    };

function groupTranscript(items: TranscriptItem[], base: number): RNode[] {
  const out: RNode[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const pid = (item as any).parentToolUseId as string | undefined;
    if (pid) {
      const last = out[out.length - 1];
      if (last && last.type === "sub" && last.pid === pid) {
        last.items.push({ item, index: base + i });
        if (!last.subagent && (item as any).subagent) last.subagent = (item as any).subagent;
      } else {
        out.push({
          type: "sub",
          pid,
          subagent: (item as any).subagent,
          items: [{ item, index: base + i }],
          startIndex: base + i,
        });
      }
    } else {
      out.push({ type: "item", item, index: base + i });
    }
  }
  return out;
}

function SubagentGroup({
  node,
  renderRow,
}: {
  node: Extract<RNode, { type: "sub" }>;
  renderRow: (item: TranscriptItem, index: number) => JSX.Element;
}) {
  const [open, setOpen] = useState(false);
  const label = node.subagent ? `Subagent: ${node.subagent}` : "Subagent";
  return (
    <div className="cc-subagent">
      <button className="cc-subagent-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="cc-subagent-caret">{open ? "▾" : "▸"}</span>
        <span className="cc-subagent-label">🤖 {label}</span>
        <span className="cc-subagent-count">{node.items.length}</span>
      </button>
      {open && (
        <div className="cc-subagent-body">
          {node.items.map(({ item, index }) => renderRow(item, index))}
        </div>
      )}
    </div>
  );
}

const MODELS = [
  { id: "", label: "Default" },
  { id: "claude-opus-4-8", label: "Opus 4.8" },
  { id: "claude-sonnet-5", label: "Sonnet 5" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
  { id: "claude-fable-5", label: "Fable 5" },
];
const EFFORTS: { id: string; label: string }[] = [
  { id: "", label: "Default" },
  { id: "low", label: "Basso (veloce)" },
  { id: "medium", label: "Medio" },
  { id: "high", label: "Alto" },
  { id: "xhigh", label: "Molto alto" },
  { id: "max", label: "Massimo" },
];
// Unified "mode" switch (maps to the SDK's 4 permissionMode values). Labels use
// Claude Code's own names: Manual asks each time, Edit automatically auto-accepts
// file edits, Plan mode is read-only, Auto mode runs everything without asking.
const MODES: { id: string; label: string; help: string }[] = [
  { id: "default", label: "Manual", help: "Chiede conferma prima di ogni azione non pre-approvata (come Claude Code “normale”)." },
  { id: "acceptEdits", label: "Edit automatically", help: "Applica le modifiche ai file senza chiedere; chiede ancora per comandi/altri strumenti." },
  { id: "plan", label: "Plan mode", help: "Analizza e propone un piano senza eseguire modifiche." },
  { id: "bypassPermissions", label: "Auto mode ⚠", help: "Esegue qualsiasi strumento senza chiedere. Usa con cautela." },
];

function mergeCommands(sdk: AvailableCommand[]): AvailableCommand[] {
  const names = new Set(sdk.map((c) => c.name));
  return [...sdk, ...BUILTIN_COMMANDS.filter((b) => !names.has(b.name))];
}

/** Composer with slash-command AND @-mention autocomplete + file drag-and-drop.
 *  At most one menu is open at a time (slash wins when the draft is a bare /token). */
interface PendingImage {
  mediaType: string;
  dataBase64: string;
  url: string; // data: URL for the thumbnail
}

function Composer({
  draft,
  setDraft,
  onSend,
  commands,
}: {
  draft: string;
  setDraft: (v: string) => void;
  onSend: (images?: { mediaType: string; dataBase64: string }[]) => void;
  commands: AvailableCommand[];
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const allCommands = mergeCommands(commands);
  const [images, setImages] = useState<PendingImage[]>([]);

  const addImageFile = (file: File) => {
    if (!file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = () => {
      const res = String(reader.result || "");
      const comma = res.indexOf(",");
      if (comma < 0) return;
      setImages((prev) => [
        ...prev,
        { mediaType: file.type, dataBase64: res.slice(comma + 1), url: res },
      ]);
    };
    reader.readAsDataURL(file);
  };

  const submit = () => {
    onSend(images.map((i) => ({ mediaType: i.mediaType, dataBase64: i.dataBase64 })));
    setImages([]);
  };

  // --- slash-command state ---
  const [cmdIndex, setCmdIndex] = useState(0);
  const [cmdOpen, setCmdOpen] = useState(true);
  const slashMatch = /^\/([^\s]*)$/.exec(draft);
  const cmdQuery = slashMatch ? slashMatch[1].toLowerCase() : null;
  const cmdMatches: AvailableCommand[] =
    cmdQuery !== null
      ? allCommands.filter(
          (c) =>
            c.name.toLowerCase().startsWith(cmdQuery) ||
            (c.aliases ?? []).some((a) => a.toLowerCase().startsWith(cmdQuery))
        )
      : [];
  const showCmd = cmdOpen && cmdMatches.length > 0;
  const cmdClamped = Math.min(cmdIndex, Math.max(0, cmdMatches.length - 1));

  const applyCommand = (c: AvailableCommand) => {
    setDraft("/" + c.name + " ");
    setCmdIndex(0);
    setCmdOpen(true);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (ta) {
        ta.focus();
        const end = ta.value.length;
        ta.setSelectionRange(end, end);
      }
    });
  };

  // --- @-mention state ---
  const [matches, setMatches] = useState<FileMatch[] | null>(null);
  const [active, setActive] = useState(0);
  const tokenRef = useRef<{ start: number; end: number } | null>(null);
  const reqRef = useRef(0);
  const mentionOpen = matches !== null && !showCmd;

  useEffect(() => {
    const off = onHostMessage((msg) => {
      if (msg.type === "fileResults" && msg.requestId === reqRef.current) {
        setMatches(msg.matches);
        setActive(0);
      }
    });
    return off;
  }, []);

  const closeMention = () => {
    setMatches(null);
    tokenRef.current = null;
  };

  const syncMention = (value: string, caret: number) => {
    let i = caret - 1;
    while (i >= 0 && !/\s/.test(value[i]) && value[i] !== "@") i--;
    if (i < 0 || value[i] !== "@") return closeMention();
    if (i > 0 && !/\s/.test(value[i - 1])) return closeMention();
    const token = value.slice(i + 1, caret);
    if (/\s/.test(token)) return closeMention();
    tokenRef.current = { start: i, end: caret };
    const requestId = ++reqRef.current;
    vscode.postMessage({ type: "searchFiles", query: token, requestId });
    if (matches === null) setMatches([]);
  };

  const chooseMention = (m: FileMatch) => {
    const tok = tokenRef.current;
    const ta = taRef.current;
    if (!tok || !ta) return closeMention();
    const before = draft.slice(0, tok.start);
    const after = draft.slice(tok.end);
    const insert = `@${m.path} `;
    const next = before + insert + after;
    setDraft(next);
    closeMention();
    const caret = before.length + insert.length;
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(caret, caret);
    });
  };

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setDraft(value);
    setCmdIndex(0);
    setCmdOpen(true);
    // Slash menu takes priority when the draft is a bare "/token"; else mention.
    if (/^\/([^\s]*)$/.test(value)) closeMention();
    else syncMention(value, e.target.selectionStart ?? value.length);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showCmd) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setCmdIndex((i) => (i + 1) % cmdMatches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setCmdIndex((i) => (i - 1 + cmdMatches.length) % cmdMatches.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        applyCommand(cmdMatches[cmdClamped]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setCmdOpen(false);
        return;
      }
    } else if (mentionOpen && matches && matches.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => (a + 1) % matches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => (a - 1 + matches.length) % matches.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        chooseMention(matches[active]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeMention();
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const imgs = Array.from(e.clipboardData.items).filter((it) =>
      it.type.startsWith("image/")
    );
    if (imgs.length === 0) return;
    e.preventDefault();
    for (const it of imgs) {
      const f = it.getAsFile();
      if (f) addImageFile(f);
    }
  };

  const onDrop = (e: React.DragEvent<HTMLTextAreaElement>) => {
    // Image files dropped onto the composer become attachments.
    const files = Array.from(e.dataTransfer.files || []).filter((f) =>
      f.type.startsWith("image/")
    );
    if (files.length > 0) {
      e.preventDefault();
      files.forEach(addImageFile);
      return;
    }
    const uriList = e.dataTransfer.getData("text/uri-list");
    const plain = e.dataTransfer.getData("text/plain");
    const raw = uriList || plain;
    if (!raw) return;
    e.preventDefault();
    const paths = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map(uriToMention)
      .filter(Boolean) as string[];
    if (paths.length === 0) return;
    const ta = taRef.current;
    const caret = ta?.selectionStart ?? draft.length;
    const insert = paths.map((p) => `@${p}`).join(" ") + " ";
    const next = draft.slice(0, caret) + insert + draft.slice(caret);
    setDraft(next);
    const newCaret = caret + insert.length;
    requestAnimationFrame(() => {
      ta?.focus();
      ta?.setSelectionRange(newCaret, newCaret);
    });
  };

  return (
    <footer className="composer">
      <div className="composer-input">
        {showCmd && (
          <div className="cmd-menu" role="listbox">
            {cmdMatches.map((c, i) => (
              <div
                key={c.name}
                role="option"
                aria-selected={i === cmdClamped}
                className={"cmd-item" + (i === cmdClamped ? " active" : "")}
                onMouseDown={(e) => {
                  e.preventDefault();
                  applyCommand(c);
                }}
                onMouseEnter={() => setCmdIndex(i)}
              >
                <span className="cmd-name">/{c.name}</span>
                {c.argumentHint && (
                  <span className="cmd-hint">{c.argumentHint}</span>
                )}
                <span className="cmd-desc">{c.description}</span>
              </div>
            ))}
          </div>
        )}
        {mentionOpen && (
          <div className="mention-menu" role="listbox">
            {matches && matches.length === 0 ? (
              <div className="mention-empty">No matching files</div>
            ) : (
              matches!.map((m, i) => (
                <div
                  key={m.path}
                  role="option"
                  aria-selected={i === active}
                  className={`mention-item ${i === active ? "active" : ""}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    chooseMention(m);
                  }}
                  onMouseEnter={() => setActive(i)}
                >
                  <span className="mention-name">{m.name}</span>
                  <span className="mention-path">{m.path}</span>
                </div>
              ))
            )}
          </div>
        )}
        {images.length > 0 && (
          <div className="img-tray">
            {images.map((im, i) => (
              <div className="img-thumb" key={i}>
                <img src={im.url} alt="" />
                <button
                  className="img-rm"
                  title="Rimuovi"
                  onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={taRef}
          value={draft}
          placeholder="Scrivi a Claude…  (/ comandi · @ file · incolla immagini · Invio per inviare)"
          onChange={onChange}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onDrop={onDrop}
          onDragOver={(e) => e.preventDefault()}
          onBlur={() => setTimeout(closeMention, 120)}
        />
      </div>
      <button
        className="send"
        onClick={submit}
        disabled={!draft.trim() && images.length === 0}
      >
        Invia
      </button>
    </footer>
  );
}

/** Turn a dropped file:// URI (or bare path) into an @path token. */
function uriToMention(entry: string): string | null {
  let s = entry;
  if (s.startsWith("file://")) {
    try {
      s = decodeURIComponent(new URL(s).pathname);
    } catch {
      return null;
    }
  }
  s = s.replace(/\\/g, "/");
  return s.replace(/^\/+/, "");
}

/** Footer usage button: quick glance (weekly %) + click opens the full panel. */
// Quick-actions bar: a curated primary row + a "Mostra altro" overflow.
function QuickBar({
  actions,
  chatId,
  disabled,
}: {
  actions: QuickAction[];
  chatId: string;
  disabled: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  // Built-ins carry `primary`; user-defined actions (no flag) are always shown.
  const primary = actions.filter((a) => a.primary || a.primary === undefined);
  const extra = actions.filter((a) => a.primary === false);
  const shown = expanded ? [...primary, ...extra] : primary;
  const run = (a: QuickAction) =>
    vscode.postMessage({ type: "send", chatId, text: a.prompt });
  return (
    <div className="quick-bar" title="Azioni rapide (eseguite da Claude nella cartella della chat)">
      {shown.map((a) => (
        <button
          key={a.label}
          className="quick-btn"
          title={a.title}
          disabled={disabled}
          onClick={() => run(a)}
        >
          {a.label}
        </button>
      ))}
      {extra.length > 0 && (
        <button
          className="quick-btn quick-more"
          title={expanded ? "Mostra meno azioni" : `Altre ${extra.length} azioni`}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Mostra meno ▴" : `Mostra altro ▾`}
        </button>
      )}
    </div>
  );
}

function UsageButton({
  limits,
  chatId,
}: {
  limits: ChatSnapshot["limits"];
  chatId: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const windows = limits?.available ? limits.windows : [];
  const top = [...windows].sort((a, b) => b.utilization - a.utilization)[0];
  // Label states: loading (no data yet), unavailable (plan has none), or the top %.
  const label = !limits
    ? "Consumi…"
    : !limits.available
    ? "Consumi n/d"
    : top
    ? `${top.utilization}%`
    : "Consumi";
  const refresh = () => vscode.postMessage({ type: "refreshUsage", chatId });

  return (
    <div className="usage-wrap" ref={ref}>
      <button
        className={`usage-btn ${top && top.utilization >= 80 ? "hot" : ""}`}
        onClick={() => {
          setOpen((v) => !v);
          if (!limits || !limits.available) refresh();
        }}
        title="Consumi del piano (sessione / settimana)"
      >
        📊 {label}
      </button>
      {open && (
        <div className="usage-panel">
          <div className="usage-panel-head">
            Consumi{limits?.subscriptionType ? ` · ${limits.subscriptionType}` : ""}
            <button className="usage-refresh" title="Aggiorna" onClick={refresh}>
              ⟳
            </button>
          </div>
          {windows.length === 0 ? (
            <div className="usage-empty">
              {!limits
                ? "In caricamento… (invia un messaggio se non arriva)"
                : "Nessun limite riportato dal piano."}
            </div>
          ) : (
            windows.map((w, i) => (
              <div className="usage-win" key={i}>
                <div className="usage-win-top">
                  <span className="usage-win-label">{w.label}</span>
                  <span className="usage-win-pct">{w.utilization}%</span>
                </div>
                <div className="usage-track">
                  <div
                    className={`usage-fill ${
                      w.utilization >= 90 ? "red" : w.utilization >= 75 ? "warn" : ""
                    }`}
                    style={{ width: `${Math.min(100, w.utilization)}%` }}
                  />
                </div>
                {w.resetsAtMs && (
                  <div className="usage-reset">Reset tra {resetIn(w.resetsAtMs)}</div>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// MCP servers + connection status, mirroring Claude Code's /mcp view.
function McpButton({ servers }: { servers?: ChatSnapshot["mcpServers"] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const list = servers ?? [];
  const bad = list.filter((s) => mcpDot(s.status) === "red").length;
  const pending = list.filter((s) => mcpDot(s.status) === "warn").length;
  // Button badge: connected count, with a color hint if anything is off.
  const badgeClass = bad ? "err" : pending ? "warn" : list.length ? "ok" : "";
  const manage = () => vscode.postMessage({ type: "manageMcp" });

  return (
    <div className="usage-wrap" ref={ref}>
      <button
        className={`hbtn mcp-btn ${badgeClass}`}
        title="Server MCP e stato connessione"
        onClick={() => setOpen((v) => !v)}
      >
        🧩 {list.length || "0"}
      </button>
      {open && (
        <div className="usage-panel mcp-panel">
          <div className="usage-panel-head">
            Server MCP
            <button className="usage-refresh" title="Gestisci / aggiungi" onClick={manage}>
              ＋
            </button>
          </div>
          {list.length === 0 ? (
            <div className="usage-empty">
              Nessun server MCP in questa cartella. Aggiungine uno al{" "}
              <code>.mcp.json</code>, poi riavvia la chat per caricarlo.
            </div>
          ) : (
            <div className="mcp-list">
              {list.map((s) => (
                <div className="mcp-row" key={s.name}>
                  <span className={`mcp-dot ${mcpDot(s.status)}`} />
                  <span className="mcp-name">{s.name}</span>
                  <span className="mcp-status">{mcpLabel(s.status)}</span>
                </div>
              ))}
            </div>
          )}
          <button className="mcp-manage" onClick={manage}>
            Gestisci server MCP…
          </button>
        </div>
      )}
    </div>
  );
}

// Map SDK MCP status → dot color class.
function mcpDot(status: string): "ok" | "warn" | "red" {
  const s = status.toLowerCase();
  if (s === "connected") return "ok";
  if (s.includes("auth") || s === "pending" || s === "connecting") return "warn";
  return "red"; // failed / disabled / needs-auth-error / unknown
}
function mcpLabel(status: string): string {
  const s = status.toLowerCase();
  if (s === "connected") return "connesso";
  if (s === "pending" || s === "connecting") return "in connessione…";
  if (s.includes("auth")) return "richiede login";
  if (s === "failed") return "errore";
  return status;
}

function resetIn(ms: number): string {
  const delta = ms - Date.now();
  if (!isFinite(delta) || delta <= 0) return "ora";
  const m = Math.round(delta / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}g`;
}

function StatusDot({ status }: { status: ChatSnapshot["status"] }) {
  const label =
    status === "running"
      ? "Running"
      : status === "waiting-permission"
      ? "Waiting for permission"
      : status === "error"
      ? "Error"
      : "Idle";
  return <span className={`dot ${status}`} title={label} />;
}

/** Claude-Code-style rendering: a left gutter marker per block, document layout. */
function Row({
  item,
  chatId,
  canRewind,
}: {
  item: TranscriptItem;
  chatId: string;
  canRewind: boolean;
}) {
  switch (item.kind) {
    case "user":
      return (
        <div className="cc-block user">
          <div className="cc-gutter user">&gt;</div>
          <div className="cc-body user-text">
            {item.text}
            {item.images ? (
              <span className="user-img-tag">🖼 {item.images} immagine{item.images > 1 ? "e" : ""}</span>
            ) : null}
            {canRewind && item.uuid && (
              <button
                className="rewind-btn"
                title="Rewind: riporta conversazione e file allo stato di questo messaggio"
                onClick={() =>
                  vscode.postMessage({ type: "rewind", chatId, userMessageId: item.uuid! })
                }
              >
                ↩ rewind qui
              </button>
            )}
          </div>
        </div>
      );
    case "assistant":
      return (
        <div className="cc-block assistant">
          <div className="cc-gutter">✳</div>
          <div className="cc-body">
            <Markdown text={item.text} />
          </div>
        </div>
      );
    case "thinking":
      return <ThinkingBlock text={item.text} />;
    case "todos":
      return <TodoList todos={item.todos} />;
    case "tool":
      if (item.edit) return <DiffBlock name={item.name} edit={item.edit} chatId={chatId} />;
      return (
        <div className="cc-block tool">
          <div className="cc-gutter dot">⏺</div>
          <div className="cc-body">
            <span className="cc-tool-name">{item.name}</span>
            <ToolInput name={item.name} input={item.input} chatId={chatId} />
          </div>
        </div>
      );
    case "tool-result":
      return <ResultBlock ok={item.ok} summary={item.summary} full={item.full} />;
    case "system":
      return <div className="cc-system">{item.text}</div>;
    case "compact":
      return (
        <div className="cc-block cc-compact" role="separator" aria-label="context compacted">
          <span className="cc-compact-line" />
          <span className="cc-compact-label">
            Contesto compresso{item.trigger === "auto" ? " (auto)" : ""}
            {item.postTokens != null
              ? ` · ${fmt(item.preTokens)}→${fmt(item.postTokens)}`
              : ""}
          </span>
          <span className="cc-compact-line" />
        </div>
      );
    case "error":
      return (
        <div className="cc-block error">
          <div className="cc-gutter">⚠</div>
          <div className="cc-body cc-error-body">{item.text}</div>
        </div>
      );
  }
}

/** Warning banner above the composer when a plan usage window is running high
 *  (like Claude Code's "You've used 90% of your weekly limit"). Dismissible. */
function UsageAlert({
  limits,
  chatId,
}: {
  limits: ChatSnapshot["limits"];
  chatId: string;
}) {
  const [dismissed, setDismissed] = useState(false);
  if (!limits?.available || !limits.windows.length) return null;
  const top = [...limits.windows].sort((a, b) => b.utilization - a.utilization)[0];
  if (!top || top.utilization < 80) return null;
  if (dismissed) return null;
  const crit = top.utilization >= 90;
  const reset = top.resetsAtMs ? ` · reset tra ${resetIn(top.resetsAtMs)}` : "";
  return (
    <div className={`usage-alert ${crit ? "crit" : "warn"}`}>
      <span className="usage-alert-text">
        Hai usato <b>{top.utilization}%</b> del limite {top.label.toLowerCase()}
        {reset}
      </span>
      <button
        className="usage-alert-link"
        onClick={() => vscode.postMessage({ type: "refreshUsage", chatId })}
      >
        Aggiorna
      </button>
      <button
        className="usage-alert-x"
        title="Nascondi"
        onClick={() => setDismissed(true)}
      >
        ×
      </button>
    </div>
  );
}

/** Context-window meter (footer). */
function ContextMeter({ tokens, window: win }: { tokens?: number; window?: number }) {
  if (tokens == null || !win || win <= 0) return null;
  const pct = Math.min(100, Math.round((tokens / win) * 100));
  const level = pct >= 90 ? "crit" : pct >= 75 ? "warn" : "ok";
  return (
    <span
      className={`ctx-meter ctx-${level}`}
      title={`Contesto: ${tokens.toLocaleString()} / ${win.toLocaleString()} token (${pct}%)`}
    >
      <span className="ctx-bar">
        <span className="ctx-fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="ctx-label">
        ctx {pct}% · {fmt(tokens)}/{fmt(win)}
      </span>
    </span>
  );
}

/** Live extended-reasoning, streamed before the answer. Auto-expanded, tail-followed. */
function LiveThinking({ text }: { text: string }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="cc-block thinking live">
      <div className="cc-gutter">✻</div>
      <div className="cc-body">
        <button className="think-toggle" onClick={() => setOpen((v) => !v)}>
          {open ? "▾" : "▸"} <span className="think-pulse">Sta ragionando…</span>
        </button>
        {open && (
          <div className="think-body">
            <Markdown text={text} />
            <span className="caret" />
          </div>
        )}
      </div>
    </div>
  );
}

/** Collapsible "thinking" block (Claude's extended reasoning). Collapsed by default. */
function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="cc-block thinking">
      <div className="cc-gutter">✻</div>
      <div className="cc-body">
        <button className="think-toggle" onClick={() => setOpen((v) => !v)}>
          {open ? "▾" : "▸"} Ragionamento
        </button>
        {open && (
          <div className="think-body">
            <Markdown text={text} />
          </div>
        )}
      </div>
    </div>
  );
}

const TODO_GLYPH = { pending: "☐", in_progress: "◐", completed: "☑" } as const;

function TodoList({ todos }: { todos: TodoEntry[] }) {
  if (!todos.length) return null;
  const done = todos.filter((t) => t.status === "completed").length;
  return (
    <div className="cc-block todos">
      <div className="cc-gutter">☑</div>
      <div className="cc-body cc-todos">
        <div className="cc-todos-head">
          Todos{" "}
          <span className="cc-todos-count">
            {done}/{todos.length}
          </span>
        </div>
        <ul className="cc-todo-list">
          {todos.map((t, i) => (
            <li key={i} className={`cc-todo ${t.status}`}>
              <span className="cc-todo-mark">{TODO_GLYPH[t.status]}</span>
              <span className="cc-todo-text">
                {t.status === "in_progress" && t.activeForm
                  ? t.activeForm
                  : t.content}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** Line-based diff. old→red, new→green. */
function DiffBlock({ name, edit, chatId }: { name: string; edit: FileEditOp; chatId: string }) {
  return (
    <div className="cc-block tool diff">
      <div className="cc-gutter dot">⏺</div>
      <div className="cc-body">
        <div className="cc-diff-head">
          <span className="cc-tool-name">
            {name === "Write" ? "Write" : "Edit"}
          </span>
          <button
            className="file-link"
            title={`Apri ${edit.filePath}`}
            onClick={() => openFile(chatId, edit.filePath)}
          >
            {shortPath(edit.filePath)}
          </button>
          <button
            className="diff-link"
            title="Apri diff git (working ⇄ HEAD)"
            onClick={() => openDiff(chatId, edit.filePath)}
          >
            ±diff
          </button>
        </div>
        {edit.hunks.map((h, hi) => (
          <pre className="cc-diff" key={hi}>
            {diffLines(h.oldLines, h.newLines, edit.mode).map((ln, i) => (
              <div
                key={i}
                className={`cc-diff-line ${
                  ln.sign === "+" ? "add" : ln.sign === "-" ? "del" : "ctx"
                }`}
              >
                <span className="cc-diff-gutter">{ln.sign || " "}</span>
                <span className="cc-diff-code">{ln.text || " "}</span>
              </div>
            ))}
          </pre>
        ))}
      </div>
    </div>
  );
}

function ToolInput({ name, input, chatId }: { name: string; input: unknown; chatId: string }) {
  const fp = (input as any)?.file_path;
  if (fp && (name === "Read" || name === "Edit" || name === "Write" || name === "MultiEdit")) {
    return (
      <button className="file-link" title={`Apri ${fp}`} onClick={() => openFile(chatId, String(fp))}>
        {shortPath(String(fp))}
      </button>
    );
  }
  return <span className="cc-tool-arg">{toolArg(name, input)}</span>;
}

function openFile(chatId: string, path: string) {
  vscode.postMessage({ type: "openFile", chatId, path });
}

function openDiff(chatId: string, path: string) {
  vscode.postMessage({ type: "openDiff", chatId, path });
}

function ResultBlock({
  ok,
  summary,
  full,
}: {
  ok: boolean;
  summary: string;
  full?: string;
}) {
  const [open, setOpen] = useState(false);
  const expandable = !!full && full !== summary;
  const shown = open && full ? full : summary;
  return (
    <div className="cc-block result">
      <div className="cc-gutter">⎿</div>
      <div className={`cc-body cc-result ${ok ? "" : "fail"}`}>
        <span className="cc-result-text">{shown}</span>
        {expandable && (
          <button className="cc-expand" onClick={() => setOpen((v) => !v)}>
            {open ? "less" : "more"}
          </button>
        )}
      </div>
    </div>
  );
}

function PermissionCard({
  chatId,
  p,
}: {
  chatId: string;
  p: NonNullable<ChatSnapshot["pendingPermission"]>;
}) {
  const decide = (decision: "allow" | "deny", remember = false) =>
    vscode.postMessage({
      type: "permission",
      chatId,
      requestId: p.requestId,
      decision,
      remember,
    });
  const detail = permDetail(p.toolName, p.input);
  return (
    <div className="permission">
      <div className="perm-badge">⚠ Permesso richiesto</div>
      <div className="perm-title">{p.title}</div>
      {p.description && <div className="perm-desc">{p.description}</div>}
      {detail && <pre className="perm-detail">{detail}</pre>}
      <div className="perm-actions">
        <button className="allow" onClick={() => decide("allow")}>
          Consenti
        </button>
        <button className="allow-always" onClick={() => decide("allow", true)}>
          Consenti sempre
        </button>
        <button className="deny" onClick={() => decide("deny")}>
          Nega
        </button>
      </div>
    </div>
  );
}

function PlanApprovalCard({
  chatId,
  p,
}: {
  chatId: string;
  p: NonNullable<ChatSnapshot["pendingPermission"]>;
}) {
  const plan = typeof p.input?.plan === "string" ? (p.input.plan as string) : "";
  const approve = () =>
    vscode.postMessage({
      type: "permission",
      chatId,
      requestId: p.requestId,
      decision: "allow",
      exitPlan: true,
    });
  const keepPlanning = () =>
    vscode.postMessage({
      type: "permission",
      chatId,
      requestId: p.requestId,
      decision: "deny",
    });
  return (
    <div className="plan-card">
      <div className="plan-badge">◆ Piano pronto</div>
      <div className="plan-body">
        {plan ? <Markdown text={plan} /> : <em>Claude ha proposto un piano.</em>}
      </div>
      <div className="perm-actions">
        <button className="allow" onClick={approve}>
          Approva ed esegui
        </button>
        <button className="deny" onClick={keepPlanning}>
          Continua a pianificare
        </button>
      </div>
    </div>
  );
}

function shortModel(id?: string): string {
  if (!id) return "default";
  return id
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "")
    .replace(/\[1m\]$/, "");
}

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

function shortPath(p: string): string {
  const parts = p.split("/");
  return parts.length <= 2 ? p : ".../" + parts.slice(-2).join("/");
}

type DL = { sign: "+" | "-" | ""; text: string };
/** Minimal O(n) line diff: trim common prefix/suffix, del old block, add new block. */
function diffLines(
  oldLines: string[],
  newLines: string[],
  mode: "edit" | "write"
): DL[] {
  if (mode === "write") return newLines.map((t) => ({ sign: "+", text: t }));
  let start = 0;
  const maxStart = Math.min(oldLines.length, newLines.length);
  while (start < maxStart && oldLines[start] === newLines[start]) start++;
  let endO = oldLines.length,
    endN = newLines.length;
  while (endO > start && endN > start && oldLines[endO - 1] === newLines[endN - 1]) {
    endO--;
    endN--;
  }
  const out: DL[] = [];
  for (let i = 0; i < start; i++) out.push({ sign: "", text: oldLines[i] });
  for (let i = start; i < endO; i++) out.push({ sign: "-", text: oldLines[i] });
  for (let i = start; i < endN; i++) out.push({ sign: "+", text: newLines[i] });
  for (let i = endO; i < oldLines.length; i++)
    out.push({ sign: "", text: oldLines[i] });
  return out;
}

function toolArg(name: string, input: any): string {
  if (!input || typeof input !== "object") return "";
  const short = (s: unknown, n = 80) => {
    const str = String(s ?? "").replace(/\s+/g, " ").trim();
    return str.length > n ? str.slice(0, n) + "…" : str;
  };
  switch (name) {
    case "Read":
      return input.file_path ? shortPath(String(input.file_path)) : "";
    case "Bash":
      return short(input.command, 100);
    case "Grep":
      return (
        `"${short(input.pattern, 40)}"` +
        (input.path ? ` in ${shortPath(String(input.path))}` : "")
      );
    case "Glob":
      return short(input.pattern, 60);
    case "WebFetch":
    case "WebSearch":
      return short(input.url ?? input.query, 80);
    case "Task":
      return short(input.description ?? input.subagent_type, 60);
  }
  if (input.file_path) return shortPath(String(input.file_path));
  if (input.command) return short(input.command, 100);
  if (input.pattern) return short(input.pattern);
  if (input.url) return short(input.url);
  return short(JSON.stringify(input), 80);
}

function permDetail(tool: string, input: any): string {
  if (!input || typeof input !== "object") return "";
  if (input.command) return String(input.command);
  if (input.file_path && input.new_string !== undefined)
    return `${input.file_path}\n\n${input.new_string}`;
  if (input.file_path && input.content !== undefined)
    return `${input.file_path}\n\n${String(input.content).slice(0, 500)}`;
  if (input.file_path) return String(input.file_path);
  if (input.url) return String(input.url);
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return "";
  }
}
