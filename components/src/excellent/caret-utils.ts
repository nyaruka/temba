// ---------------------------------------------------------------------------
// Cursor management utilities for contenteditable.
//
// The DOM produced by our renderer is a flat list of <span> tokens (newlines
// are "\n" characters inside <span class="tok-newline">) plus an optional
// trailing <br data-sentinel> that exists only so Firefox renders an empty
// final line. Browser-inserted structures (e.g. from yank/paste) are also
// possible: a bare <br> represents a real newline, and a <div> or <p> at the
// editable's root level represents a line block. Both are translated to "\n"
// when computing plain-text offsets so the rebuild after handleInput sees the
// correct value.
// ---------------------------------------------------------------------------

/** Gets the Selection object, handling shadow DOM. */
export function getSelectionFromRoot(element: HTMLElement): Selection | null {
  const root = element.getRootNode() as ShadowRoot;
  if ((root as any).getSelection) {
    return (root as any).getSelection();
  }
  return window.getSelection();
}

function getComposedRange(
  selection: Selection,
  root: ShadowRoot
): StaticRange | null {
  const sel = selection as any;
  let ranges: StaticRange[];
  try {
    ranges = sel.getComposedRanges({ shadowRoots: [root] });
  } catch {
    try {
      // older Safari only takes the shadow roots as arguments
      ranges = sel.getComposedRanges(root);
    } catch {
      return null;
    }
  }
  return ranges?.[0] || null;
}

/**
 * Gets the selection's first range with its boundaries inside the element's
 * shadow tree. Safari has no ShadowRoot.getSelection and retargets the window
 * selection's ranges to the shadow host, so there the range is read through
 * getComposedRanges instead.
 */
export function getSelectionRange(element: HTMLElement): AbstractRange | null {
  const selection = getSelectionFromRoot(element);
  if (!selection || selection.rangeCount === 0) return null;

  const root = element.getRootNode();
  if (
    root instanceof ShadowRoot &&
    !(root as any).getSelection &&
    (selection as any).getComposedRanges
  ) {
    return getComposedRange(selection, root);
  }
  return selection.getRangeAt(0);
}

/**
 * Selects between two DOM positions. Uses setBaseAndExtent because Safari
 * ignores addRange for ranges inside a shadow tree, and clearing the
 * selection first would drop the caret from the editor.
 */
function select(
  element: HTMLElement,
  start: { node: Node; offset: number },
  end: { node: Node; offset: number }
): void {
  const selection = getSelectionFromRoot(element);
  if (!selection) return;
  selection.setBaseAndExtent(start.node, start.offset, end.node, end.offset);
}

function isSentinelBr(node: Node): boolean {
  return (
    node.nodeName === 'BR' &&
    typeof (node as Element).hasAttribute === 'function' &&
    (node as Element).hasAttribute('data-sentinel')
  );
}

function isBlockElement(node: Node): boolean {
  return node.nodeName === 'DIV' || node.nodeName === 'P';
}

/** Plain-text contribution of a node and its descendants. */
function textOfNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent || '';
  }
  if (node.nodeName === 'BR') {
    return isSentinelBr(node) ? '' : '\n';
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return '';
  }
  return textOfChildren(node);
}

/** Plain-text contribution of an element's children, with block-prefix \n. */
function textOfChildren(parent: Node): string {
  let text = '';
  let hasContent = false;
  for (const child of Array.from(parent.childNodes)) {
    if (
      child.nodeType === Node.ELEMENT_NODE &&
      isBlockElement(child) &&
      hasContent
    ) {
      text += '\n';
    }
    const piece = textOfNode(child);
    text += piece;
    if (piece.length > 0) {
      hasContent = true;
    }
  }
  return text;
}

/** Converts a DOM selection position (container + offset) to a plain-text offset. */
function domPositionToTextOffset(
  root: Node,
  targetContainer: Node,
  targetOffset: number
): number {
  // Build the text from `root` up to (target, targetOffset) and return its
  // length. This mirrors textOfChildren so block-prefix newlines and BR
  // newlines are accounted for the same way when reading and writing.
  let text = '';
  let stopped = false;

  const walk = (node: Node): void => {
    if (stopped) return;

    if (node === targetContainer) {
      if (node.nodeType === Node.TEXT_NODE) {
        text += (node.textContent || '').substring(0, targetOffset);
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const children = Array.from(node.childNodes);
        let hasContent = false;
        for (let i = 0; i < Math.min(targetOffset, children.length); i++) {
          const child = children[i];
          if (
            child.nodeType === Node.ELEMENT_NODE &&
            isBlockElement(child) &&
            hasContent
          ) {
            text += '\n';
          }
          const piece = textOfNode(child);
          text += piece;
          if (piece.length > 0) hasContent = true;
        }
      }
      stopped = true;
      return;
    }

    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent || '';
      return;
    }
    if (node.nodeName === 'BR') {
      if (!isSentinelBr(node)) text += '\n';
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }

    let hasContent = false;
    for (const child of Array.from(node.childNodes)) {
      if (stopped) break;
      if (
        child.nodeType === Node.ELEMENT_NODE &&
        isBlockElement(child) &&
        hasContent
      ) {
        text += '\n';
      }
      const before = text.length;
      walk(child);
      if (stopped) break;
      if (text.length > before) hasContent = true;
    }
  };

  walk(root);
  return text.length;
}

