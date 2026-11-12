import { expect, fixture, html, oneEvent } from '@open-wc/testing';
import { CustomEventType } from '../src/interfaces';
import { ChannelPicker, ClaimableType } from '../src/channels/ChannelPicker';
import {
  getChannelIcon,
  getMonogram,
  renderChannelLogo
} from '../src/channels/ChannelLogo';
import { render } from 'lit';
import {
  clearMockGets,
  clearMockPosts,
  mockGET,
  mockPOST,
  waitForCondition
} from './utils.test';

const type = (over: Partial<ClaimableType>): ClaimableType => ({
  code: 'TG',
  slug: 'telegram',
  name: 'Telegram',
  category: 'social',
  claim_url: '/channels/types/telegram/claim',
  in_region: true,
  recommended: false,
  ...over
});

const TYPES: ClaimableType[] = [
  type({
    code: 'D3C',
    slug: 'dialog360',
    name: '360Dialog WhatsApp',
    category: 'social',
    claim_url: '/channels/types/dialog360/claim'
  }),
  type({
    code: 'WAC',
    slug: 'whatsapp',
    name: 'WhatsApp',
    category: 'social',
    claim_url: '/channels/types/whatsapp/claim'
  }),
  type({ recommended: true }),
  type({
    code: 'A',
    slug: 'android',
    name: 'Android',
    category: 'phone',
    claim_url: '/channels/types/android/claim'
  }),
  type({
    code: 'SC',
    slug: 'smscentral',
    name: 'SMSCentral',
    category: 'phone',
    claim_url: '/channels/types/smscentral/claim',
    in_region: false
  }),
  type({
    code: 'EX',
    slug: 'external',
    name: 'External API',
    category: 'api',
    claim_url: '/channels/types/external/claim'
  })
];

const getPicker = async (): Promise<ChannelPicker> => {
  const picker = (await fixture(
    html`<temba-channel-picker></temba-channel-picker>`
  )) as ChannelPicker;
  picker.types = TYPES;
  picker.helpLinks = {
    channels: 'https://help.example.com/channels/',
    'channels.adding': 'https://help.example.com/channels/adding/',
    'channels.types.telegram': 'https://help.example.com/channels/telegram/'
  };
  picker.show();
  await picker.updateComplete;
  return picker;
};

const tileLabels = (picker: ChannelPicker) =>
  Array.from(picker.shadowRoot.querySelectorAll('.tile .label')).map((el) =>
    el.textContent.trim()
  );

const categoryCounts = (picker: ChannelPicker) =>
  Array.from(picker.shadowRoot.querySelectorAll('.category')).map((el) => {
    const count = el.querySelector('.count').textContent;
    const name = el.textContent.replace(count, '').trim();
    return `${name} ${count}`;
  });

const search = async (picker: ChannelPicker, query: string) => {
  const input = picker.shadowRoot.querySelector('.search') as HTMLInputElement;
  input.value = query;
  input.dispatchEvent(new InputEvent('input'));
  await picker.updateComplete;
  return input;
};

