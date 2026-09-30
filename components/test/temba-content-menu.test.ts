import { assert, expect } from '@open-wc/testing';
import { CustomEventType } from '../src/interfaces';
import { ContentMenu } from '../src/list/ContentMenu';
import { assertScreenshot, getClip, getComponent, mockGET } from './utils.test';

const TAG = 'temba-content-menu';
const getContentMenu = async (attrs: any = {}, width = 0) => {
  const contentMenu = (await getComponent(
    TAG,
    attrs,
    '',
    width,
    0,
    'display:inline-block'
  )) as ContentMenu;

  // return right away if we don't have an endpoint
  if (!contentMenu.endpoint) {
    return contentMenu;
  }

  // if we have an endpoint, wait for a loaded event before returning
  return new Promise<ContentMenu>((resolve) => {
    contentMenu.addEventListener(
      CustomEventType.Loaded,
      async () => {
        resolve(contentMenu);
      },
      { once: true }
    );
  });
};

describe('temba-content-menu', () => {
  it('can initially be created without endpoint', async () => {
    const contentMenu: ContentMenu = await getContentMenu();
    assert.instanceOf(contentMenu, ContentMenu);
    expect(contentMenu.endpoint).is.undefined;
  });

  it('with 1+ items and 1+ buttons', async () => {
    const contentMenu: ContentMenu = await getContentMenu({
      endpoint: '/test/assets/list/content-menu-contact-read.json'
    });

    expect(contentMenu.items.length).equals(5);
    expect(contentMenu.buttons.length).equals(1);
    await assertScreenshot(
      'content-menu/items-and-buttons',
      getClip(contentMenu)
    );
  });

  it('with 1+ items and 0 buttons', async () => {
    const contentMenu: ContentMenu = await getContentMenu({
      endpoint: '/test/assets/list/content-menu-archived-contacts.json'
    });

    expect(contentMenu.items.length).equals(1);
    expect(contentMenu.buttons.length).equals(0);
    await assertScreenshot(
      'content-menu/item-no-buttons',
      getClip(contentMenu)
    );
  });

  it('with 0 items and 1+ buttons', async () => {
    const contentMenu: ContentMenu = await getContentMenu({
      endpoint: '/test/assets/list/content-menu-new-campaign.json'
    });

    expect(contentMenu.items.length).equals(0);
    expect(contentMenu.buttons.length).equals(1);
    await assertScreenshot(
      'content-menu/button-no-items',
      getClip(contentMenu)
    );
  });

  it('bad endpoint', async () => {
    const contentMenu: ContentMenu = await getContentMenu({
      endpoint: '/test/assets/list/content-menu-bad-endpoint.json'
    });

    expect(contentMenu.items.length).equals(0);
    expect(contentMenu.buttons.length).equals(0);
  });

  it('is spa page', async () => {
    const contentMenu: ContentMenu = await getContentMenu({
      endpoint: '/test/assets/list/content-menu-contact-read.json',
      legacy: 0
    });
    expect(contentMenu.legacy).equals(0);
  });

  it('is legacy page', async () => {
    const contentMenu: ContentMenu = await getContentMenu({
      endpoint: '/test/assets/list/content-menu-contact-read.json',
      legacy: 1
    });
    expect(contentMenu.legacy).equals(1);
  });

  it('fires selection when an open menu item is clicked', async () => {
    const contentMenu: ContentMenu = await getContentMenu({
      endpoint: '/test/assets/list/content-menu-contact-read.json'
    });

    const toggle = contentMenu.shadowRoot.querySelector(
      '.toggle'
    ) as HTMLElement;
    toggle.click();

    // wait out the deferred position calculation
    await new Promise((resolve) => setTimeout(resolve, 100));
    await contentMenu.updateComplete;

    // the item must actually be hit-testable — the popup only accepts
    // pointer events while open
    const item = contentMenu.shadowRoot.querySelector('.item') as HTMLElement;
    const bounds = item.getBoundingClientRect();
    expect(
      contentMenu.shadowRoot.elementFromPoint(
        bounds.left + bounds.width / 2,
        bounds.top + bounds.height / 2
      )
    ).to.equal(item);

    const selection = new Promise<CustomEvent>((resolve) => {
      contentMenu.addEventListener(
        CustomEventType.Selection,
        (event: Event) => resolve(event as CustomEvent),
        { once: true }
      );
    });
    item.click();

    const event = await selection;
    expect(event.detail.item.label).to.equal(contentMenu.items[0].label);
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

    const contentMenu: ContentMenu = await getContentMenu({
      endpoint: '/menu/unavailable'
    });
    await contentMenu.updateComplete;

    const [startFlow, exportItem] = Array.from(
      contentMenu.shadowRoot.querySelectorAll('.item')
    ) as HTMLElement[];
    expect(startFlow.classList.contains('unavailable')).to.be.true;
    expect(startFlow.title).to.equal('This contact has an open ticket.');
    expect(exportItem.classList.contains('unavailable')).to.be.false;
    expect(exportItem.hasAttribute('title')).to.be.false;

    const selected = [];
    contentMenu.addEventListener(CustomEventType.Selection, (e: Event) =>
      selected.push((e as CustomEvent).detail.item.label)
    );
    startFlow.click();
    exportItem.click();

    expect(selected).to.deep.equal(['Export']);
  });
});
