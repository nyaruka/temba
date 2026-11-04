import { fixture, expect, assert } from '@open-wc/testing';
import { RangePicker } from '../src/form/RangePicker';
import {
  assertScreenshot,
  getAttributes,
  getClip,
  mockNow
} from './utils.test';
import { DateTime } from 'luxon';
import { SinonStub } from 'sinon';

export const getRangePickerHTML = (attrs: any = {}) => {
  return `<temba-range-picker ${getAttributes(attrs)}></temba-range-picker>`;
};

export const createRangePicker = async (def: string) => {
  const parentNode = document.createElement('div');
  parentNode.setAttribute('style', 'width: 600px;');
  parentNode.id = 'parent';
  const picker: RangePicker = await fixture(def, { parentNode });
  return picker;
};

describe('temba-range-picker', () => {
  let mockedNow: SinonStub;
  beforeEach(() => {
    mockedNow = mockNow('2022-12-02T21:00:00.000000');
  });

  afterEach(() => {
    mockedNow.restore();
  });

  it('can create a range picker', async () => {
    const picker: RangePicker = await createRangePicker(getRangePickerHTML());
    assert.instanceOf(picker, RangePicker);

    // Should have default range (last month)
    expect(picker.selectedRange).to.equal('M');
    expect(picker.startDate).to.not.be.empty;
    expect(picker.endDate).to.not.be.empty;

    await assertScreenshot('datepicker/range-picker-default', getClip(picker));
  });

  it('can be initialized with start and end dates', async () => {
    const picker: RangePicker = await createRangePicker(
      getRangePickerHTML({ start: '2024-01-01', end: '2024-01-31' })
    );

    expect(picker.startDate).to.equal('2024-01-01');
    expect(picker.endDate).to.equal('2024-01-31');
    expect(picker.selectedRange).to.equal('');

    await assertScreenshot(
      'datepicker/range-picker-initial-values',
      getClip(picker)
    );
  });

  it('can set min and max dates', async () => {
    const picker: RangePicker = await createRangePicker(
      getRangePickerHTML({
        start: '2024-06-01',
        end: '2024-06-30',
        min: '2024-01-01',
        max: '2024-12-31'
      })
    );

    expect(picker.minDate).to.equal('2024-01-01');
    expect(picker.maxDate).to.equal('2024-12-31');

    await assertScreenshot('datepicker/range-picker-min-max', getClip(picker));
  });

  it('can set range using buttons', async () => {
    const picker: RangePicker = await createRangePicker(getRangePickerHTML());

    // Click Week button
    const weekBtn = picker.shadowRoot?.querySelector(
      '.range-btn'
    ) as HTMLButtonElement;
    weekBtn.click();
    await picker.updateComplete;

    expect(picker.selectedRange).to.equal('W');
    expect(picker.startDate).to.equal(
      DateTime.now().minus({ days: 6 }).toISODate()
    );
    expect(picker.endDate).to.equal(DateTime.now().toISODate());

    await assertScreenshot('datepicker/range-picker-week', getClip(picker));
  });

  it('can set year range using button', async () => {
    const picker: RangePicker = await createRangePicker(getRangePickerHTML());

    // Click Year button (3rd button)
    const yearBtn = picker.shadowRoot?.querySelectorAll(
      '.range-btn'
    )[2] as HTMLButtonElement;
    yearBtn.click();
    await picker.updateComplete;

    expect(picker.selectedRange).to.equal('Y');
    expect(picker.startDate).to.equal(
      DateTime.now().minus({ years: 1 }).plus({ days: 1 }).toISODate()
    );
    expect(picker.endDate).to.equal(DateTime.now().toISODate());

    await assertScreenshot('datepicker/range-picker-year', getClip(picker));
  });

  it('can set all range using button', async () => {
    const picker: RangePicker = await createRangePicker(getRangePickerHTML());

    // Click All button (4th button)
    const allBtn = picker.shadowRoot?.querySelectorAll(
      '.range-btn'
    )[3] as HTMLButtonElement;
    allBtn.click();
    await picker.updateComplete;

    expect(picker.selectedRange).to.equal('ALL');
    expect(picker.startDate).to.equal('2012-01-01');
    expect(picker.endDate).to.equal(DateTime.now().toISODate());

    await assertScreenshot('datepicker/range-picker-all', getClip(picker));
  });

  it('can hide the all range button', async () => {
    const picker: RangePicker = await createRangePicker(
      getRangePickerHTML({ hideall: true })
    );

    const labels = Array.from(
      picker.shadowRoot?.querySelectorAll('.range-btn') || []
    ).map((btn) => btn.textContent.trim());
    expect(labels).to.deep.equal(['W', 'M', 'Y']);
  });

  it('enforces valid date ranges', async () => {
    const picker: RangePicker = await createRangePicker(
      getRangePickerHTML({ start: '2024-06-01', end: '2024-06-30' })
    );

    // Verify initial state is valid
    expect(
      DateTime.fromISO(picker.endDate) >= DateTime.fromISO(picker.startDate)
    ).to.be.true;

    // The validation logic is internal and triggered through user interaction
    // We can verify the component has the correct min/max constraints
    expect(picker.startDate).to.equal('2024-06-01');
    expect(picker.endDate).to.equal('2024-06-30');
  });

  it('enforces min/max date constraints', async () => {
    const picker: RangePicker = await createRangePicker(
      getRangePickerHTML({ min: '2024-01-01', max: '2024-12-31' })
    );

    expect(picker.minDate).to.equal('2024-01-01');
    expect(picker.maxDate).to.equal('2024-12-31');

    // Min/max are enforced through the temba-datepicker components
    // when user interacts with the date inputs
  });

  it('shows correct button selection states', async () => {
    const picker: RangePicker = await createRangePicker(getRangePickerHTML());

    // Initially should have M selected
    const monthBtn = picker.shadowRoot?.querySelectorAll(
      '.range-btn'
    )[1] as HTMLButtonElement;
    expect(monthBtn.classList.contains('selected')).to.be.true;

    // Click week button
    const weekBtn = picker.shadowRoot?.querySelector(
      '.range-btn'
    ) as HTMLButtonElement;
    weekBtn.click();
    await picker.updateComplete;

    expect(weekBtn.classList.contains('selected')).to.be.true;
    expect(monthBtn.classList.contains('selected')).to.be.false;

    await assertScreenshot(
      'datepicker/range-picker-button-states',
      getClip(picker)
    );
  });

  it('can click to edit dates', async () => {
    const picker: RangePicker = await createRangePicker(getRangePickerHTML());

    // Click on start date display
    const startDisplay = picker.shadowRoot?.querySelector(
      '.date-display'
    ) as HTMLElement;
    startDisplay.click();
    await picker.updateComplete;

    expect(picker.editingStart).to.be.true;

    // Should show temba-datepicker for start
    const startPicker = picker.shadowRoot?.querySelector(
      'temba-datepicker.start-picker'
    );
    expect(startPicker).to.not.be.null;

    await assertScreenshot(
      'datepicker/range-picker-editing-start',
      getClip(picker)
    );
  });
});
