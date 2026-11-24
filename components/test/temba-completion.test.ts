import { fixture, assert } from '@open-wc/testing';
import { Completion } from '../src/form/Completion';
import { loadStore } from './utils.test';
import { serialize } from '../src/utils';

export const getHTML = () => {
  return `<temba-completion></temba-completion>`;
};

describe('temba-completion', () => {
  it('can be created', async () => {
    const completion: Completion = await fixture(getHTML());
    assert.instanceOf(completion, Completion);
  });

  it('shows the function being called in an expression', async () => {
    await loadStore();
    const completion: Completion = await fixture(getHTML());

    const input = completion.getTextInput().inputElement;
    input.value = '@(upper(contact';
    input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    await completion.updateComplete;

    assert.equal(completion.currentFunction.signature, 'upper(text)');
    const hint = completion.shadowRoot.querySelector('.current-fn');
    assert.include(hint.textContent, 'to uppercase');
  });

  it('submits its value once in a form', async () => {
    const form: HTMLFormElement = await fixture(
      '<form><temba-completion name="text" value="hello"></temba-completion></form>'
    );
    const completion = form.querySelector('temba-completion') as Completion;
    await completion.updateComplete;

    assert.deepEqual([...new FormData(form).entries()], [['text', 'hello']]);
    assert.equal(serialize(form), 'text=hello');

    completion.value = 'changed';
    await completion.updateComplete;

    assert.deepEqual([...new FormData(form).entries()], [['text', 'changed']]);
    assert.equal(serialize(form), 'text=changed');
  });
});
