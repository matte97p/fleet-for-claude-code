import { describe, it, expect } from "vitest";
import {
  parseTodos,
  splitLines,
  parseEdit,
  nameForToolUse,
  summarizeResult,
  parseLocalSlash,
  contextWindowForModel,
} from "./parsers";
import type { TranscriptItem } from "./protocol";

describe("parseTodos", () => {
  it("maps entries and defaults unknown status to pending", () => {
    const r = parseTodos({
      todos: [
        { content: "a", status: "completed" },
        { content: "b", status: "in_progress", activeForm: "doing b" },
        { content: "c", status: "weird" },
        { content: "d" },
      ],
    });
    expect(r).toEqual([
      { content: "a", status: "completed" },
      { content: "b", status: "in_progress", activeForm: "doing b" },
      { content: "c", status: "pending" },
      { content: "d", status: "pending" },
    ]);
  });
  it("returns [] for missing/invalid input", () => {
    expect(parseTodos(undefined)).toEqual([]);
    expect(parseTodos({})).toEqual([]);
    expect(parseTodos({ todos: "nope" })).toEqual([]);
  });
});

describe("splitLines", () => {
  it("splits on \\n and normalizes CRLF", () => {
    expect(splitLines("a\r\nb\nc")).toEqual(["a", "b", "c"]);
  });
  it("handles nullish", () => {
    expect(splitLines(undefined)).toEqual([""]);
  });
});

describe("parseEdit", () => {
  it("Write → single all-added hunk", () => {
    const e = parseEdit("Write", { file_path: "/x.ts", content: "a\nb" });
    expect(e).toEqual({
      filePath: "/x.ts",
      mode: "write",
      hunks: [{ oldLines: [], newLines: ["a", "b"] }],
    });
  });
  it("Edit → old/new hunk", () => {
    const e = parseEdit("Edit", { file_path: "/x.ts", old_string: "a", new_string: "b" });
    expect(e?.mode).toBe("edit");
    expect(e?.hunks[0]).toEqual({ oldLines: ["a"], newLines: ["b"] });
  });
  it("MultiEdit → one hunk per edit", () => {
    const e = parseEdit("MultiEdit", {
      file_path: "/x.ts",
      edits: [
        { old_string: "a", new_string: "A" },
        { old_string: "b", new_string: "B" },
      ],
    });
    expect(e?.hunks).toHaveLength(2);
  });
  it("returns undefined for non-edit tools or missing path", () => {
    expect(parseEdit("Read", { file_path: "/x" })).toBeUndefined();
    expect(parseEdit("Edit", {})).toBeUndefined();
    expect(parseEdit("Edit", null)).toBeUndefined();
  });
});

describe("nameForToolUse", () => {
  const tx: TranscriptItem[] = [
    { kind: "tool", name: "Read", input: {}, ts: 0, toolUseId: "t1" },
    { kind: "tool", name: "Bash", input: {}, ts: 0, toolUseId: "t2" },
  ];
  it("finds the tool name by id", () => {
    expect(nameForToolUse(tx, "t2")).toBe("Bash");
    expect(nameForToolUse(tx, "t1")).toBe("Read");
  });
  it("falls back to 'tool'", () => {
    expect(nameForToolUse(tx, "nope")).toBe("tool");
    expect(nameForToolUse(tx, undefined)).toBe("tool");
  });
});

describe("summarizeResult", () => {
  it("trims strings", () => {
    expect(summarizeResult("  hi  ")).toBe("hi");
  });
  it("joins content-block arrays", () => {
    expect(summarizeResult([{ type: "text", text: "a" }, "b"])).toBe("ab");
  });
  it("stringifies objects", () => {
    expect(summarizeResult({ a: 1 })).toBe('{"a":1}');
  });
});

describe("parseLocalSlash", () => {
  it("parses known commands", () => {
    expect(parseLocalSlash("/clear")).toEqual({ cmd: "clear", arg: "" });
    expect(parseLocalSlash("/compact keep tests")).toEqual({
      cmd: "compact",
      arg: "keep tests",
    });
    expect(parseLocalSlash("/model opus")).toEqual({ cmd: "model", arg: "opus" });
  });
  it("is case-insensitive on the command", () => {
    expect(parseLocalSlash("/CLEAR")?.cmd).toBe("clear");
  });
  it("returns null for non-local text", () => {
    expect(parseLocalSlash("hello")).toBeNull();
    expect(parseLocalSlash("/help")).toBeNull();
    expect(parseLocalSlash("/clearx")).toBeNull();
  });
});

describe("contextWindowForModel", () => {
  it("defaults to 200k", () => {
    expect(contextWindowForModel("claude-opus-4-8")).toBe(200_000);
    expect(contextWindowForModel(undefined)).toBe(200_000);
  });
  it("detects 1M windows", () => {
    expect(contextWindowForModel("claude-sonnet-5[1m]")).toBe(1_000_000);
    expect(contextWindowForModel("x-context-1m-y")).toBe(1_000_000);
  });
});
