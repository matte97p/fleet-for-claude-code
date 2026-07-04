import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Sidebar } from "./Sidebar";
import { Dashboard } from "./Dashboard";
import { vscodeRaw } from "./acquire";
import "./styles.css";

/** Turns an otherwise-silent render crash (blank/grey webview) into a readable
 *  message, so we never show an unexplained grey screen. */
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { err: Error | null }
> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) {
    return { err };
  }
  componentDidCatch(err: Error, info: unknown) {
    try {
      vscodeRaw.postMessage({
        type: "clientError",
        message: `[render] ${err.stack || err.message}\n${JSON.stringify(info)}`,
      });
    } catch {
      /* ignore */
    }
  }
  render() {
    if (this.state.err) {
      return (
        <div className="boot-error">
          <b>Fleet: errore di rendering</b>
          <pre>{String(this.state.err.stack || this.state.err.message)}</pre>
          <p>Ricarica il webview (Command Palette → “Developer: Reload Webviews”).</p>
        </div>
      );
    }
    return this.props.children;
  }
}

const el = document.getElementById("root")!;
const view = el.getAttribute("data-view");
const chosen =
  view === "sidebar" ? <Sidebar /> : view === "dashboard" ? <Dashboard /> : <App />;

const esc = (s: string) =>
  s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
let mounted = false;
const relay = (kind: string, detail: string) => {
  // Send to the host so it can be written to a log file for diagnostics.
  try {
    vscodeRaw.postMessage({ type: "clientError", message: `[${kind}] ${detail}` });
  } catch {
    /* ignore */
  }
};
const showBoot = (title: string, detail: string) => {
  // Only take over the DOM if React never mounted — never wipe a live app
  // (that would itself blank the view).
  if (mounted) return;
  el.innerHTML =
    `<div class="boot-error"><b>Fleet: ${esc(title)}</b><pre>` +
    esc(detail) +
    "</pre></div>";
};

// Report uncaught errors / rejections to the host (non-destructive).
window.addEventListener("error", (e) => {
  const d = String(e.error?.stack || e.message || e);
  relay("error", d);
  showBoot("errore JS", d);
});
window.addEventListener("unhandledrejection", (e) => {
  const d = String((e.reason && (e.reason.stack || e.reason.message)) || e.reason);
  relay("rejection", d);
  showBoot("promise non gestita", d);
});

try {
  createRoot(el).render(<ErrorBoundary>{chosen}</ErrorBoundary>);
  mounted = true;
} catch (e: any) {
  const d = String(e?.stack || e?.message || e);
  relay("mount", d);
  el.innerHTML = `<div class="boot-error"><b>Fleet: errore di avvio</b><pre>${esc(d)}</pre></div>`;
}
