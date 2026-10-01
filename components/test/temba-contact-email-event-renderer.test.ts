import { expect, fixture, html } from '@open-wc/testing';
import { renderEvent } from '../src/events/eventRenderers';
import { ContactEmailChangedEvent } from '../src/events';

const makeEvent = (email: string): ContactEmailChangedEvent =>
  ({
    type: 'contact_email_changed',
    uuid: 'evt-1',
    created_on: new Date(),
    email
  }) as unknown as ContactEmailChangedEvent;

// rendered the same way in contact history and the simulator
describe('contact_email_changed', () => {
  for (const simulation of [false, true]) {
    it(`renders the new address (simulation: ${simulation})`, async () => {
      const el = await fixture(
        html`<div>
          ${renderEvent(makeEvent('bob@example.com'), simulation)}
        </div>`
      );
      expect(el.textContent).to.contain('Email');
      expect(el.textContent).to.contain('bob@example.com');
    });
  }

  it('renders a cleared address', async () => {
    const el = await fixture(
      html`<div>${renderEvent(makeEvent(''), false)}</div>`
    );
    expect(el.textContent).to.contain('Email');
    expect(el.textContent).to.contain('cleared');
  });
});
