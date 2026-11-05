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

  it('treats an empty subtitle slot as no subtitle', async () => {
    // server templates always emit the slot, whether or not it has content
    const header = (await fixture(html`
      <temba-page-header header-title="Test">
        <div slot="subtitle"></div>
      </temba-page-header>
    `)) as PageHeader;
    expect(header.shadowRoot.querySelector('.subtitle')).to.be.null;

    const withSubtitle = (await fixture(html`
      <temba-page-header header-title="Test">
        <div slot="subtitle">Supporting context</div>
      </temba-page-header>
    `)) as PageHeader;
    expect(withSubtitle.shadowRoot.querySelector('.subtitle')).to.not.be.null;
  });
});
