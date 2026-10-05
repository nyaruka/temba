import { html, TemplateResult } from 'lit';

import ExcellentParser, { Expression } from './ExcellentParser';
import {
  CompletionOption,
  CompletionProperty,
  CompletionResult,
  CompletionSchema,
  CompletionType
} from '../interfaces';
import { getStore, Store } from '../store/Store';
import { renderMarkdownInline } from '../markdown';

export const messageParser = new ExcellentParser('@', [
  'contact',
  'fields',
  'globals',
  'urns'
]);

export const sessionParser = new ExcellentParser('@', [
  'contact',
  'fields',
  'globals',
  'locals',
  'urns',
  'results',
  'input',
  'run',
  'child',
  'parent',
  'node',
  'webhook',
  'ticket',
  'trigger',
  'resume'
]);

export const renderCompletionOption = (
  option: CompletionOption,
  selected: boolean
): TemplateResult => {
  if (option.signature) {
    const argStart = option.signature.indexOf('(');
    const name = option.signature.substr(0, argStart);
    const args = option.signature.substr(argStart);

    return html`
      <div style="${selected ? 'font-weight: 400' : ''}">
        <div style="display:inline-block;margin-right: 5px">ƒ</div>
        <div style="display:inline-block">${name}</div>
        ${selected
          ? html`
              <div
                style="display:inline-block; font-weight: 300; font-size: 85%"
              >
                ${args}
              </div>
              <div class="detail">${renderMarkdownInline(option.summary)}</div>
            `
          : null}
      </div>
    `;
  }

  return html`
    <div>
      <div style="${selected ? 'font-weight: 400' : ''}">${option.name}</div>
      ${selected
        ? html` <div style="font-size: 85%">${option.summary}</div> `
        : null}
    </div>
  `;
};

export const getFunctions = (
  functions: CompletionOption[],
  query: string
): CompletionOption[] => {
  if (!query) {
    return functions;
  }
  return functions.filter((option: CompletionOption) => {
    if (option.signature) {
      return option.signature.indexOf((query || '').toLowerCase()) === 0;
    }
    return false;
  });
};

/**
 * Takes a dot query and returns the completions options at the current level
 * @param dotQuery query such as "contact.first_n"
 */
export const getCompletions = (
  schema: CompletionSchema,
  dotQuery: string,
  session: boolean,
  store: Store
): CompletionOption[] => {
  const parts = (dotQuery || '').split('.');
  let currentProps: CompletionProperty[] = session
    ? schema.root
    : schema.root_no_session;

  if (!currentProps) {
    return [];
  }

  let prefix = '';
  let part = '';
  while (parts.length > 0) {
    part = parts.shift();
    if (part) {
      // eslint-disable-next-line
      const nextProp = currentProps.find(
        (prop: CompletionProperty) => prop.key === part
      );
      if (nextProp) {
        // eslint-disable-next-line
        const nextType = schema.types.find(
          (type: CompletionType) => type.name === nextProp.type
        );
        if (nextType && nextType.properties) {
          currentProps = nextType.properties;
          prefix += part + '.';
        } else if (nextType && nextType.property_template) {
          prefix += part + '.';
          const template = nextType.property_template;

          const keys = store.getCompletions(nextType.name);
          if (keys) {
            currentProps = keys.map((key: string) => ({
              key: template.key.replace('{key}', key),
              help: template.help.replace('{key}', key),
              type: template.type
            }));
          } else {
            currentProps = [];
          }
        } else {
          // eslint-disable-next-line
          currentProps = currentProps.filter((prop: CompletionProperty) =>
            prop.key.startsWith(part.toLowerCase())
          );
          break;
        }
      } else {
        // eslint-disable-next-line
        currentProps = currentProps.filter((prop: CompletionProperty) =>
          prop.key.startsWith(part.toLowerCase())
        );
        break;
      }
    }
  }

  return currentProps.map((prop: CompletionProperty) => {
    const name =
      prop.key === '__default__'
        ? prefix.substr(0, prefix.length - 1)
        : prefix + prop.key;
    return { name, summary: prop.help };
  });
};