/** Converts a plain-text offset to a DOM position (node + offset). */
function textOffsetToDomPosition(
  root: Node,
  targetOffset: number
): { node: Node; offset: number } | null {
  let remaining = targetOffset;
  // Track the last text node passed through so we can fall back to its end
  // when the offset sits past all text content.
  let lastTextNode: Node | null = null;
  let lastTextOffset = 0;
  let result: { node: Node; offset: number } | null = null;

  const walk = (node: Node, parent: Node | null): void => {
    if (result !== null) return;

    if (node.nodeType === Node.TEXT_NODE) {
      const len = node.textContent.length;
      // Use strict "<" so positions at the boundary between two text nodes
      // resolve to the START of the next node rather than the END of the
      // previous one. Firefox doesn't paint the caret reliably when it lands
      // at the end of an inline span whose text is just "\n", but happily
      // renders it at the start of the following node.
      if (remaining < len) {
        result = { node, offset: remaining };
        return;
      }
      lastTextNode = node;
      lastTextOffset = len;
      remaining -= len;
      return;
    }

    if (node.nodeName === 'BR') {
      if (isSentinelBr(node)) return;
      if (remaining === 0 && parent) {
        const idx = Array.from(parent.childNodes).indexOf(node as ChildNode);
        if (idx >= 0) {
          result = { node: parent, offset: idx };
          return;
        }
      }
      remaining -= 1;
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }

    let hasContent = false;
    for (const child of Array.from(node.childNodes)) {
      if (result !== null) return;
      if (
        child.nodeType === Node.ELEMENT_NODE &&
        isBlockElement(child) &&
        hasContent
      ) {
        if (remaining === 0) {
          const idx = Array.from(node.childNodes).indexOf(child as ChildNode);
          if (idx >= 0) {
            result = { node, offset: idx };
            return;
          }
        }
        remaining -= 1;
      }
      const before = remaining;
      walk(child, node);
      if (result !== null) return;
      if (remaining < before) hasContent = true;
    }
  };

  walk(root, null);
  if (result) return result;

  if (remaining === 0) {
    // Past all content. If the editor ends in a <br>, position relative to it
    // so the caret renders on the empty trailing line in Firefox.
    const lastChild = root.lastChild;
    if (lastChild && lastChild.nodeName === 'BR') {
      // Sentinel: render before it. Non-sentinel (transient post-yank state):
      // render after it so the caret sits on the empty line the BR produces.
      const offset = isSentinelBr(lastChild)
        ? root.childNodes.length - 1
        : root.childNodes.length;
      return { node: root, offset };
    }
    if (lastTextNode) {
      return { node: lastTextNode, offset: lastTextOffset };
    }
  }
  return null;
}

/**
 * Extracts plain text from the contenteditable DOM. Translates non-sentinel
 * <br> elements to "\n" and inserts a "\n" before block-level (DIV/P) children
 * that follow other content, so yank/paste-inserted DOM structures round-trip
 * through handleInput correctly.
 */
export function getTextFromEditableDiv(element: HTMLElement): string {
  return textOfChildren(element);
}

/** Gets the caret (selection start) as a plain-text offset. */
export function getCaretOffset(element: HTMLElement): number {
  const range = getSelectionRange(element);
  if (!range) return 0;
  return domPositionToTextOffset(
    element,
    range.startContainer,
    range.startOffset
  );
}

/** Gets the selection end as a plain-text offset. */
export function getCaretEndOffset(element: HTMLElement): number {
  const range = getSelectionRange(element);
  if (!range) return 0;
  return domPositionToTextOffset(element, range.endContainer, range.endOffset);
}

/** Sets the caret to a plain-text offset. */
export function setCaretOffset(element: HTMLElement, offset: number): void {
  const pos = textOffsetToDomPosition(element, offset);
  if (!pos) return;
  select(element, pos, pos);
}

/** Sets a selection range by plain-text offsets. */
export function setCaretRange(
  element: HTMLElement,
  start: number,
  end: number
): void {
  const startPos = textOffsetToDomPosition(element, start);
  const endPos = textOffsetToDomPosition(element, end);
  if (!startPos || !endPos) return;
  select(element, startPos, endPos);
}
