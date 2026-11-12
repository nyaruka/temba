import { assert, expect, oneEvent } from '@open-wc/testing';
import { CustomEventType } from '../src/interfaces';
import { ChannelList } from '../src/list/ChannelList';
import { getComponent } from './utils.test';

const TAG = 'temba-channel-list';
const getChannelList = async (attrs: any = {}) => {
  return (await getComponent(TAG, attrs, '', 900)) as ChannelList;
};

const load = async (list: ChannelList, endpoint: string) => {
  const fetched = oneEvent(list, CustomEventType.FetchComplete, false);
  list.endpoint = endpoint;
  await fetched;
  await list.updateComplete;
};

const columnKeys = (list: ChannelList) =>
  (list as any).columns.map((c: any) => c.key);

describe('temba-channel-list', () => {
  it('can be created', async () => {
    const list = await getChannelList();
    assert.instanceOf(list, ChannelList);
    expect(list.valueKey).to.equal('uuid');
    expect((list as any).getRowHref({ uuid: 'c-001' })).to.equal(
      '/channels/channel/read/c-001/'
    );
  });

  it('shows a badge column only when a channel is slow', async () => {
    const list = await getChannelList();
    list.helpLinks = {
      channels: 'https://help.example.com/channels/',
      'channels.disabling': 'https://help.example.com/channels/disabling/'
    };

    await load(list, '/test/assets/channels/channels-fast.json');
    expect(columnKeys(list)).to.deep.equal([
      'name',
      'address',
      'received',
      'sent',
      'activity'
    ]);

    await load(list, '/test/assets/channels/channels.json');
    expect(columnKeys(list)).to.deep.equal([
      'name',
      'speed',
      'address',
      'received',
      'sent',
      'activity'
    ]);

    const badges = Array.from(
      list.shadowRoot.querySelectorAll('.speed')
    ) as HTMLAnchorElement[];
    expect(badges.map((b) => b.textContent.trim())).to.deep.equal([
      'Very slow',
      'Slow'
    ]);
    expect(badges[0].classList.contains('very_slow')).to.be.true;

    // with no throughput article, they link to the introduction to channels
    expect(badges[0].getAttribute('href')).to.equal(
      'https://help.example.com/channels/'
    );
    expect(badges[0].getAttribute('target')).to.equal('_blank');
  });

  it('greys out disabled channels and links to help on them', async () => {
    const list = await getChannelList();
    list.helpLinks = {
      'channels.disabling': 'https://help.example.com/channels/disabling/'
    };
    await load(list, '/test/assets/channels/channels.json');

    const rows = Array.from(list.shadowRoot.querySelectorAll('tr.row'));
    const disabled = rows.filter((r) => r.classList.contains('disabled'));
    expect(disabled).to.have.length(1);

    const link = disabled[0].querySelector('a.disabled') as HTMLAnchorElement;
    expect(link.textContent.trim()).to.equal('Disabled');
    expect(link.getAttribute('href')).to.equal(
      'https://help.example.com/channels/disabling/'
    );
  });

  it('draws sent and received in the sparkline', async () => {
    const list = await getChannelList();
    await load(list, '/test/assets/channels/channels.json');

    const rows = Array.from(list.shadowRoot.querySelectorAll('tr.row'));

    // a channel with activity gets both lines
    const busy = rows[0].querySelector('.sparkline');
    expect(busy.querySelectorAll('polyline.line')).to.have.length(2);
    expect(busy.querySelectorAll('polyline.secondary')).to.have.length(1);

    // and one with nothing in the window gets none, like flows
    expect(rows[3].querySelector('.sparkline')).to.be.null;
  });

  it('renders each channel with its type logo', async () => {
    const list = await getChannelList();
    await load(list, '/test/assets/channels/channels.json');

    const logos = Array.from(
      list.shadowRoot.querySelectorAll('.channel-name .channel-logo')
    );
    expect(logos).to.have.length(4);

    // whatsapp, twilio, android and vonage all have glyphs
    logos.forEach((logo) => {
      expect(logo.querySelector('temba-icon')).to.not.be.null;
    });
  });
});