export const getOffset = (el: HTMLElement) => {
  const rect = el.getBoundingClientRect(),
    scrollLeft = window.pageXOffset || document.documentElement.scrollLeft,
    scrollTop = window.pageYOffset || document.documentElement.scrollTop;
  return { top: rect.top + scrollTop, left: rect.left + scrollLeft };
};

export const getVerticalScroll = (ele: Node) => {
  let current = ele;
  const verticalScroll = 0;
  while (current) {
    current = current.parentNode;
  }
  return verticalScroll;
};

export const getCompletionName = (option: CompletionOption): string => {
  return (
    option.name || option.signature.substr(0, option.signature.indexOf('('))
  );
};

export const getCompletionSignature = (option: CompletionOption): string => {
  return option.signature.substr(option.signature.indexOf('('));
};

/**
 * Determines the pixel position of a character position inside an input element.
 * For contenteditable elements, uses the Selection API directly.
 * For textarea/input, uses a mirror-div technique.
 */
const getCursorXY = (input, selectionPoint) => {
  // For contenteditable elements, use Selection API
  if (input.isContentEditable) {
    return getCursorXYContentEditable(input, selectionPoint);
  }

  const { offsetLeft: inputX, offsetTop: inputY } = input;
  const div = document.createElement('div');
  const copyStyle = getComputedStyle(input);
  for (const prop of copyStyle) {
    div.style[prop] = copyStyle[prop];
  }
  div.style.position = 'relative';
  const swap = '.';
  const inputValue =
    input.tagName === 'INPUT' ? input.value.replace(/ /g, swap) : input.value;
  const textContent = inputValue.substr(0, selectionPoint);
  div.textContent = textContent;
  if (input.tagName === 'TEXTAREA') div.style.height = 'auto';
  if (input.tagName === 'INPUT') div.style.width = 'auto';
  const span = document.createElement('span');
  span.textContent = inputValue.substr(selectionPoint) || '.';
  div.appendChild(span);
  document.body.appendChild(div);
  const { offsetLeft: spanX, offsetTop: spanY } = span;
  document.body.removeChild(div);
  return {
    left: inputX + spanX,
    top: inputY + spanY
  };
};

/**
 * Finds the DOM position (node + offset) for a given plain-text offset.
 * Newlines are \n characters inside text nodes (tok-newline spans).
 * Browser-added <br> artifacts are ignored.
 */
const findDomPosition = (root, targetOffset) => {
  let remaining = targetOffset;

  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      if (remaining <= node.textContent.length) {
        return { node, offset: remaining };
      }
      remaining -= node.textContent.length;
      return null;
    }

    // Ignore browser-added <br> artifacts
    if (node.nodeName === 'BR') {
      return null;
    }

    for (const child of node.childNodes) {
      const result = walk(child);
      if (result) return result;
    }
    return null;
  };

  return walk(root);
};

/**
 * Gets cursor pixel position in a contenteditable element by creating a range
 * at the target offset and measuring with getBoundingClientRect.
 */
const getCursorXYContentEditable = (element, offset) => {
  const pos = findDomPosition(element, offset);

  if (!pos) {
    // Offset is beyond the text — use element bounds
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top };
  }

  // Create a range at the target position and measure it
  const range = document.createRange();
  range.setStart(pos.node, pos.offset);
  range.collapse(true);
  const rect = range.getBoundingClientRect();

  return {
    left: rect.left - element.getBoundingClientRect().left + element.offsetLeft,
    top: rect.top - element.getBoundingClientRect().top + element.offsetTop
  };
};

