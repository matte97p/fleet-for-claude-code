import type { WebviewToHost, HostToWebview } from "../../shared/protocol";
import { vscodeRaw } from "./acquire";

interface VsCodeApi {
  postMessage(msg: WebviewToHost): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
}

export const vscode: VsCodeApi = vscodeRaw as VsCodeApi;

export function onHostMessage(cb: (msg: HostToWebview) => void): () => void {
  const handler = (ev: MessageEvent) => cb(ev.data as HostToWebview);
  window.addEventListener("message", handler);
  return () => window.removeEventListener("message", handler);
}
