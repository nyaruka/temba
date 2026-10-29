import Sinon, * as sinon from 'sinon';
import { fixture, expect, assert } from '@open-wc/testing';
import { useFakeTimers } from 'sinon';
import { Options } from '../src/display/Options';
import { Select, SelectOption } from '../src/form/select/Select';
import {
  assertScreenshot,
  getClip,
  getOptions,
  loadStore,
  openAndClick,
  openSelect,
  waitForSelectPagination
} from './utils.test';

const colors = [
  { name: 'Red', value: '0' },
  { name: 'Green', value: '1' },
  { name: 'Blue', value: '2' }
];

export const createSelect = async (clock, def: string) => {
  const parentNode = document.createElement('div');
  parentNode.setAttribute('style', 'width: 400px;');

  const select: Select<SelectOption> = await fixture(def, { parentNode });
  clock.runAll();
  await select.updateComplete;
  return select;
};

export const clear = (select: Select<SelectOption>) => {
  (select.shadowRoot.querySelector('.clear-button') as HTMLDivElement).click();
};

export const getSelectHTML = (
  options: SelectOption[] = colors,
  attrs: any = { placeholder: 'Select a color', name: 'color' },
  selected: any = null
): string => {
  const selectHTML = `
  <temba-select${Object.keys(attrs)
    .map((name: string) => {
      // check if it's a string attribute
      if (typeof attrs[name] === 'string') {
        return ` ${name}="${attrs[name].replace(/"/g, '&quot;')}"`;
      }

      if (typeof attrs[name] === 'boolean') {
        return ` ${name}`;
      }

      return ` ${name}="${attrs[name]}"`;
    })
    .join(' ')}>
    ${options
      .map(
        (option) =>
          `<temba-option name="${option.name}" value="${option.value}"${
            option.selected || option.value === selected ? ' selected' : ''
          }></temba-option>`
      )
      .join('')}
  </temba-select>`;
  return selectHTML;
};

const getClipWithOptions = (select: Select<any>) => {
  const selectClip = getClip(select);
  const options = select.shadowRoot.querySelector(
    'temba-options[visible]'
  ) as Options;

  if (options) {
    const optionsClip = getClip(options);
    const y = Math.min(selectClip.y, optionsClip.y);
    const x = Math.min(selectClip.x, optionsClip.x);
    const combinedClip = {
      y,
      x,
      width: Math.max(selectClip.right, optionsClip.right) - x,
      height: Math.max(selectClip.bottom, optionsClip.bottom) - y
    };
    return combinedClip;
  }

  return selectClip;
};

describe('temba-select', () => {
  let clock: Sinon.SinonFakeTimers;
  beforeEach(function () {
    clock = useFakeTimers();
    clock.tick(400);
    setViewport({ width: 500, height: 1000, deviceScaleFactor: 2 });
  });

  afterEach(function () {
    clock.restore();
  });

  it('can be created', async () => {
    const select = await createSelect(clock, '<temba-select></temba-select>');
    assert.instanceOf(select, Select);
  });

  it('can be disabled', async () => {
    const select = await createSelect(
      clock,
      getSelectHTML(colors, { disabled: true })
    );

    expect(select.disabled).to.equal(true);
    await assertScreenshot('select/disabled', getClip(select));
  });

  it('can be disabled with selection', async () => {
    const select = await createSelect(
      clock,
      getSelectHTML(colors, { disabled: true, value: '0' })
    );

    expect(select.disabled).to.equal(true);
    await assertScreenshot('select/disabled-selection', getClip(select));
  });

  it('can be disabled with multi selection', async () => {
    const select = await createSelect(
      clock,
      getSelectHTML(colors, { placeholder: 'Select a color', multi: true })
    );

    await openAndClick(clock, select, 0);
    select.disabled = true;
    expect(select.disabled).to.equal(true);

    // make sure we can't select anymore
    await openSelect(clock, select);
    expect(select.isOpen()).to.equal(false);
    await assertScreenshot('select/disabled-multi-selection', getClip(select));
  });

  it('can be created with temba-option tags', async () => {
    const select = await createSelect(clock, getSelectHTML());
    assert.equal(select.getStaticOptions().length, 3);
    expect(select.values.length).to.equal(0);
    await assertScreenshot('select/with-placeholder', getClip(select));
  });

  it('picks the first option without a placeholder', async () => {
    const select = await createSelect(clock, getSelectHTML(colors, {}));
    assert.equal(select.getStaticOptions().length, 3);
    expect(select.values[0].name).to.equal('Red');
    await assertScreenshot('select/without-placeholder', getClip(select));
  });

  it('does not pick the first option for clearable selects', async () => {
    const select = await createSelect(
      clock,
      getSelectHTML(colors, { clearable: true })
    );
    assert.equal(select.getStaticOptions().length, 3);
    expect(select.values.length).to.equal(0);
  });

  it('keeps initial selection for multi selects', async () => {
    const select = await createSelect(
      clock,
      getSelectHTML(colors, { multi: true }, '1')
    );
    expect(select.values.length).to.equal(1);
    expect(select.values[0].name).to.equal('Green');
  });

  it('does not pick the first option for multi selects', async () => {
    const select = await createSelect(
      clock,
      getSelectHTML(colors, { multi: true })
    );
    assert.equal(select.getStaticOptions().length, 3);
    expect(select.values.length).to.equal(0);

    // removing the only selection should leave the select empty
    await openAndClick(clock, select, 0);
    expect(select.values.length).to.equal(1);
    select.removeValue(select.values[0]);
    clock.runAll();
    await select.updateComplete;
    expect(select.values.length).to.equal(0);
  });

  it('shows options when opened', async () => {
    const select = await createSelect(clock, getSelectHTML());
    await openSelect(clock, select);
    const options = getOptions(select);
    assert.instanceOf(options, Options);

    // our options should be visible
    assert.isTrue(
      options.shadowRoot
        .querySelector('.options-container')
        .classList.contains('show')
    );

    await assertScreenshot('select/local-options', getClipWithOptions(select));
  });

  it('can be created with attribute options', async () => {
    const options = JSON.stringify([{ name: 'Embedded Option', value: '0' }]);
    const select = await createSelect(clock, getSelectHTML([], { options }));
    // select the first option
    await openAndClick(clock, select, 0);
    expect(select.values[0].name).to.equal('Embedded Option');
    await assertScreenshot('select/embedded', getClipWithOptions(select));
  });

  it('shows no options message when opening with empty options', async () => {
    const select = await createSelect(
      clock,
      getSelectHTML([], { placeholder: 'Select an option' })
    );

    // attempt to open the select with no options
    await openSelect(clock, select);

    // should show options dropdown even though there are no options
    const options = getOptions(select);
    assert.instanceOf(options, Options);

    // the options dropdown should be visible
    assert.isTrue(
      options.shadowRoot
        .querySelector('.options-container')
        .classList.contains('show')
    );

    // should contain a "No options" message
    const noOptionsText = options.shadowRoot.textContent;
    assert.include(noOptionsText.toLowerCase(), 'no options');

    await assertScreenshot('select/empty-options', getClipWithOptions(select));
  });

  describe('single selection', () => {
    it('can select a single option', async () => {
      const select = await createSelect(clock, getSelectHTML());

      // nothing is selected to start
      expect(select.values.length).to.equal(0);
      expect(select.value).to.equal(null);

      // select the first option
      const changeEvent = sinon.spy();
      select.addEventListener('change', changeEvent);
      await openAndClick(clock, select, 0);

      assert(changeEvent.called, 'change event not fired');
      expect(select.values.length).to.equal(1);
      expect(select.values[0].name).to.equal('Red');
      expect(select.shadowRoot.innerHTML).to.contain('Red');

      await assertScreenshot(
        'select/selected-single',
        getClipWithOptions(select)
      );
    });

    it('can search with existing selection', async () => {
      const select = await createSelect(
        clock,
        getSelectHTML(colors, { searchable: true })
      );

      // select the second option
      await openAndClick(clock, select, 1);
      expect(select.values.length).to.equal(1);
      expect(select.values[0].name).to.equal('Green');

      // for single selection our current selection should be in the list and focused
      await openSelect(clock, select);
      assert.equal(select.cursorIndex, 1);
      assert.equal(select.visibleOptions.length, 3);

      // now lets do a search, we should see our selection (green) and one other (red)
      await typeInto('temba-select', 're', false);
      await openSelect(clock, select);
      assert.equal(select.visibleOptions.length, 2);

      await assertScreenshot(
        'select/search-with-selected',
        getClipWithOptions(select)
      );

      // but our cursor should be on the first match
      assert.equal(select.cursorIndex, 0);
    });

    it('single-mode selected-item flexes to fill its container', async () => {
      // Needed so custom renderOption content can right-align trailing
      // elements (e.g. status badges) in the closed/selected state.
      const select = await createSelect(
        clock,
        getSelectHTML(colors, { value: '1' })
      );
      const selectedItem = select.shadowRoot.querySelector(
        '.selected-item'
      ) as HTMLElement;
      expect(selectedItem).to.not.be.null;
      const computed = window.getComputedStyle(selectedItem);
      expect(computed.flexGrow).to.equal('1');
    });
  });

  describe('multiple selection', () => {
    it('can select multiple options', async () => {
      const select = await createSelect(
        clock,
        getSelectHTML(colors, { placeholder: 'Select a color', multi: true })
      );
      expect(select.values.length).to.equal(0);

      const changeEvent = sinon.spy();
      select.addEventListener('change', changeEvent);

      // select the first option twice
      await openAndClick(clock, select, 0);
      assert(changeEvent.called, 'change event not fired');

      changeEvent.resetHistory();
      await openAndClick(clock, select, 0);
      assert(changeEvent.called, 'change event not fired');

      // now we should have red and green selected
      expect(select.values.length).to.equal(2);
      expect(select.shadowRoot.innerHTML).to.contain('Red');
      expect(select.shadowRoot.innerHTML).to.contain('Green');

      await assertScreenshot(
        'select/selected-multi',
        getClipWithOptions(select)
      );
    });

    it('can select multiple options until maxitems', async () => {
      const select = await createSelect(
        clock,
        getSelectHTML(colors, {
          placeholder: 'Select a color',
          multi: true,
          maxItems: 2
        })
      );
      expect(select.values.length).to.equal(0);

      const changeEvent = sinon.spy();
      select.addEventListener('change', changeEvent);

      // select the first option 3 times, only 2 (maxitems) options are handled and added
      await openAndClick(clock, select, 0);
      assert(changeEvent.called, 'change event not fired');

      changeEvent.resetHistory();
      await openAndClick(clock, select, 0);
      assert(changeEvent.called, 'change event not fired');

      changeEvent.resetHistory();
      await openSelect(clock, select);
      assert.equal(select.visibleOptions.length, 0);
      assert(!changeEvent.called, 'change event should not be fired');

      // but we should have red and green selected only, no blue
      expect(select.values.length).to.equal(2);
      expect(select.shadowRoot.innerHTML).to.contain('Red');
      expect(select.shadowRoot.innerHTML).to.contain('Green');

      await assertScreenshot(
        'select/selected-multi-maxitems-reached',
        getClipWithOptions(select)
      );
    });

    it('shows multiple values on initialization', async () => {
      const select = await createSelect(
        clock,
        getSelectHTML(
          [
            { name: 'Red', value: '0' },
            { name: 'Green', value: '1', selected: true },
            { name: 'Blue', value: '2', selected: true }
          ],
          {
            placeholder: 'Select a color',
            multi: true
          }
        )
      );
      await assertScreenshot('select/multiple-initial-values', getClip(select));
      expect(select.values.length).to.equal(2);
    });
  });

  describe('drag and drop reordering', () => {
    it('handles drag and drop with swap-based logic', async () => {
      const select = await createSelect(
        clock,
        getSelectHTML(
          [
            { name: 'Red', value: '0', selected: true },
            { name: 'Green', value: '1', selected: true },
            { name: 'Blue', value: '2', selected: true }
          ],
          {
            placeholder: 'Select colors',
            multi: true
          }
        )
      );

      // Verify initial order: Red, Green, Blue
      expect(select.values.length).to.equal(3);
      expect(select.values[0].name).to.equal('Red');
      expect(select.values[1].name).to.equal('Green');
      expect(select.values[2].name).to.equal('Blue');

      const sortableList = select.shadowRoot.querySelector(
        'temba-sortable-list'
      );
      expect(sortableList).to.not.be.null;

      // Example 1: Pick up Blue (index 2), drop between Red and Green
      // Expected result: Red, Blue, Green (swap [1,2])
      const blueItem = sortableList.querySelector('#selected-2');
      const greenItem = sortableList.querySelector('#selected-1');
      expect(blueItem).to.not.be.null;
      expect(greenItem).to.not.be.null;

      const blueBounds = blueItem.getBoundingClientRect();
      const greenBounds = greenItem.getBoundingClientRect();

      // Start drag from Blue item
      await moveMouse(blueBounds.left + 10, blueBounds.top + 10);
      await mouseDown();

      // Drag to position between Red and Green (left side of Green)
      await moveMouse(greenBounds.left - 5, greenBounds.top + 10);
      await waitFor(100);
      await mouseUp();
      clock.runAll();

      // Verify result: Red, Blue, Green (Green and Blue swapped)
      expect(select.values.length).to.equal(3);
      expect(select.values[0].name).to.equal('Red');
      expect(select.values[1].name).to.equal('Blue');
      expect(select.values[2].name).to.equal('Green');

      // Reset for next test
      select.values = [
        { name: 'Red', value: '0', selected: true },
        { name: 'Green', value: '1', selected: true },
        { name: 'Blue', value: '2', selected: true }
      ];
      await select.updateComplete;

      // Example 2: Pick up Red (index 0), drop at end
      // Expected result: Green, Blue, Red (swap [0,2])
      const redItem = sortableList.querySelector('#selected-0');
      const redBounds = redItem.getBoundingClientRect();
      const blueItemBounds = sortableList
        .querySelector('#selected-2')
        .getBoundingClientRect();

      // Start drag from Red item
      await moveMouse(redBounds.left + 10, redBounds.top + 10);
      await mouseDown();

      // Drag to end position (right side of Blue)
      await moveMouse(blueItemBounds.right + 5, blueItemBounds.top + 10);
      await waitFor(100);
      await mouseUp();
      clock.runAll();

      // Verify result: Green, Blue, Red (Red and Blue swapped)
      expect(select.values.length).to.equal(3);
      expect(select.values[0].name).to.equal('Green');
      expect(select.values[1].name).to.equal('Blue');
      expect(select.values[2].name).to.equal('Red');

      // Reset for next test
      select.values = [
        { name: 'Red', value: '0', selected: true },
        { name: 'Green', value: '1', selected: true },
        { name: 'Blue', value: '2', selected: true }
      ];
      await select.updateComplete;

      // Example 3: Pick up Green (index 1), drop at same position
      // Expected result: No change, no event
      const greenItemNew = sortableList.querySelector('#selected-1');
      const greenBoundsNew = greenItemNew.getBoundingClientRect();

      // Start drag from Green item
      await moveMouse(greenBoundsNew.left + 10, greenBoundsNew.top + 10);
      await mouseDown();

      // Drag slightly but return to same position
      await moveMouse(greenBoundsNew.left + 15, greenBoundsNew.top + 10);
      await moveMouse(greenBoundsNew.left + 10, greenBoundsNew.top + 10);
      await waitFor(100);
      await mouseUp();
      clock.runAll();

      // Verify result: No change
      expect(select.values.length).to.equal(3);
      expect(select.values[0].name).to.equal('Red');
      expect(select.values[1].name).to.equal('Green');
      expect(select.values[2].name).to.equal('Blue');
    });

    it('does not show sortable list for single item', async () => {
      const select = await createSelect(
        clock,
        getSelectHTML([{ name: 'Red', value: '0', selected: true }], {
          placeholder: 'Select a color',
          multi: true
        })
      );

      // Should not have a sortable list with only one item
      const sortableList = select.shadowRoot.querySelector(
        'temba-sortable-list'
      );
      expect(sortableList).to.be.null;

      // Should still show the selected item normally
      expect(select.values.length).to.equal(1);
      expect(select.values[0].name).to.equal('Red');
    });

    it('does not show sortable list for non-multi select', async () => {
      const select = await createSelect(
        clock,
        getSelectHTML([{ name: 'Red', value: '0', selected: true }], {
          placeholder: 'Select a color',
          multi: false
        })
      );

      // Should not have a sortable list for single select
      const sortableList = select.shadowRoot.querySelector(
        'temba-sortable-list'
      );
      expect(sortableList).to.be.null;

      expect(select.values.length).to.equal(1);
      expect(select.values[0].name).to.equal('Red');
    });
  });

  describe('tags functionality', () => {
    it('shows selected item text when typing second tag', async () => {
      const select = await createSelect(
        clock,
        getSelectHTML([], {
          placeholder: 'Enter tags',
          multi: true,
          searchable: true,
          tags: true
        })
      );

      // Add first tag programmatically (simulating user adding first tag)
      select.addValue({ name: 'Yes', value: 'Yes' });
      await select.updateComplete;
      expect(select.values.length).to.equal(1);
      expect(select.values[0].name).to.equal('Yes');

      // Check that the first tag is displayed with text
      let selectedItems = select.shadowRoot.querySelectorAll('.selected-item');
      expect(selectedItems.length).to.equal(1);
      expect(selectedItems[0].textContent).to.contain('Yes');

      // Start typing second tag (this should not hide the first tag's text)
      await typeInto('temba-select', 'No', false, false);

      // Check that first tag text is still visible while typing second tag
      selectedItems = select.shadowRoot.querySelectorAll('.selected-item');
      expect(selectedItems.length).to.equal(1);

      // The selected item should still contain the text "Yes"
      const firstItemText = selectedItems[0].textContent;
      expect(firstItemText).to.contain('Yes');
    });

    it('hides selected item text when typing in single-select mode', async () => {
      const select = await createSelect(
        clock,
        getSelectHTML(colors, {
          placeholder: 'Select a color',
          searchable: true
        })
      );

      // Select an option first
      await openAndClick(clock, select, 0); // Select Red
      expect(select.values.length).to.equal(1);
      expect(select.values[0].name).to.equal('Red');

      // Check that the selected item is displayed with text when not typing
      let selectedItems = select.shadowRoot.querySelectorAll('.selected-item');
      expect(selectedItems.length).to.equal(1);
      expect(selectedItems[0].textContent).to.contain('Red');

      // Start typing in the search box
      await typeInto('temba-select', 'gr', false, false);

      // Check that selected item text is hidden while typing (preserving single-select behavior)
      selectedItems = select.shadowRoot.querySelectorAll('.selected-item');
      expect(selectedItems.length).to.equal(1);

      // The selected item should NOT contain the text "Red" when typing
      const itemText = selectedItems[0].textContent.trim();
      expect(itemText).to.not.contain('Red');
    });

    it('shows enter hint when text is typed', async () => {
      const select = await createSelect(
        clock,
        getSelectHTML([], {
          placeholder: 'Enter tags',
          multi: true,
          searchable: true,
          tags: true
        })
      );

      // No hint before typing
      let hint = select.shadowRoot.querySelector('.enter-hint');
      expect(hint).to.be.null;

      // Type some text — hint appears
      await typeInto('temba-select', 'hello', false, false);
      await clock.runAll();
      await select.updateComplete;
      hint = select.shadowRoot.querySelector('.enter-hint');
      expect(hint).to.not.be.null;
      expect(hint.textContent).to.contain('to add');
    });
  });

  describe('beforeinput handling (Android virtual keyboards)', () => {
    it('adds tag via insertLineBreak beforeinput', async () => {
      const select = await createSelect(
        clock,
        getSelectHTML([], {
          placeholder: 'Enter tags',
          multi: true,
          searchable: true,
          tags: true
        })
      );

      await typeInto('temba-select', 'hello', false, false);
      await clock.runAll();
      await select.updateComplete;

      const searchbox = select.shadowRoot.querySelector(
        '.searchbox'
      ) as HTMLInputElement;
      const evt = new InputEvent('beforeinput', {
        inputType: 'insertLineBreak',
        bubbles: true,
        cancelable: true
      });
      searchbox.dispatchEvent(evt);
      await select.updateComplete;

      expect(select.values.length).to.equal(1);
      expect(select.values[0].value).to.equal('hello');
      expect(evt.defaultPrevented).to.be.true;
    });

    it('adds tag via insertParagraph beforeinput', async () => {
      const select = await createSelect(
        clock,
        getSelectHTML([], {
          placeholder: 'Enter tags',
          multi: true,
          searchable: true,
          tags: true
        })
      );

      await typeInto('temba-select', 'world', false, false);
      await clock.runAll();
      await select.updateComplete;

      const searchbox = select.shadowRoot.querySelector(
        '.searchbox'
      ) as HTMLInputElement;
      const evt = new InputEvent('beforeinput', {
        inputType: 'insertParagraph',
        bubbles: true,
        cancelable: true
      });
      searchbox.dispatchEvent(evt);
      await select.updateComplete;

      expect(select.values.length).to.equal(1);
      expect(select.values[0].value).to.equal('world');
      expect(evt.defaultPrevented).to.be.true;
    });

    it('adds email via beforeinput', async () => {
      const select = await createSelect(
        clock,
        getSelectHTML([], {
          placeholder: 'Enter email addresses',
          searchable: true,
          emails: true
        })
      );

      await typeInto('temba-select', 'test@example.com', false, false);
      await clock.runAll();
      await select.updateComplete;

      const searchbox = select.shadowRoot.querySelector(
        '.searchbox'
      ) as HTMLInputElement;
      const evt = new InputEvent('beforeinput', {
        inputType: 'insertLineBreak',
        bubbles: true,
        cancelable: true
      });
      searchbox.dispatchEvent(evt);
      await select.updateComplete;

      expect(select.values.length).to.equal(1);
      expect(select.values[0].value).to.equal('test@example.com');
    });

    it('does not add invalid email via beforeinput', async () => {
      const select = await createSelect(
        clock,
        getSelectHTML([], {
          placeholder: 'Enter email addresses',
          searchable: true,
          emails: true
        })
      );

      await typeInto('temba-select', 'invalid-email', false, false);
      await clock.runAll();
      await select.updateComplete;

      const searchbox = select.shadowRoot.querySelector(
        '.searchbox'
      ) as HTMLInputElement;
      searchbox.dispatchEvent(
        new InputEvent('beforeinput', {
          inputType: 'insertLineBreak',
          bubbles: true,
          cancelable: true
        })
      );
      await select.updateComplete;

      expect(select.values.length).to.equal(0);
    });
  });

  describe('emails functionality', () => {
    it('only allows valid email addresses as options', async () => {
      const select = await createSelect(
        clock,
        getSelectHTML([], {
          placeholder: 'Enter email addresses',
          searchable: true,
          emails: true
        })
      );

      // Try typing an invalid email and pressing Enter - should not be added
      await typeInto('temba-select', 'invalid-email', false, false);
      await clock.runAll();
      await select.updateComplete;

      const searchbox = select.shadowRoot.querySelector(
        '.searchbox'
      ) as HTMLInputElement;
      searchbox.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
      );
      await select.updateComplete;
      expect(select.values.length).to.equal(0);

      // Clear input
      select.input = '';
      await select.updateComplete;

      // Try typing a valid email and pressing Enter - should be added
      await typeInto('temba-select', 'test@example.com', false, false);
      await clock.runAll();
      await select.updateComplete;

      searchbox.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
      );
      await select.updateComplete;
      expect(select.values.length).to.equal(1);
      expect(select.values[0].value).to.equal('test@example.com');
    });

    it('behaves as multi-select when emails is true', async () => {
      const select = await createSelect(
        clock,
        getSelectHTML([], {
          placeholder: 'Enter email addresses',
          searchable: true,
          emails: true
        })
      );

      // Add first email via Enter
      await typeInto('temba-select', 'first@example.com', false, false);
      await clock.runAll();
      await select.updateComplete;

      let searchbox = select.shadowRoot.querySelector(
        '.searchbox'
      ) as HTMLInputElement;
      searchbox.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
      );
      await select.updateComplete;

      expect(select.values.length).to.equal(1);
      expect(select.values[0].value).to.equal('first@example.com');

      // Add second email via Enter
      await typeInto('temba-select', 'second@example.com', false, false);
      await clock.runAll();
      await select.updateComplete;

      searchbox = select.shadowRoot.querySelector(
        '.searchbox'
      ) as HTMLInputElement;
      searchbox.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
      );
      await select.updateComplete;

      // Should have both emails selected (multi-select behavior)
      expect(select.values.length).to.equal(2);
      expect(select.values[0].value).to.equal('first@example.com');
      expect(select.values[1].value).to.equal('second@example.com');
    });

    it('treats comma as Enter for email input', async () => {
      const select = await createSelect(
        clock,
        getSelectHTML([], {
          placeholder: 'Enter email addresses',
          searchable: true,
          emails: true
        })
      );

      // Type a valid email and press comma - should add it
      await typeInto('temba-select', 'first@example.com', false, false);
      await clock.runAll();
      await select.updateComplete;

      let searchbox = select.shadowRoot.querySelector(
        '.searchbox'
      ) as HTMLInputElement;
      searchbox.dispatchEvent(
        new KeyboardEvent('keydown', { key: ',', bubbles: true })
      );
      await select.updateComplete;

      expect(select.values.length).to.equal(1);
      expect(select.values[0].value).to.equal('first@example.com');

      // Type an invalid email and press comma - should not add it
      await typeInto('temba-select', 'not-an-email', false, false);
      await clock.runAll();
      await select.updateComplete;

      searchbox = select.shadowRoot.querySelector(
        '.searchbox'
      ) as HTMLInputElement;
      searchbox.dispatchEvent(
        new KeyboardEvent('keydown', { key: ',', bubbles: true })
      );
      await select.updateComplete;

      expect(select.values.length).to.equal(1);
    });

    it('validates email format correctly', async () => {
      const select = await createSelect(
        clock,
        getSelectHTML([], {
          placeholder: 'Enter email addresses',
          searchable: true,
          emails: true
        })
      );

      // Test various email formats — Enter should only add valid emails
      const testCases = [
        { email: 'valid@example.com', shouldBeValid: true },
        { email: 'user.name+tag@example.co.uk', shouldBeValid: true },
        { email: 'invalid-email', shouldBeValid: false },
        { email: '@example.com', shouldBeValid: false },
        { email: 'user@', shouldBeValid: false },
        { email: 'user name@example.com', shouldBeValid: false }, // space not allowed
        { email: 'user@example', shouldBeValid: false } // no domain extension
      ];

      let expectedCount = 0;
      for (const testCase of testCases) {
        select.input = '';
        await select.updateComplete;

        await typeInto('temba-select', testCase.email, false, false);
        await clock.runAll();
        await select.updateComplete;

        const searchbox = select.shadowRoot.querySelector(
          '.searchbox'
        ) as HTMLInputElement;
        searchbox.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
        );
        await select.updateComplete;

        if (testCase.shouldBeValid) {
          expectedCount++;
          expect(
            select.values.length,
            `${testCase.email} should be valid`
          ).to.equal(expectedCount);
        } else {
          expect(
            select.values.length,
            `${testCase.email} should be invalid`
          ).to.equal(expectedCount);
        }
      }
    });

    it('shows enter hint when valid email is typed', async () => {
      const select = await createSelect(
        clock,
        getSelectHTML([], {
          placeholder: 'Enter email addresses',
          searchable: true,
          emails: true
        })
      );

      // No hint before typing
      let hint = select.shadowRoot.querySelector('.enter-hint');
      expect(hint).to.be.null;

      // Type an invalid email — no hint
      await typeInto('temba-select', 'invalid', false, false);
      await clock.runAll();
      await select.updateComplete;
      hint = select.shadowRoot.querySelector('.enter-hint');
      expect(hint).to.be.null;

      // Clear and type a valid email — hint appears
      select.input = '';
      await select.updateComplete;
      await typeInto('temba-select', 'test@example.com', false, false);
      await clock.runAll();
      await select.updateComplete;
      hint = select.shadowRoot.querySelector('.enter-hint');
      expect(hint).to.not.be.null;
      expect(hint.textContent).to.contain('to add');
    });
  });

  describe('static options', () => {
    it('accepts an initial value', async () => {
      const select = await createSelect(
        clock,
        getSelectHTML(colors, { value: '1' })
      );
      expect(select.values[0].name).to.equal('Green');
      await assertScreenshot('select/static-initial-value', getClip(select));
    });

    it('honors temba-option selected attribute', async () => {
      const select = await createSelect(clock, getSelectHTML(colors, {}, '1'));
      expect(select.values[0].name).to.equal('Green');
      await assertScreenshot(
        'select/static-initial-via-selected',
        getClip(select)
      );
    });

    it('fires change event when static option sets initial value', async () => {
      const changeEvent = sinon.spy();

      // Create a basic select element with manual HTML
      const parentNode = document.createElement('div');
      parentNode.innerHTML = `<temba-select name="test">
        <temba-option name="Red" value="0"></temba-option>
        <temba-option name="Green" value="1" selected></temba-option>
        <temba-option name="Blue" value="2"></temba-option>
      </temba-select>`;

      const select = parentNode.querySelector(
        'temba-select'
      ) as Select<SelectOption>;
      document.body.appendChild(parentNode);

      // Add event listener before triggering initialization
      select.addEventListener('change', changeEvent);

      // Manually trigger slot change to process the selected attribute
      select.handleSlotChange();
      clock.runAll();
      await select.updateComplete;

      // The change event should have been fired when the initial value was set
      assert(
        changeEvent.called,
        'change event should fire when static option sets initial value'
      );
      expect(select.values[0].name).to.equal('Green');

      document.body.removeChild(parentNode);
    });

    it('fires change event when static option sets initial value via value attribute', async () => {
      const changeEvent = sinon.spy();

      // Create a basic select element with value attribute
      const parentNode = document.createElement('div');
      parentNode.innerHTML = `<temba-select name="test" value="1">
        <temba-option name="Red" value="0"></temba-option>
        <temba-option name="Green" value="1"></temba-option>
        <temba-option name="Blue" value="2"></temba-option>
      </temba-select>`;

      const select = parentNode.querySelector(
        'temba-select'
      ) as Select<SelectOption>;
      document.body.appendChild(parentNode);

      // Add event listener before triggering initialization
      select.addEventListener('change', changeEvent);

      // First process the static options
      select.handleSlotChange();
      // Then check for selected option based on value attribute
      select.setSelectedValue(select.getAttribute('value'));

      clock.runAll();
      await select.updateComplete;

      // The change event should have been fired when the initial value was set
      assert(
        changeEvent.called,
        'change event should fire when value attribute sets initial value'
      );
      expect(select.values[0].name).to.equal('Green');

      document.body.removeChild(parentNode);
    });

    it('creates proper form inputs for static options', async () => {
      // Create a form with a select that has static options
      const form = document.createElement('form');
      form.innerHTML = `<temba-select name="color" value="1">
        <temba-option name="Red" value="0"></temba-option>
        <temba-option name="Green" value="1"></temba-option>
        <temba-option name="Blue" value="2"></temba-option>
      </temba-select>`;

      document.body.appendChild(form);
      const select = form.querySelector('temba-select') as Select<SelectOption>;

      // Wait for component to be ready
      await select.updateComplete;

      // Process the static options and set initial value
      select.handleSlotChange();
      select.setSelectedValue(select.getAttribute('value'));

      clock.runAll();
      await select.updateComplete;

      // Check that the select has the correct value
      expect(select.values[0].name).to.equal('Green');
      expect(select.values[0].value).to.equal('1');

      // For single-mode selects, check the value property
      expect(select.value).to.equal('1');

      // Test FormData - it should include the select's value
      const formData = new FormData(form);
      expect(formData.get('color')).to.equal('1');

      document.body.removeChild(form);
    });
  });

  describe('endpoints', () => {
    it('can load from an endpoint', async () => {
      const select = await createSelect(
        clock,
        getSelectHTML([], {
          placeholder: 'Select a color',
          endpoint: '/test/assets/select/colors.json'
        })
      );

      await openSelect(clock, select);
      await assertScreenshot(
        'select/remote-options',
        getClipWithOptions(select)
      );
      assert.equal(select.visibleOptions.length, 3);
    });

    it('can search an endpoint', async () => {
      const select = await createSelect(
        clock,
        getSelectHTML([], {
          placeholder: 'Select a color',
          endpoint: '/test/assets/select/colors.json',
          searchable: true
        })
      );

      await openSelect(clock, select);
      await typeInto('temba-select', 're', false);

      // Ensure Lit has processed the input change and scheduled the debounced fetch
      await select.updateComplete;
      clock.runAll();
      await select.updateComplete;

      assert.equal(select.visibleOptions.length, 2);

      await assertScreenshot('select/searching', getClipWithOptions(select));
    });

    it('can use an endpoint and allow multiple', async () => {
      const select = await createSelect(
        clock,
        getSelectHTML([], {
          placeholder: 'Select a color',
          endpoint: '/test/assets/select/colors.json',
          searchable: true,
          multi: true
        })
      );

      await assertScreenshot(
        'select/multi-with-endpoint',
        getClipWithOptions(select)
      );

      // await typeInto('temba-select', 're', false);
      // await open(select);
      // assert.equal(select.visibleOptions.length, 2);
    });

    xit('pages through cursor results', async () => {
      const select = await createSelect(
        clock,
        getSelectHTML([], {
          placeholder: 'Select a group',
          endpoint: '/test/assets/select/groups.json',
          valueKey: 'uuid'
        })
      );

      await openSelect(clock, select);

      // Wait for pagination to complete using our improved helper
      // Use more attempts for this test since pagination can be slow in CI
      await waitForSelectPagination(select, clock, 15, 50);

      // should have all three pages visible right away
      assert.equal(select.visibleOptions.length, 15);
    });

    xit('shows cached results', async () => {
      const select = await createSelect(
        clock,
        getSelectHTML([], {
          placeholder: 'Select a group',
          endpoint: '/test/assets/select/groups.json',
          valueKey: 'uuid',
          searchable: true
        })
      );

      // wait for updates from fetching three pages
      await openSelect(clock, select);
      await waitForSelectPagination(select, clock, 15, 50);
      assert.equal(select.visibleOptions.length, 15);

      // close and reopen
      select.blur();
      await clock.tick(250);
      // Ensure the select is properly closed before reopening
      await select.updateComplete;

      await openSelect(clock, select);
      // Cached results should be available immediately, but give some time for rendering
      await waitForSelectPagination(select, clock, 15, 10);
      assert.equal(select.visibleOptions.length, 15);

      // close and reopen once more (previous bug failed on third opening)
      // select.blur();
      // await open(select);
      // assert.equal(select.visibleOptions.length, 15);
    });

    it('can enter expressions', async () => {
      await loadStore();
      const select = await createSelect(
        clock,
        getSelectHTML([], {
          endpoint: '/colors.json',
          searchable: true,
          expressions: 'session'
        })
      );

      await typeInto('temba-select', 'Hi there @contact', false);
      await openSelect(clock, select);

      assert.equal(select.completionOptions.length, 14);
      await assertScreenshot('select/expressions', getClipWithOptions(select));
    });

    it('clears single selection', async () => {
      const select = await createSelect(
        clock,
        getSelectHTML(colors, { clearable: true })
      );
      assert.equal(select.getStaticOptions().length, 3);

      await openAndClick(clock, select, 0);
      expect(select.values[0].name).to.equal('Red');

      await assertScreenshot('select/selection-clearable', getClip(select));

      clear(select);
      clock.runAll();
      await select.updateComplete;
      expect(select.values.length).to.equal(0);
    });

    it('should look the same with search enabled', async () => {
      const select = await createSelect(
        clock,
        getSelectHTML(colors, {
          placeholder: 'Select a color',
          searchable: true
        })
      );
      await assertScreenshot('select/search-enabled', getClip(select));
    });

    it('should look the same with search enabled and selection made', async () => {
      const select = await createSelect(
        clock,
        getSelectHTML(colors, {
          placeholder: 'Select a color',
          searchable: true
        })
      );

      // select the first option
      await openAndClick(clock, select, 1);
      await assertScreenshot(
        'select/search-selected',
        getClipWithOptions(select)
      );
    });

    it('should show focus for the selected option', async () => {
      const select = await createSelect(
        clock,
        getSelectHTML(colors, { searchable: true })
      );

      // select the first option
      await openAndClick(clock, select, 1);

      // now open and look at focus
      await openSelect(clock, select);
      await assertScreenshot(
        'select/search-selected-focus',
        getClipWithOptions(select)
      );
    });

    it('should show search with existing multiple selection', async () => {
      const select = await createSelect(
        clock,
        getSelectHTML(colors, {
          placeholder: 'Select a color',
          searchable: true,
          multi: true
        })
      );

      // select the first option
      await openAndClick(clock, select, 0);
      await openAndClick(clock, select, 0);
      await openSelect(clock, select);

      // now lets do a search, we should see our selection (green) and one other (red)
      await typeInto('temba-select', 're', false);
      await openSelect(clock, select);

      // should have two things selected and active query and no matching options
      await assertScreenshot(
        'select/search-multi-no-matches',
        getClipWithOptions(select)
      );
    });

    it('should show functions', async () => {
      await loadStore();

      const select = await createSelect(
        clock,
        getSelectHTML(colors, {
          placeholder: 'Select a color',
          searchable: true,
          expressions: 'session'
        })
      );

      await typeInto('temba-select', 'look at @(max(m', false);
      await openSelect(clock, select);

      await assertScreenshot('select/functions', getClipWithOptions(select));
    });

    it('should truncate selection if necessesary', async () => {
      const options = [
        {
          name: 'this_is_a_long_selection_to_make_sure_it_truncates_but_it_needs_to_be_longer',
          value: '0'
        }
      ];

      const select = await createSelect(
        clock,
        getSelectHTML(options, {
          value: '0'
        })
      );

      await assertScreenshot(
        'select/truncated-selection',
        getClipWithOptions(select)
      );
    });

    it('can select expression completion as value', async () => {
      await loadStore();

      const select = await createSelect(
        clock,
        getSelectHTML(colors, {
          multi: true,
          placeholder: 'Select a color',
          searchable: true,
          expressions: 'session'
        })
      );

      await typeInto('temba-select', '@con', false);
      await openAndClick(clock, select, 0);

      expect(select.values[0].name).to.equal('@contact');
      await assertScreenshot(
        'select/expression-selected',
        getClipWithOptions(select)
      );
    });
  });
});