describe('temba-channel-picker', () => {
  afterEach(() => {
    clearMockGets();
    clearMockPosts();
  });

  it('lists the types in the region by category', async () => {
    const picker = await getPicker();

    // the out of region type is left out
    expect(tileLabels(picker)).to.deep.equal([
      '360Dialog WhatsApp',
      'WhatsApp',
      'Telegram',
      'Android',
      'External API'
    ]);
    expect(
      Array.from(picker.shadowRoot.querySelectorAll('.section-title')).map(
        (el) => el.textContent.trim()
      )
    ).to.deep.equal(['Social & Chat', 'SMS & Voice', 'Developer']);
    expect(categoryCounts(picker)).to.deep.equal([
      'All 5',
      'Recommended 1',
      'Social & Chat 3',
      'SMS & Voice 1',
      'Developer 1'
    ]);

    // the footer links to help choosing one
    const help = picker.shadowRoot.querySelector(
      '.footer .help'
    ) as HTMLAnchorElement;
    expect(help.getAttribute('href')).to.equal(
      'https://help.example.com/channels/'
    );
  });

  it('can show the types of other regions', async () => {
    const picker = await getPicker();
    const toggle = picker.shadowRoot.querySelector(
      '.regions input'
    ) as HTMLInputElement;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    await picker.updateComplete;

    expect(tileLabels(picker)).to.include('SMSCentral');
  });

  it('filters by category and search', async () => {
    const picker = await getPicker();

    (
      Array.from(
        picker.shadowRoot.querySelectorAll('.category')
      )[1] as HTMLElement
    ).click();
    await picker.updateComplete;
    expect(tileLabels(picker)).to.deep.equal(['Telegram']);

    await search(picker, 'whats');
    expect(tileLabels(picker)).to.deep.equal([]);

    (
      Array.from(
        picker.shadowRoot.querySelectorAll('.category')
      )[0] as HTMLElement
    ).click();
    await picker.updateComplete;
    expect(tileLabels(picker)).to.deep.equal([
      '360Dialog WhatsApp',
      'WhatsApp'
    ]);

    // the first match is highlighted for picking with the keyboard
    const tiles = picker.shadowRoot.querySelectorAll('.tile');
    expect(tiles[0].classList.contains('highlighted')).to.be.true;

    // searching by category name works too
    await search(picker, 'developer');
    expect(tileLabels(picker)).to.deep.equal(['External API']);
  });

  it('shows a type form and adds the channel', async () => {
    mockGET(
      /\/channels\/types\/telegram\/claim/,
      '/test/assets/channels/claim-form.html'
    );
    const picker = await getPicker();
    picker.pick(TYPES[2]);
    await picker.updateComplete;

    // wait for the form to load
    await waitForCondition(() => !!picker.querySelector('.channel-claim-form'));
    await picker.updateComplete;

    const container = picker.querySelector('.channel-claim-form');
    expect(container).to.not.be.null;
    expect(container.getAttribute('slot')).to.equal('form');

    // our footer has the buttons, and the form's scripts run once it's in place, as they would on its page
    expect(container.querySelector('.form-actions')).to.be.null;
    expect((window as any).claimFormScriptRan).to.equal(true);

    // the header has the type and its setup guide
    expect(
      picker.shadowRoot.querySelector('.form-header .name').textContent
    ).to.equal('Telegram');
    expect(
      picker.shadowRoot.querySelector('.form-header .help').getAttribute('href')
    ).to.equal('https://help.example.com/channels/telegram/');

    // submitting navigates to wherever the claim view says
    mockPOST(/\/channels\/types\/telegram\/claim/, '', {
      'X-Temba-Success': '/channels/channel/read/c-1/'
    });
    (container.querySelector('#id_auth_token') as HTMLInputElement).value =
      '123:abc';

    // a sign-in popup may have replaced the CSRF cookie since the form was rendered, so it posts the current one
    document.cookie = 'csrftoken=fresh; path=/';
    const csrfInput = container.querySelector(
      '[name=csrfmiddlewaretoken]'
    ) as HTMLInputElement;

    setTimeout(() => picker.submit());
    const event = await oneEvent(picker, CustomEventType.Redirected, false);
    expect(event.detail.url).to.equal('/channels/channel/read/c-1/');
    expect(csrfInput.value).to.equal('fresh');
    document.cookie = 'csrftoken=; path=/; max-age=0';
    expect(picker.open).to.be.false;
    expect(picker.querySelector('.channel-claim-form')).to.be.null;
  });

  it('shows errors from the claim view', async () => {
    mockGET(
      /\/channels\/types\/android\/claim/,
      '/test/assets/channels/claim-form.html'
    );
    mockPOST(
      /\/channels\/types\/android\/claim/,
      '<form><p class="errorlist">Invalid claim code</p></form>'
    );
    const picker = await getPicker();
    picker.pick(TYPES[3]);
    await waitForCondition(() => !!picker.querySelector('.channel-claim-form'));
    await picker.updateComplete;

    // a type without its own guide has no help link, as a general one wouldn't help with the form at hand
    expect(picker.shadowRoot.querySelector('.form-header .help')).to.be.null;

    picker.submit();
    await waitForCondition(
      () => !!picker.querySelector('.channel-claim-form .errorlist')
    );
    await picker.updateComplete;

    expect(picker.open).to.be.true;
    expect(
      picker.querySelector('.channel-claim-form .errorlist').textContent
    ).to.equal('Invalid claim code');
  });

  it('goes back to the types on escape, and closes on another', async () => {
    mockGET(
      /\/channels\/types\/telegram\/claim/,
      '/test/assets/channels/claim-form.html'
    );
    const picker = await getPicker();
    picker.pick(TYPES[2]);
    await waitForCondition(() => !!picker.querySelector('.channel-claim-form'));
    await picker.updateComplete;

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await picker.updateComplete;
    expect(picker.querySelector('.channel-claim-form')).to.be.null;
    expect(tileLabels(picker)).to.have.length(5);

    setTimeout(() =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    );
    await oneEvent(picker, CustomEventType.Canceled, false);
    expect(picker.open).to.be.false;
  });
});

describe('channel logos', () => {
  it('uses the type glyph, or a monogram when there is none', async () => {
    expect(getChannelIcon('TG')).to.equal('channel-telegram');
    expect(getChannelIcon('AT')).to.be.null;
    expect(getMonogram("Africa's Talking")).to.equal('AT');
    expect(getMonogram('Hub9')).to.equal('HU');

    // a type without a glyph of its own gets a monogram of its name
    const el = document.createElement('div');
    render(renderChannelLogo('ZZ', 'Zed Zone', 40), el);
    expect(el.querySelector('.monogram').textContent).to.equal('ZZ');

    // WhatsApp providers borrow WhatsApp's glyph and get a badge
    render(renderChannelLogo('TRN', 'Turn.io WhatsApp', 40), el);
    expect(el.querySelector('temba-icon').getAttribute('name')).to.equal(
      'channel-whatsapp'
    );
    expect(el.querySelector('.badge').textContent.trim()).to.equal('T');
  });
});
