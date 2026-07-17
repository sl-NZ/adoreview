(function installKeyboardHelpers(root) {
  "use strict";

  const oneShotShortcuts = new Set([
    "?", "/", "enter", "escape", "1", "2", "a", "c", "o", "r", "s", "t", "v", "x",
  ]);

  function eventPath(event) {
    const path = event.composedPath?.();
    return path?.length ? path : [event.target];
  }

  function matches(node, selector) {
    return !!node && typeof node.matches === "function" && node.matches(selector);
  }

  function isTypingEvent(event) {
    return eventPath(event).some((node) =>
      matches(node, "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox'], [role='combobox']"));
  }

  function blocksGlobalShortcuts(event) {
    return eventPath(event).some((node) =>
      matches(node, "input, textarea, select, button, a[href], summary, [contenteditable]:not([contenteditable='false']), [role='textbox'], [role='combobox'], [role='button'], [role='link'], [role='menuitem'], [role='option']"));
  }

  function normalizeShortcut(event) {
    if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return null;

    const key = String(event.key ?? "");
    const lower = key.toLowerCase();
    // toggle-all is a plain lowercase "t"; also accept capital T / shift+t as
    // aliases (synthetic keyboards may report the char but omit shiftKey).
    if (key === "T" || (event.shiftKey && lower === "t")) return "t";
    if (/^[JK]$/.test(key)) return null;
    // '?' normally requires Shift on US layouts; the produced character is the
    // stable signal across keyboard layouts.
    if (key === "?") return "?";
    if (event.shiftKey) return null;
    return lower || null;
  }

  function isOneShotShortcut(shortcut) {
    return oneShotShortcuts.has(shortcut);
  }

  function isSubmitShortcut(event) {
    return event.key === "Enter" && !event.shiftKey && !event.isComposing &&
      event.keyCode !== 229 && !event.repeat && !event.altKey;
  }

  function canSubmitComment(value, disabled = false) {
    return !disabled && String(value ?? "").trim().length > 0;
  }

  function platformKeys(nav = root.navigator) {
    const platform = nav?.userAgentData?.platform || nav?.platform || "";
    const isMac = /mac|iphone|ipad|ipod/i.test(platform);
    return { isMac, mod: isMac ? "⌘" : "Ctrl", alt: isMac ? "⌥" : "Alt" };
  }

  function lineNumbersForSide(file, side) {
    const prop = side === "deletions" ? "old" : "new";
    const seen = new Set();
    const lines = [];
    for (const hunk of file?.hunks ?? []) {
      for (const line of hunk.lines ?? []) {
        const number = line[prop];
        if (Number.isInteger(number) && number > 0 && !seen.has(number)) {
          seen.add(number);
          lines.push(number);
        }
      }
    }
    return lines;
  }

  function preferredSelectionSide(file) {
    return lineNumbersForSide(file, "additions").length ? "additions" :
      lineNumbersForSide(file, "deletions").length ? "deletions" : null;
  }

  function advanceLineSelection(file, selection, direction) {
    const side = selection?.side ?? preferredSelectionSide(file);
    if (!side) return null;
    const lines = lineNumbersForSide(file, side);
    if (!lines.length) return null;
    if (!selection) {
      const line = direction < 0 ? lines.at(-1) : lines[0];
      return { anchor: line, head: line, side };
    }
    const index = lines.indexOf(selection.head);
    const current = index < 0 ? (direction < 0 ? lines.length : -1) : index;
    const line = lines[Math.max(0, Math.min(lines.length - 1, current + direction))];
    // single-line cursor: the anchor follows the head, so arrows never build a
    // range (ADO anchors a comment to one line — a range has nowhere to land)
    return { anchor: line, head: line, side };
  }

  root.AdoreviewKeyboard = Object.freeze({
    advanceLineSelection,
    blocksGlobalShortcuts,
    canSubmitComment,
    isOneShotShortcut,
    isSubmitShortcut,
    isTypingEvent,
    lineNumbersForSide,
    normalizeShortcut,
    platformKeys,
    preferredSelectionSide,
  });
})(typeof window === "undefined" ? globalThis : window);
