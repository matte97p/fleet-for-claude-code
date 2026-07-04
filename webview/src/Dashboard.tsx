import React, { useEffect, useState } from "react";
import { vscodeRaw } from "./acquire";
import type {
  DashboardData,
  DashboardCard,
  DashboardToHost,
  HostToDashboard,
  ChatStatus,
} from "../../shared/protocol";

function post(msg: DashboardToHost) {
  vscodeRaw.postMessage(msg);
}

export function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);

  useEffect(() => {
    const handler = (ev: MessageEvent) => {
      const msg = ev.data as HostToDashboard;
      if (msg.type === "dashboard") setData(msg.data);
    };
    window.addEventListener("message", handler);
    post({ type: "ready" });
    return () => window.removeEventListener("message", handler);
  }, []);

  if (!data) return <div className="db-empty">Loading…</div>;

  return (
    <div className="db">
      <div className="db-toolbar">
        <span className="db-title">Fleet dashboard</span>
        <span className="db-count">
          {data.cards.length} chat{data.cards.length === 1 ? "" : "s"}
        </span>
        <span className="spacer" />
        <button
          className={`db-btn ghost ${data.showArchived ? "on" : ""}`}
          onClick={() => post({ type: "toggleArchived" })}
        >
          {data.showArchived ? "Hide archived" : "Show archived"}
        </button>
        <button className="db-btn" onClick={() => post({ type: "newChat" })}>
          + New chat
        </button>
      </div>

      {data.cards.length === 0 ? (
        <div className="db-empty">
          No chats yet. Create one from the sidebar or the button above.
        </div>
      ) : (
        <div className="db-grid">
          {data.cards.map((c) => (
            <Card key={c.id} card={c} active={c.id === data.activeChatId} />
          ))}
        </div>
      )}
    </div>
  );
}

function Card({ card, active }: { card: DashboardCard; active: boolean }) {
  const cls = [
    "db-card",
    card.status,
    card.needsPermission ? "attention" : "",
    card.archived ? "archived" : "",
    active ? "active" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div
      className={cls}
      title={card.cwd}
      onClick={() => post({ type: "open", chatId: card.id })}
    >
      <div className="db-card-head">
        <span className={`db-dot ${card.archived ? "archived" : card.status}`} />
        <span className="db-card-title">{card.title}</span>
      </div>
      {card.folderPath && <div className="db-folder">📁 {card.folderPath}</div>}
      <div className="db-activity">
        {card.needsPermission ? (
          <span className="db-attention-tag">⚠ Needs permission</span>
        ) : (
          card.activity || statusText(card.status)
        )}
      </div>
      <span className="db-model-pill">{shortModel(card.model)}</span>
      <div className="db-meta">
        <span>{fmt(card.usage.inputTokens)} in</span>
        <span>{fmt(card.usage.outputTokens)} out</span>
        {card.usage.costUsd > 0 && <span>${card.usage.costUsd.toFixed(3)}</span>}
        <span>{card.usage.turns} turns</span>
      </div>
      <div className="db-card-foot">
        <span className="db-time">{relTime(card.lastActivityTs)}</span>
        {card.status === "running" && (
          <button
            className="db-stop"
            title="Stop"
            onClick={(e) => {
              e.stopPropagation();
              post({ type: "stop", id: card.id });
            }}
          >
            ■ Stop
          </button>
        )}
      </div>
    </div>
  );
}

function statusText(s: ChatStatus): string {
  switch (s) {
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

function relTime(ts?: number): string {
  if (!ts) return "—";
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