export const updateInputElementWithCompletion = (
  currentQuery: string,
  ele: HTMLInputElement,
  option: CompletionOption
) => {
  let insertText = '';

  if (option.signature) {
    // they selected a function
    insertText = option.signature.substr(0, option.signature.indexOf('(') + 1);
  } else {
    insertText = option.name;
  }

  const queryLength = currentQuery.length;

  if (ele) {
    const value = ele.value;
    const insertionPoint = ele.selectionStart - queryLength;

    // strip out our query
    // const insertionPoint = value.lastIndexOf(value.substring(0, this.inputElement.selectionStart));
    const leftSide = value.substr(0, insertionPoint);
    const remaining = value.substr(insertionPoint + queryLength);
    const caret = leftSide.length + insertText.length;

    // set our value and our new caret
    ele.value = leftSide + insertText + remaining;
    ele.setSelectionRange(caret, caret);

    // now scroll our text box if necessary
    const position = getCursorXY(ele, caret);
    if (position.left > ele.width) {
      ele.scrollLeft = position.left;
    }

    ele.dispatchEvent(new Event('input'));
  }
};

export const executeCompletionQuery = (
  ele: HTMLInputElement,
  session: boolean
): CompletionResult => {
  const result: CompletionResult = {
    currentFunction: null,
    options: [],
    anchorPosition: null,
    query: null
  };

  if (!ele) {
    return;
  }

  const store = getStore();

  // we need a store to do anything useful
  if (!store) {
    return result;
  }

  const cursor = ele.selectionStart;
  const fullValue = ele.value;

  // Don't show completions when cursor is in the middle of a word
  const charAfterCursor = fullValue[cursor];
  if (charAfterCursor && /[\w.]/.test(charAfterCursor)) {
    return result;
  }

  const input = fullValue.substring(0, cursor);

  const parser = session ? sessionParser : messageParser;
  const expressions = parser.findExpressions(input);
  const currentExpression = expressions.find(
    (expr: Expression) =>
      expr.start <= cursor &&
      (expr.end > cursor || (expr.end === cursor && !expr.closed))
  );

  if (currentExpression) {
    const includeFunctions = currentExpression.text.indexOf('(') > -1;
    if (includeFunctions) {
      const functionQuery = parser.functionContext(currentExpression.text);
      if (functionQuery) {
        const fns = getFunctions(store.getFunctions(), functionQuery);
        if (fns.length > 0) {
          result.currentFunction = fns[0];
        }
      }
    }

    for (let i = currentExpression.text.length; i >= 0; i--) {
      const curr = currentExpression.text[i];
      if (
        curr === '@' ||
        curr === '(' ||
        curr === ' ' ||
        curr === ',' ||
        curr === ')' ||
        i === 0
      ) {
        // don't include non-expression chars
        if (
          curr === '(' ||
          curr === ' ' ||
          curr === ',' ||
          curr === ')' ||
          curr === '@'
        ) {
          i++;
        }

        const caret = getCursorXY(ele, currentExpression.start + i);

        result.anchorPosition = {
          left: caret.left - 2 - ele.scrollLeft,
          top: caret.top - ele.scrollTop
        };

        result.query = currentExpression.text.substr(
          i,
          currentExpression.text.length - i
        );

        result.options = [
          ...getCompletions(
            store.getCompletionSchema(),
            result.query,

            session,
            store
          ),
          ...(includeFunctions
            ? getFunctions(store.getFunctions(), result.query)
            : [])
        ];

        // Don't show completion when the query is already an exact match
        // for the only option (e.g. cursor at end of a complete function name)
        if (result.options.length === 1) {
          const opt = result.options[0];
          const optName = (
            opt.name ||
            opt.signature?.substring(0, opt.signature.indexOf('(')) ||
            ''
          ).toLowerCase();
          if (optName === result.query.toLowerCase()) {
            result.options = [];
          }
        }

        return result;
      }
    }
  } else {
    result.options = [];
    result.query = '';
  }
  return result;
};
