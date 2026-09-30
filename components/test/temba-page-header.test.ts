import { expect, fixture, oneEvent, waitUntil } from '@open-wc/testing';
import { html } from 'lit';
import { CustomEventType } from '../src/interfaces';
import { PageHeader } from '../src/layout/PageHeader';
import { mockGET } from './utils.test';

describe('temba-page-header', () => {
  beforeEach(() => {
    mockGET(/\/menu\/example/, {
      items: [
        {
          type: 'modax',
          as_button: true,
          label: 'Start Flow',
          url: '/flow/start/',
          // in the content menu contract "disabled" configures the opened
          // modal's submit — the menu item itself stays clickable
          disabled: true
        },
        { type: 'link', label: 'Export', url: '/export/' }
      ]
    });
  });

  it('fires selection for disabled modax buttons', async () => {
    const header = (await fixture(html`
      <temba-page-header
        header-title="Test"
        content-menu-endpoint="/menu/example"
      ></temba-page-header>
    `)) as PageHeader;

    await waitUntil(() => !!header.shadowRoot.querySelector('.menu-button'));

    const button = header.shadowRoot.querySelector(
      '.menu-button'
    ) as HTMLElement;
    expect(button.textContent.trim()).to.equal('Start Flow');

    const selection = oneEvent(header, CustomEventType.Selection, false);
    button.click();
    const event = await selection;

    expect(event.detail.item.label).to.equal('Start Flow');
    expect(event.detail.item.disabled).to.be.true;
  });

  it('shows unavailable items with their reason and ignores clicks', async () => {
    mockGET(/\/menu\/unavailable/, {
      items: [
        {
          type: 'modax',
          label: 'Start Flow',
          url: '/flow/start/',
          unavailable: 'This contact has an open ticket.'
        },
        { type: 'link', label: 'Export', url: '/export/' }
      ]
    });

    const header = (await fixture(html`
      <temba-page-header
        header-title="Test"
        content-menu-endpoint="/menu/unavailable"
      ></temba-page-header>
    `)) as PageHeader;

    await waitUntil(() => !!header.shadowRoot.querySelector('.menu-item'));

    const [startFlow, exportItem] = Array.from(
      header.shadowRoot.querySelectorAll('.menu-item')
    ) as HTMLElement[];
    expect(startFlow.classList.contains('unavailable')).to.be.true;
    expect(startFlow.title).to.equal('This contact has an open ticket.');
    expect(exportItem.classList.contains('unavailable')).to.be.false;

    const selected = [];
    header.addEventListener(CustomEventType.Selection, (e: Event) =>
      selected.push((e as CustomEvent).detail.item.label)
    );
    startFlow.click();
    exportItem.click();

    expect(selected).to.deep.equal(['Export']);
  });
});
