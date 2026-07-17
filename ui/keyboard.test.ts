import { beforeAll, describe, expect, test } from "bun:test";

let keyboard: any;

beforeAll(async () => {
  await import("./keyboard.js");
  keyboard = (globalThis as any).AdoreviewKeyboard;
});

const event = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  target: null,
  composedPath: () => [],
  defaultPrevented: false,
  isComposing: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...extra,
});

const node = (matching: string[]) => ({
  matches: (selector: string) => matching.some((value) => selector.includes(value)),
});

describe("normalizeShortcut", () => {
  test("normalizes arrows while leaving former uppercase J/K actions unbound", () => {
    expect(keyboard.normalizeShortcut(event("j"))).toBe("j");
    expect(keyboard.normalizeShortcut(event("ArrowDown"))).toBe("arrowdown");
    expect(keyboard.normalizeShortcut(event("ArrowUp"))).toBe("arrowup");
    expect(keyboard.normalizeShortcut(event("J", { shiftKey: true }))).toBeNull();
    expect(keyboard.normalizeShortcut(event("K"))).toBeNull();
    // toggle-all is lowercase "t"; capital T and shift+t are accepted aliases
    expect(keyboard.normalizeShortcut(event("t"))).toBe("t");
    expect(keyboard.normalizeShortcut(event("T"))).toBe("t");
    expect(keyboard.normalizeShortcut(event("t", { shiftKey: true }))).toBe("t");
    expect(keyboard.normalizeShortcut(event("ArrowDown", { shiftKey: true }))).toBeNull();
    expect(keyboard.normalizeShortcut(event("?", { shiftKey: true }))).toBe("?");
  });

  test("ignores browser modifiers, composition, and prevented events", () => {
    expect(keyboard.normalizeShortcut(event("j", { metaKey: true }))).toBeNull();
    expect(keyboard.normalizeShortcut(event("j", { ctrlKey: true }))).toBeNull();
    expect(keyboard.normalizeShortcut(event("j", { altKey: true }))).toBeNull();
    expect(keyboard.normalizeShortcut(event("Enter", { isComposing: true }))).toBeNull();
    expect(keyboard.normalizeShortcut(event("ArrowDown", { isComposing: true }))).toBeNull();
    expect(keyboard.normalizeShortcut(event("j", { defaultPrevented: true }))).toBeNull();
  });
});

describe("shortcut contexts", () => {
  test("detects inputs and nested contenteditable targets through composedPath", () => {
    const input = node(["input"]);
    const editable = node(["[contenteditable]"]);
    expect(keyboard.isTypingEvent(event("j", { composedPath: () => [input] }))).toBe(true);
    expect(keyboard.isTypingEvent(event("j", { composedPath: () => [{}, editable] }))).toBe(true);
  });

  test("blocks arrow shortcuts while typing or using interactive controls", () => {
    for (const selector of [
      "input", "textarea", "select", "[contenteditable]", "[role='textbox']", "[role='combobox']",
    ]) {
      expect(keyboard.blocksGlobalShortcuts(
        event("ArrowDown", { composedPath: () => [node([selector])] }),
      )).toBe(true);
    }
    expect(keyboard.blocksGlobalShortcuts(event("v", { composedPath: () => [node(["button"])] }))).toBe(true);
    expect(keyboard.blocksGlobalShortcuts(event("v", { composedPath: () => [node(["a[href]"])] }))).toBe(true);
    expect(keyboard.blocksGlobalShortcuts(event("ArrowDown", { composedPath: () => [{}] }))).toBe(false);
  });

  test("submits comments on Enter while preserving Shift+Enter newlines", () => {
    expect(keyboard.isSubmitShortcut(event("Enter"))).toBe(true);
    expect(keyboard.isSubmitShortcut(event("Enter", { metaKey: true }))).toBe(true);
    expect(keyboard.isSubmitShortcut(event("Enter", { ctrlKey: true }))).toBe(true);
    expect(keyboard.isSubmitShortcut(event("Enter", { shiftKey: true }))).toBe(false);
    expect(keyboard.isSubmitShortcut(event("Enter", { metaKey: true, shiftKey: true }))).toBe(false);
    expect(keyboard.isSubmitShortcut(event("Enter", { metaKey: true, isComposing: true }))).toBe(false);
    expect(keyboard.isSubmitShortcut(event("Enter", { keyCode: 229 }))).toBe(false);
    expect(keyboard.isSubmitShortcut(event("Enter", { metaKey: true, repeat: true }))).toBe(false);
  });

  test("rejects empty, whitespace-only, and in-flight comments", () => {
    expect(keyboard.canSubmitComment("comment")).toBe(true);
    expect(keyboard.canSubmitComment("  comment\n")).toBe(true);
    expect(keyboard.canSubmitComment("")).toBe(false);
    expect(keyboard.canSubmitComment(" \n\t ")).toBe(false);
    expect(keyboard.canSubmitComment("comment", true)).toBe(false);
  });

  test("marks mutating and modal shortcuts as one-shot", () => {
    expect(keyboard.isOneShotShortcut("v")).toBe(true);
    expect(keyboard.isOneShotShortcut("t")).toBe(true);
    expect(keyboard.isOneShotShortcut("j")).toBe(false);
    expect(keyboard.isOneShotShortcut("arrowdown")).toBe(false);
  });
});

describe("keyboard line selection", () => {
  const file = {
    hunks: [{ lines: [
      { old: 10, new: 20 },
      { old: 11, new: 0 },
      { old: 0, new: 21 },
    ] }],
  };

  test("uses side-correct line numbers", () => {
    expect(keyboard.lineNumbersForSide(file, "additions")).toEqual([20, 21]);
    expect(keyboard.lineNumbersForSide(file, "deletions")).toEqual([10, 11]);
  });

  test("starts at the directional edge and moves one line, anchor following", () => {
    expect(keyboard.advanceLineSelection(file, null, 1)).toEqual({
      anchor: 20, head: 20, side: "additions",
    });
    expect(keyboard.advanceLineSelection(file, null, -1)).toEqual({
      anchor: 21, head: 21, side: "additions",
    });
    // moving never leaves a range behind: anchor tracks head
    expect(keyboard.advanceLineSelection(
      file, { anchor: 21, head: 21, side: "additions" }, -1,
    )).toEqual({ anchor: 20, head: 20, side: "additions" });
  });

  test("clamps the cursor at file boundaries", () => {
    expect(keyboard.advanceLineSelection(
      file, { anchor: 21, head: 21, side: "additions" }, 1,
    )).toEqual({ anchor: 21, head: 21, side: "additions" });
    expect(keyboard.advanceLineSelection(
      file, { anchor: 20, head: 20, side: "additions" }, -1,
    )).toEqual({ anchor: 20, head: 20, side: "additions" });
  });

  test("falls back to deletion lines for deleted files", () => {
    const deleted = { hunks: [{ lines: [{ old: 1, new: 0 }, { old: 2, new: 0 }] }] };
    expect(keyboard.preferredSelectionSide(deleted)).toBe("deletions");
    expect(keyboard.lineNumbersForSide(deleted, "deletions")).toEqual([1, 2]);
    expect(keyboard.advanceLineSelection(deleted, null, 1)).toEqual({
      anchor: 1, head: 1, side: "deletions",
    });
  });
});
