import { fixture, assert, expect } from '@open-wc/testing';
import { ContactSearch } from '../src/form/ContactSearch';
import { assertScreenshot, getClip, getHTML, mockPOST } from './utils.test';
import { useFakeTimers } from 'sinon';
import { CustomEventType } from '../src/interfaces';
import { Omnibox } from '../src/form/select/Omnibox';

let clock: any;

function waitForSearch(search: ContactSearch) {
  return new Promise<ContactSearch>((resolve) => {
    search.addEventListener(
      CustomEventType.ContentChanged,
      async () => {
        await clock.runAll();
        resolve(search);
      },
      { once: true }
    );
  });
}

describe('temba-contact-search', () => {
  beforeEach(function () {
    clock = useFakeTimers();
  });

  afterEach(function () {
    clock.restore();
  });

  it('can be created', async () => {
    const search: ContactSearch = await fixture(
      getHTML('temba-contact-search')
    );
    assert.instanceOf(search, ContactSearch);
  });

  xit('handles bad queries', async () => {
    const endpoint = '/contact-search-bad';
    const search: ContactSearch = await fixture(
      getHTML('temba-contact-search', {
        advanced: true,
        endpoint
      })
    );

    // mock an error response
    mockPOST(
      /contact-search-bad/,
      { query: '', total: 0, error: "'Missing' is not a valid group name" },
      { 'X-Temba-Success': 'hide' }
    );

    search.query = 'group = "Missing"';

    // run the query
    await clock.runAll();
    await clock.runAll();
    await waitForSearch(search);

    expect(search.errors).to.deep.equal([
      "'Missing' is not a valid group name"
    ]);

    await search.updateComplete;
    await assertScreenshot('contact-search/missing-group', getClip(search));
  });

  it('locks recipients in fixed mode', async () => {
    const search: ContactSearch = await fixture(
      getHTML('temba-contact-search', {
        fixed: true,
        recipients: JSON.stringify([
          { id: 'contact-uuid', name: 'Ben Haggerty', type: 'contact' }
        ])
      })
    );

    await search.updateComplete;

    // no way to edit who gets started
    expect(search.shadowRoot.querySelector('temba-omnibox')).to.not.exist;
    expect(search.shadowRoot.querySelector('.filters')).to.not.exist;
    expect(search.shadowRoot.querySelector('temba-button.edit')).to.not.exist;
  });

  it('notes that contacts with open tickets are excluded', async () => {
    const search: ContactSearch = await fixture(
      getHTML('temba-contact-search', { in_a_flow: true })
    );
    await search.updateComplete;

    // no note unless the flow being started excludes them
    expect(search.shadowRoot.querySelector('.tickets-note')).to.not.exist;

    search.excludes_tickets = true;
    await search.updateComplete;

    const note = search.shadowRoot.querySelector('.tickets-note');
    expect(note).to.exist;
    expect(note.textContent).to.contain(
      'Contacts with an open ticket are not included.'
    );

    // it's a fixed rule, not a filter the user can change
    expect(note.querySelector('temba-checkbox')).to.not.exist;
    expect(search.exclusions).to.not.have.property('excludes_tickets');

    // and it's not shown when starting a single fixed contact
    search.fixed = true;
    await search.updateComplete;
    expect(search.shadowRoot.querySelector('.tickets-note')).to.not.exist;
  });

  it('excludes a contact in a flow from first render', async () => {
    const search: ContactSearch = await fixture(
      getHTML('temba-contact-search', {
        fixed: true,
        current_flow: 'Survey Flow',
        in_a_flow: true,
        recipients: JSON.stringify([
          { id: 'contact-uuid', name: 'Ben Haggerty', type: 'contact' }
        ])
      })
    );

    await search.updateComplete;
    expect(search.exclusions['in_a_flow']).to.equal(true);
    expect(search.shadowRoot.querySelector('.interrupt-confirm')).to.exist;
  });

  it('requires confirmation to interrupt a current flow', async () => {
    const search: ContactSearch = await fixture(
      getHTML('temba-contact-search', {
        fixed: true,
        current_flow: 'Survey Flow',
        recipients: JSON.stringify([
          { id: 'contact-uuid', name: 'Ben Haggerty', type: 'contact' }
        ])
      })
    );

    await search.updateComplete;

    // no confirmation until a flow that interrupts is selected
    expect(search.shadowRoot.querySelector('.interrupt-confirm')).to.not.exist;

    // selecting a non-background flow asks for interrupt confirmation
    search.in_a_flow = true;
    await search.updateComplete;

    // but not while a search is running
    search.fetching = true;
    await search.updateComplete;
    expect(search.shadowRoot.querySelector('.interrupt-confirm')).to.not.exist;

    search.fetching = false;
    await search.updateComplete;

    const confirm = search.shadowRoot.querySelector('.interrupt-confirm');
    expect(confirm).to.exist;
    expect(confirm.querySelector('temba-checkbox')).to.exist;
    expect(confirm.querySelector('b').textContent).to.equal('Survey Flow');
    expect(confirm.textContent).to.contain('interrupt');
    expect(search.exclusions['in_a_flow']).to.equal(true);

    // starting the same flow they are already in is a restart
    search.flow = { name: 'Survey Flow' };
    await search.updateComplete;
    expect(
      search.shadowRoot.querySelector('.interrupt-confirm').textContent
    ).to.contain('restart');
    search.flow = null;
    await search.updateComplete;

    // confirming interruption lifts the exclusion so the start can proceed, without
    // re-running the search - the widget reports the new total itself
    const checkbox = confirm.querySelector('temba-checkbox') as any;
    let eventPromise = new Promise<any>((resolve) =>
      search.addEventListener(
        CustomEventType.ContentChanged,
        (e: any) => resolve(e.detail),
        { once: true }
      )
    );
    checkbox.checked = true;
    let detail = await eventPromise;
    expect(detail.total).to.equal(1);
    expect(search.exclusions['in_a_flow']).to.be.undefined;
    expect(search.getDeserializedValue().exclusions['in_a_flow']).to.be
      .undefined;

    // unconfirming puts it back
    eventPromise = new Promise<any>((resolve) =>
      search.addEventListener(
        CustomEventType.ContentChanged,
        (e: any) => resolve(e.detail),
        { once: true }
      )
    );
    checkbox.checked = false;
    detail = await eventPromise;
    expect(detail.total).to.equal(0);
    expect(search.exclusions['in_a_flow']).to.equal(true);

    // background flows don't interrupt, no confirmation needed
    search.in_a_flow = false;
    await search.updateComplete;
    expect(search.shadowRoot.querySelector('.interrupt-confirm')).to.not.exist;
    expect(search.exclusions['in_a_flow']).to.be.undefined;
  });

  xit('allows manual searches', async () => {
    const endpoint = '/contact-search-manual';
    const search: ContactSearch = await fixture(
      getHTML('temba-contact-search', {
        endpoint
      })
    );

    const omnibox = search.shadowRoot.querySelector('temba-omnibox') as Omnibox;
    omnibox.value = [];
    search.advanced = true;

    await search.updateComplete;

    // mock successful response with some warnings
    mockPOST(
      /contact-search-manual/,
      {
        query: 'group = "Doctors"',
        total: 1937,
        warnings: [
          'This flow does not specify a Facebook topic. You may still start this flow but Facebook contacts who have not sent an incoming message in the last 24 hours may not receive it.',
          'This flow does not use message templates. You may still start this flow but WhatsApp contacts who have not sent an incoming message in the last 24 hours may not receive it.'
        ],
        blockers: []
      },
      { 'X-Temba-Success': 'hide' }
    );

    search.query = 'group = "Testers"';

    // run the query
    await clock.runAll();
    await clock.runAll();
    await waitForSearch(search);
    await clock.runAll();

    await search.updateComplete;
    await assertScreenshot('contact-search/manual-search', getClip(search));
  });
});
