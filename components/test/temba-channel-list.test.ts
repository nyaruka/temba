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

  it('shows the status of each channel after its name', async () => {
    const list = await getChannelList();
    list.helpLinks = {
      channels: 'https://help.example.com/channels/',
      'channels.disabling': 'https://help.example.com/channels/disabling/'
    };

    await load(list, '/test/assets/channels/channels-fast.json');
    expect(columnKeys(list)).to.deep.equal([
      'name',
      'status',
      'address',
      'received',
      'sent',
      'activity'
    ]);

    const statusOf = (row: Element) =>
      row.querySelector('.status') as HTMLElement;

    // a healthy channel is ready, with its note on hover
    let rows = Array.from(list.shadowRoot.querySelectorAll('tr.row'));
    expect(statusOf(rows[0]).textContent.trim()).to.equal('Ready');
    expect(statusOf(rows[0]).classList.contains('good')).to.be.true;
    expect(statusOf(rows[0]).getAttribute('title')).to.equal(
      'Sending and receiving messages.'
    );

    await load(list, '/test/assets/channels/channels.json');
    rows = Array.from(list.shadowRoot.querySelectorAll('tr.row'));
    const statuses = rows.map(statusOf);

    // one that's failing shows its health in its tone
    expect(statuses[0].textContent.trim()).to.equal('Unhealthy');
    expect(statuses[0].classList.contains('bad')).to.be.true;
    expect(statuses[0].getAttribute('title')).to.equal(
      '71% of the last 650 messages sent have failed.'
    );

    // a healthy one which sends slowly says that instead, linking to help on it - with no throughput article, the
    // introduction to channels
    expect(statuses[1].textContent.trim()).to.equal('Very slow');
    expect(statuses[1].classList.contains('warn')).to.be.true;
    expect(statuses[1].getAttribute('href')).to.equal(
      'https://help.example.com/channels/'
    );
    expect(statuses[1].getAttribute('target')).to.equal('_blank');

    // but its slowness gives way to a problem with its health
    expect(statuses[2].textContent.trim()).to.equal('Not syncing');
    expect(statuses[2].classList.contains('warn')).to.be.true;
    expect(statuses[2].tagName).to.equal('SPAN');
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

    const link = disabled[0].querySelector('a.status') as HTMLAnchorElement;
    expect(link.textContent.trim()).to.equal('Disabled');
    expect(link.classList.contains('off')).to.be.true;
    expect(link.getAttribute('href')).to.equal(
      'https://help.example.com/channels/disabling/'
    );
  });

  it('draws all messages in the sparkline, or the failures of a failing channel', async () => {
    const list = await getChannelList();
    await load(list, '/test/assets/channels/channels.json');

    const rows = Array.from(list.shadowRoot.querySelectorAll('tr.row'));

    // a channel whose status is down to its failures shows the share that failed, in red
    const failing = rows[0].querySelector('.failing .sparkline');
    expect(failing).to.not.be.null;
    expect(failing.querySelectorAll('polyline.line')).to.have.length(1);

    // a healthy one gets a single line of everything sent and received
    const healthy = rows[1].querySelector('.sparkline');
    expect(rows[1].querySelector('.failing')).to.be.null;
    expect(healthy.querySelectorAll('polyline.line')).to.have.length(1);
    expect(healthy.querySelectorAll('polyline.secondary')).to.have.length(0);

    // and one with nothing in the window gets none, like flows
    expect(rows[3].querySelector('.sparkline')).to.be.null;
  });

  it('says the period the counts cover when they are hovered', async () => {
    const list = await getChannelList();
    await load(list, '/test/assets/channels/channels.json');

    // on the headings of the counted columns
    const tips = Array.from(
      list.shadowRoot.querySelectorAll('.head-inner temba-tip.label')
    ) as any[];
    expect(tips.map((t) => t.textContent.trim())).to.deep.equal([
      'Received',
      'Sent',
      'Activity'
    ]);
    tips.forEach((t) => expect(t.text).to.equal('Last 14 days'));

    // and on each sparkline
    const row = list.shadowRoot.querySelector('tr.row');
    const sparkTip = row.querySelector('temba-tip') as any;
    expect(sparkTip.querySelector('.sparkline')).to.not.be.null;
    expect(sparkTip.text).to.equal('Last 14 days');
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
