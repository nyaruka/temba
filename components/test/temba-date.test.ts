import { html, fixture, expect } from '@open-wc/testing';
import { TembaDate } from '../src/display/TembaDate';
import {
  assertScreenshot,
  getClip,
  getComponent,
  loadStore,
  mockNow
} from './utils.test';
import { SinonStub } from 'sinon';

const TAG = 'temba-date';

export const getDate = async (attrs: any = {}) => {
  attrs['width'] = 100;
  return (await getComponent(TAG, attrs)) as TembaDate;
};

describe('temba-date', () => {
  let mockedNow: SinonStub;
  beforeEach(() => {
    mockedNow = mockNow('2022-12-02T21:00:00.000000');
    loadStore();
  });

  afterEach(() => {
    mockedNow.restore();
  });

  it('renders default', async () => {
    const date = await getDate({ value: '1978-11-18T02:22:00.000000' });
    const dateString = (
      date.shadowRoot.querySelector('.date') as HTMLSpanElement
    ).innerText;

    await assertScreenshot('date/date', getClip(date));
    expect(dateString).to.equal('11/18/1978');
  });

  it('renders duration', async () => {
    const date = await getDate({
      value: '1978-11-18T02:22:00.000000',
      display: 'duration'
    });
    const dateString = (
      date.shadowRoot.querySelector('.date') as HTMLSpanElement
    ).innerText;

    await assertScreenshot('date/duration', getClip(date));
    expect(dateString).to.equal('44 years ago');
  });

  it('renders age', async () => {
    const age = async (value: string) => {
      const date = await getDate({ value, display: 'age' });
      const shown = date.shadowRoot.querySelector('.age');
      return [
        shown.querySelector('.value')?.textContent,
        shown.querySelector('.unit')?.textContent
      ];
    };

    // the time since, in its largest whole unit
    expect(await age('2022-12-02T20:59:30.000000')).to.deep.equal([
      undefined,
      'now'
    ]);
    expect(await age('2022-12-02T20:59:00.000000')).to.deep.equal(['1', 'min']);
    expect(await age('2022-12-02T20:07:00.000000')).to.deep.equal([
      '53',
      'mins'
    ]);
    expect(await age('2022-12-02T20:00:00.000000')).to.deep.equal([
      '1',
      'hour'
    ]);
    expect(await age('2022-11-27T20:00:00.000000')).to.deep.equal([
      '5',
      'days'
    ]);
    expect(await age('2022-08-01T00:00:00.000000')).to.deep.equal([
      '4',
      'months'
    ]);
  });

  it('renders age as a number over its unit', async () => {
    const date = await getDate({
      value: '2022-11-27T20:00:00.000000',
      display: 'age'
    });
    await assertScreenshot('date/age', getClip(date));
  });

  it('renders datetime', async () => {
    const date = await getDate({
      value: '1978-11-18T02:22:00.000000',
      display: 'datetime'
    });
    const dateString = (
      date.shadowRoot.querySelector('.date') as HTMLSpanElement
    ).innerText;

    await assertScreenshot('date/datetime', getClip(date));
    expect(dateString).to.equal('11/18/1978, 2:22 AM');
  });

  it('renders timedate', async () => {
    const date = await getDate({
      value: '2022-12-01T21:30:00.000000',
      display: 'timedate'
    });
    const dateString = (
      date.shadowRoot.querySelector('.date') as HTMLSpanElement
    ).innerText;
    await assertScreenshot('date/timedate', getClip(date));
    expect(dateString).to.equal('Dec 1');
  });

  it('renders nothing for zero-value times', async () => {
    // a contact that has never been seen can come through as go's zero time -
    // that isn't a real date and shouldn't render as "2021 years ago"
    const date = await getDate({
      value: '0001-01-01T00:00:00.000000Z',
      display: 'duration'
    });
    expect(date.shadowRoot.querySelector('.date')).to.equal(null);
  });

  it('renders nothing for unparseable values', async () => {
    const date = await getDate({
      value: 'not-a-date',
      display: 'duration'
    });
    expect(date.shadowRoot.querySelector('.date')).to.equal(null);
  });

  it('renders inline', async () => {
    const el: HTMLElement = await fixture(html`
      <span
        >Your birthday is
        <temba-date value="1978-11-18T02:22:00.000000"></temba-date>!</span
      >
    `);

    await assertScreenshot('date/date-inline', getClip(el));
  });
});
