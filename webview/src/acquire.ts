// acquireVsCodeApi() may be called ONLY ONCE per webview. Both the panel and
// the sidebar bundle from the same JS, so we centralize the single call here
// and everyone imports this instance.
export interface RawVsCodeApi {
  postMessage(msg: unknown): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
}

declare function acquireVsCodeApi(): RawVsCodeApi;

export const vscodeRaw: RawVsCodeApi = acquireVsCodeApi();
