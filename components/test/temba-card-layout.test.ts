import { expect, fixture, oneEvent } from '@open-wc/testing';
import { html } from 'lit';
import { SinonStub } from 'sinon';
import { CustomEventType } from '../src/interfaces';
import { Card } from '../src/layout/Card';
import { CardLayout } from '../src/layout/CardLayout';
import {
  assertScreenshot,
  getClip,
  mockPOST,
  waitForCondition
} from './utils.test';

const LAYOUT = html`
  <temba-card-layout breakpoint="800">
    <div slot="main" id="main-view" style="height:200px">main content</div>
    <temba-card id="card-a" label="Alpha" icon="info">
      <div id="panel-a" style="height:30px">A</div>
    </temba-card>
    <temba-card id="card-b" label="Beta" icon="fields" count="3">
      <div id="panel-b" style="height:30px">B</div>
    </temba-card>
  </temba-card-layout>
`;

const HEADED_LAYOUT = html`
  <temba-card-layout breakpoint="800" style="height:300px">
    <div slot="header" id="header" style="padding:12px">Amina Mwangi</div>
    <div slot="main" id="main-view" style="flex-grow:1">main content</div>
    <temba-card id="card-a" label="Alpha" icon="info">
      <div id="panel-a" style="height:30px">A</div>
    </temba-card>
    <temba-card id="card-b" label="Beta" icon="fields" count="3">
      <div id="panel-b" style="height:30px">B</div>
    </temba-card>
  </temba-card-layout>
`;

const createLayout = async (width: number, def = LAYOUT) => {
  const parentNode = document.createElement('div');
  parentNode.setAttribute('style', `width: ${width}px; display: flex;`);
  const layout = (await fixture(def, { parentNode })) as CardLayout;
  // the resize handles only appear once the layout has observed its own
  // width, so wait for that as well as the mode
  await waitForCondition(
    () => layout.hostWidth > 0 && layout.narrow === width < 800
  );
  await layout.updateComplete;
  return layout;
};

describe('temba-card-layout', () => {
  it('renders the card column when wide', async () => {
    const layout = await createLayout(1000);

    expect(layout.narrow).to.be.false;
    expect(layout.shadowRoot.querySelector('temba-card-stack')).to.exist;
    expect(layout.shadowRoot.querySelector('temba-tabs')).to.not.exist;

    layout.getCards().forEach((card) => {
      expect(card.hasAttribute('plain')).to.be.false;
      expect(card.hasAttribute('slot')).to.be.false;
    });
  });

  it('renders tabs when narrow', async () => {
    const layout = await createLayout(600);

    expect(layout.narrow).to.be.true;
    expect(layout.shadowRoot.querySelector('temba-tabs')).to.exist;
    expect(layout.shadowRoot.querySelector('temba-card-stack')).to.not.exist;

    // no card column running to the edge — the layout supplies the right
    // inset itself so every page gets the same treatment
    expect(getComputedStyle(layout).paddingRight).to.equal('8px');

    // main first, then one tab per card
    const tabs = layout.shadowRoot.querySelectorAll('temba-tab');
    expect(tabs.length).to.equal(3);
    expect(tabs[0].getAttribute('name')).to.equal('Chat');
    expect(tabs[1].getAttribute('name')).to.equal('Alpha');
    expect(tabs[2].getAttribute('name')).to.equal('Beta');

    // cards are chromeless and routed to their tab slots
    layout.getCards().forEach((card) => {
      expect(card.hasAttribute('plain')).to.be.true;
      expect(card.getAttribute('slot')).to.equal(`panel-${card.id}`);
    });
  });

  it('heads the main view with the header in one card when wide', async () => {
    const layout = await createLayout(1000, HEADED_LAYOUT);
    await waitForCondition(
      () => !!layout.shadowRoot.querySelector('.frame.framed')
    );

    // the header and main view share the frame, the cards stay outside it
    const frame = layout.shadowRoot.querySelector('.frame.framed');
    expect(frame.closest('.main')).to.exist;
    expect(frame.querySelector('slot[name="header"]')).to.exist;
    expect(frame.querySelector('slot[name="main"]')).to.exist;
    expect(frame.querySelector('temba-card-stack')).to.not.exist;

    await assertScreenshot('layout/headed-wide', getClip(layout));
  });

  it('takes the tabs into the header card when narrow', async () => {
    const layout = await createLayout(600, HEADED_LAYOUT);
    await waitForCondition(
      () => !!layout.shadowRoot.querySelector('.frame.framed')
    );

    const frame = layout.shadowRoot.querySelector('.frame.framed');
    expect(frame.querySelector('temba-tabs')).to.exist;

    // the cards inside it drop their own chrome
    const card = layout.querySelector('#card-a') as Card;
    expect(card.hasAttribute('plain')).to.be.true;
    const cardFrame = card.shadowRoot.querySelector('.frame') as HTMLElement;
    expect(getComputedStyle(cardFrame).borderTopStyle).to.equal('none');

    await assertScreenshot('layout/headed-narrow', getClip(layout));
  });

  it('leaves the layout unframed without a header', async () => {
    const layout = await createLayout(1000);
    const frame = layout.shadowRoot.querySelector('.frame') as HTMLElement;
    expect(frame.classList.contains('framed')).to.be.false;
    expect(getComputedStyle(frame).display).to.equal('contents');
  });

  it('keeps panel instances connected across mode switches', async () => {
    const layout = await createLayout(1000);
    const panel = layout.querySelector('#panel-a');
    const main = layout.querySelector('#main-view');

    // squeeze below the breakpoint
    (layout.parentElement as HTMLElement).style.width = '600px';
    await waitForCondition(() => layout.narrow);
    await layout.updateComplete;

    expect(layout.querySelector('#panel-a')).to.equal(panel);
    expect(panel.isConnected).to.be.true;
    expect(main.isConnected).to.be.true;

    // and back out again
    (layout.parentElement as HTMLElement).style.width = '1000px';
    await waitForCondition(() => !layout.narrow);
    await layout.updateComplete;

    expect(layout.querySelector('#panel-a')).to.equal(panel);
    expect(panel.isConnected).to.be.true;
    expect(layout.querySelector('#card-a').hasAttribute('plain')).to.be.false;
  });

  it('applies an initial order', async () => {
    const layout = await createLayout(
      1000,
      html`
        <temba-card-layout breakpoint="800" order='["card-b", "card-a"]'>
          <div slot="main">main</div>
          <temba-card id="card-a" label="Alpha"><div>A</div></temba-card>
          <temba-card id="card-b" label="Beta"><div>B</div></temba-card>
        </temba-card-layout>
      `
    );

    expect(layout.getIds()).to.deep.equal(['card-b', 'card-a']);
  });

  it('computes the flip point from the column footprint by default', async () => {
    // no explicit breakpoint: flips when the main view cannot get its
    // minimum width (420) beside the column footprint (384) = 804
    const parentNode = document.createElement('div');
    parentNode.setAttribute('style', 'width: 780px; display: flex;');
    const layout = (await fixture(
      html`
        <temba-card-layout>
          <div slot="main">main</div>
          <temba-card id="card-a" label="Alpha"><div>A</div></temba-card>
        </temba-card-layout>
      `,
      { parentNode }
    )) as CardLayout;

    await waitForCondition(() => layout.narrow);
    expect(layout.shadowRoot.querySelector('temba-tabs')).to.exist;

    parentNode.style.width = '850px';
    await waitForCondition(() => !layout.narrow);
    expect(layout.shadowRoot.querySelector('temba-card-stack')).to.exist;
  });

  it('refreshes tab badges when a projected panel reports details', async () => {
    const layout = await createLayout(600);
    expect(layout.narrow).to.be.true;

    // card-b starts with count 3 on its tab
    let tabs = layout.shadowRoot.querySelectorAll('temba-tab');
    expect(tabs[2].getAttribute('count')).to.equal('3');

    layout.querySelector('#panel-b').dispatchEvent(
      new CustomEvent('temba-details-changed', {
        detail: { count: 7 },
        bubbles: true,
        composed: true
      })
    );
    await waitForCondition(() => {
      const entries = layout.shadowRoot.querySelectorAll('temba-tab');
      return entries[2].getAttribute('count') === '7';
    });

    tabs = layout.shadowRoot.querySelectorAll('temba-tab');
    expect(tabs[2].getAttribute('count')).to.equal('7');
  });

  it('shrinks tab labels when the pane is very tight', async () => {
    const layout = await createLayout(700);
    expect(layout.narrow).to.be.true;
    expect(layout.compactTabs).to.be.false;

    let tabs = layout.shadowRoot.querySelector('temba-tabs') as any;
    expect(tabs.focusedName).to.be.false;

    (layout.parentElement as HTMLElement).style.width = '500px';
    await waitForCondition(() => layout.compactTabs);
    await layout.updateComplete;

    tabs = layout.shadowRoot.querySelector('temba-tabs') as any;
    expect(tabs.focusedName).to.be.true;
  });

  it('resolves narrow when revealed inside a small pane', async () => {
    // ticket page pattern: the layout is display:none until a selection is
    // made — when revealed it must pick the right mode for its width
    const parentNode = document.createElement('div');
    parentNode.setAttribute('style', 'width: 600px; display: flex;');
    const layout = (await fixture(
      html`
        <temba-card-layout breakpoint="800" style="display: none;">
          <div slot="main">main</div>
          <temba-card id="card-a" label="Alpha"><div>A</div></temba-card>
        </temba-card-layout>
      `,
      { parentNode }
    )) as CardLayout;

    // hidden — no width yet, stays at the default
    expect(layout.narrow).to.be.false;

    layout.style.display = '';
    await waitForCondition(() => layout.narrow);
    expect(layout.shadowRoot.querySelector('temba-tabs')).to.exist;
  });

  it('goes narrow when a fixed-width sibling squeezes it', async () => {
    // ticket page pattern: a resizable list sits beside the layout
    const parentNode = document.createElement('div');
    parentNode.setAttribute('style', 'width: 1000px; display: flex;');
    const layout = (await fixture(
      html`
        <temba-card-layout
          breakpoint="800"
          style="flex: 1 1 auto; min-width: 0;"
        >
          <div slot="main">main</div>
          <temba-card id="card-a" label="Alpha"><div>A</div></temba-card>
        </temba-card-layout>
      `,
      { parentNode }
    )) as CardLayout;

    const sibling = document.createElement('div');
    sibling.setAttribute('style', 'flex: 0 0 150px;');
    parentNode.prepend(sibling);
    await waitForCondition(() => !layout.narrow);

    // widen the "ticket list" so the layout drops below the breakpoint
    sibling.style.flexBasis = '450px';
    await waitForCondition(() => layout.narrow);
    expect(layout.shadowRoot.querySelector('temba-tabs')).to.exist;
  });

  describe('resizing', () => {
    const press = (handle: Element, x: number) => {
      handle.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          button: 0,
          clientX: x,
          cancelable: true,
          pointerType: 'mouse'
        })
      );
    };
    const move = (x: number) => {
      window.dispatchEvent(
        new PointerEvent('pointermove', {
          clientX: x,
          cancelable: true,
          pointerType: 'mouse'
        })
      );
    };
    const release = () => {
      window.dispatchEvent(
        new PointerEvent('pointerup', { pointerType: 'mouse' })
      );
    };

    it('resizes the main view by dragging the divider', async () => {
      const layout = await createLayout(1000);
      const handle = layout.shadowRoot.querySelector('.resize-handle');
      const main = layout.shadowRoot.querySelector('.main') as HTMLElement;
      const startWidth = main.offsetWidth;

      press(handle, 600);
      move(500);
      await layout.updateComplete;

      expect(layout.mainWidth).to.equal(startWidth - 100);
      expect(layout.narrow).to.be.false;

      // dragging way past the left edge clamps at the main minimum
      move(-1000);
      await layout.updateComplete;
      expect(layout.mainWidth).to.equal(layout.mainMinWidth);

      const resized = oneEvent(layout, CustomEventType.Resized, false);
      release();
      const event = await resized;
      expect(event.detail.width).to.equal(layout.mainMinWidth);

      expect(main.offsetWidth).to.equal(layout.mainMinWidth);
    });

    it('pins the chat at the widest fit and flips to tabs only after dragging across the cards', async () => {
      const layout = await createLayout(1000);
      const handle = layout.shadowRoot.querySelector('.resize-handle');
      const max = 1000 - CardLayout.COLUMN_FOOTPRINT;

      // past the widest fit the chat pins there instead of flipping
      press(handle, 600);
      move(700);
      await layout.updateComplete;
      expect(layout.mainWidth).to.equal(max);
      expect(layout.narrow).to.be.false;

      // ...until the pointer has crossed most of the card column
      move(920);
      await waitForCondition(() => layout.narrow);
      expect(layout.shadowRoot.querySelector('temba-tabs')).to.exist;

      // coming back a little is not enough to bring the cards back
      move(700);
      await layout.updateComplete;
      expect(layout.narrow).to.be.true;

      // but coming back across the card area pops them back out, with
      // the chat at the widest width that fits them
      move(690);
      await waitForCondition(() => !layout.narrow);
      expect(layout.shadowRoot.querySelector('temba-card-stack')).to.exist;
      expect(layout.mainWidth).to.equal(max);
      release();
    });

    it('leaves tab mode only after dragging back across the cards', async () => {
      const layout = await createLayout(1000);

      // a saved width too wide for the window forces tab mode
      layout.mainWidth = 700;
      await waitForCondition(() => layout.narrow);
      await layout.updateComplete;

      // wide enough to reach card mode, so the tab view offers a handle
      const handle = layout.shadowRoot.querySelector('.resize-handle.edge');
      expect(handle).to.exist;

      // a small movement is not enough to pop out of tab mode
      press(handle, 995);
      move(985);
      await layout.updateComplete;
      expect(layout.narrow).to.be.true;

      // dragging most of the way back across the card area brings the
      // cards back, with the chat at the widest width that fits them
      move(700);
      await waitForCondition(() => !layout.narrow);
      expect(layout.mainWidth).to.equal(1000 - CardLayout.COLUMN_FOOTPRINT);

      // and further dragging shrinks the chat from there
      move(500);
      await layout.updateComplete;
      expect(layout.mainWidth).to.equal(505);
      release();
    });

    it('offers no tab-mode resize when the window cannot fit card mode', async () => {
      const layout = await createLayout(600);
      expect(layout.narrow).to.be.true;
      expect(layout.shadowRoot.querySelector('.resize-handle')).to.not.exist;
    });

    it('offers no resize when the breakpoint keeps card mode out of reach', async () => {
      // the layout could fit the chat beside the cards, but the explicit
      // breakpoint holds it in tabs — a drag could only strand it there
      const parentNode = document.createElement('div');
      parentNode.setAttribute('style', 'width: 1000px; display: flex;');
      const layout = (await fixture(
        html`
          <temba-card-layout breakpoint="1200">
            <div slot="main">main</div>
            <temba-card id="card-a" label="Alpha"><div>A</div></temba-card>
          </temba-card-layout>
        `,
        { parentNode }
      )) as CardLayout;

      await waitForCondition(() => layout.hostWidth > 0 && layout.narrow);
      await layout.updateComplete;
      expect(layout.shadowRoot.querySelector('.resize-handle')).to.not.exist;
    });

    it('offers no card-mode resize when the layout is too tight', async () => {
      // a low breakpoint keeps the cards, but there is no room to drag:
      // the chat at its minimum plus the column footprint doesn't fit
      const parentNode = document.createElement('div');
      parentNode.setAttribute('style', 'width: 700px; display: flex;');
      const layout = (await fixture(
        html`
          <temba-card-layout breakpoint="400">
            <div slot="main">main</div>
            <temba-card id="card-a" label="Alpha"><div>A</div></temba-card>
          </temba-card-layout>
        `,
        { parentNode }
      )) as CardLayout;

      await waitForCondition(() => layout.hostWidth > 0);
      await layout.updateComplete;
      expect(layout.narrow).to.be.false;
      expect(layout.shadowRoot.querySelector('temba-card-stack')).to.exist;
      expect(layout.shadowRoot.querySelector('.resize-handle')).to.not.exist;
    });

    it('ignores a press that never moves', async () => {
      const layout = await createLayout(1000);
      const handle = layout.shadowRoot.querySelector('.resize-handle');
      let resized = false;
      layout.addEventListener(CustomEventType.Resized, () => (resized = true));

      // a trackpad click can fire a pointermove with no travel — it must
      // not commit a width (which would also fix the automatic width)
      press(handle, 600);
      move(600);
      release();
      await layout.updateComplete;

      expect(layout.mainWidth).to.equal(0);
      expect(resized).to.be.false;
    });

    it('ignores a press that only drifts a pixel', async () => {
      const layout = await createLayout(1000);
      const handle = layout.shadowRoot.querySelector('.resize-handle');
      let resized = false;
      layout.addEventListener(CustomEventType.Resized, () => (resized = true));

      // a click carries a pixel or two of drift — below the threshold it
      // stays a click, so the width stays automatic and the flip point
      // doesn't move
      press(handle, 600);
      move(601);
      move(599);
      release();
      await layout.updateComplete;

      expect(layout.mainWidth).to.equal(0);
      expect(resized).to.be.false;

      // real travel still resizes
      press(handle, 600);
      move(590);
      await layout.updateComplete;
      expect(layout.mainWidth).to.be.greaterThan(0);
      release();
    });

    it('restores the width when a drag is cancelled', async () => {
      const layout = await createLayout(1000);
      const handle = layout.shadowRoot.querySelector('.resize-handle');
      const main = layout.shadowRoot.querySelector('.main') as HTMLElement;
      const startWidth = main.offsetWidth;

      press(handle, 600);
      move(500);
      await layout.updateComplete;
      expect(layout.mainWidth).to.equal(startWidth - 100);

      window.dispatchEvent(
        new PointerEvent('pointercancel', { pointerType: 'mouse' })
      );
      await layout.updateComplete;
      expect(layout.mainWidth).to.equal(0);
    });

    describe('keyboard', () => {
      const arrow = (handle: Element, key: string, shiftKey = false) => {
        handle.dispatchEvent(
          new KeyboardEvent('keydown', { key, shiftKey, bubbles: true })
        );
      };

      it('resizes in steps with the arrow keys', async () => {
        const layout = await createLayout(1000);
        layout.mainWidth = 500;
        await layout.updateComplete;
        const handle = layout.shadowRoot.querySelector('.resize-handle');

        arrow(handle, 'ArrowLeft');
        await layout.updateComplete;
        expect(layout.mainWidth).to.equal(490);

        // shift takes bigger bites
        arrow(handle, 'ArrowLeft', true);
        await layout.updateComplete;
        expect(layout.mainWidth).to.equal(465);

        arrow(handle, 'ArrowRight');
        await layout.updateComplete;
        expect(layout.mainWidth).to.equal(475);

        // rapid presses in the same task each take a full step — stepping
        // works from state, not from a measurement that hasn't flushed
        arrow(handle, 'ArrowLeft');
        arrow(handle, 'ArrowLeft');
        arrow(handle, 'ArrowLeft');
        await layout.updateComplete;
        expect(layout.mainWidth).to.equal(445);
      });

      it('grows no further than the widest fit', async () => {
        const layout = await createLayout(1000);
        layout.mainWidth = 620;
        await layout.updateComplete;
        const handle = layout.shadowRoot.querySelector('.resize-handle');

        arrow(handle, 'ArrowRight', true);
        await layout.updateComplete;
        expect(layout.mainWidth).to.equal(1000 - CardLayout.COLUMN_FOOTPRINT);
        expect(layout.narrow).to.be.false;
      });

      it('announces keyboard resizes', async () => {
        const layout = await createLayout(1000);
        const handle = layout.shadowRoot.querySelector('.resize-handle');

        const resized = oneEvent(layout, CustomEventType.Resized, false);
        arrow(handle, 'ArrowLeft');
        const event = await resized;
        expect(event.detail.width).to.equal(layout.mainWidth);
      });

      it('never shrinks the chat when growing from tab mode', async () => {
        const layout = await createLayout(1000);
        layout.mainWidth = 700;
        await waitForCondition(() => layout.narrow);
        await layout.updateComplete;

        const handle = layout.shadowRoot.querySelector('.resize-handle.edge');
        arrow(handle, 'ArrowRight');
        await layout.updateComplete;

        // the tab pane is already wider than any card-mode width — the
        // grow is a no-op rather than a jump back to the cards
        expect(layout.mainWidth).to.equal(700);
        expect(layout.narrow).to.be.true;
      });

      it('shrinks from tab mode straight into card mode', async () => {
        const layout = await createLayout(1000);
        layout.mainWidth = 700;
        await waitForCondition(() => layout.narrow);
        await layout.updateComplete;

        const handle = layout.shadowRoot.querySelector('.resize-handle.edge');
        arrow(handle, 'ArrowLeft');
        await waitForCondition(() => !layout.narrow);
        await layout.updateComplete;

        // one shrink press lands at the widest width the cards leave room
        // for — the keyboard needs no drag-style hysteresis
        expect(layout.mainWidth).to.equal(1000 - CardLayout.COLUMN_FOOTPRINT);
        expect(layout.shadowRoot.querySelector('temba-card-stack')).to.exist;

        // the flip rebuilt the handle from the other template — focus
        // follows it so the keyboard user isn't stranded
        expect(layout.shadowRoot.activeElement).to.equal(
          layout.shadowRoot.querySelector('.resize-handle')
        );
      });
    });

    describe('aria', () => {
      it('advertises the resize range from the template', async () => {
        const layout = await createLayout(1000);
        const handle = layout.shadowRoot.querySelector('.resize-handle');
        const max = 1000 - CardLayout.COLUMN_FOOTPRINT;

        expect(handle.getAttribute('role')).to.equal('separator');
        expect(handle.getAttribute('aria-valuemin')).to.equal(
          `${layout.mainMinWidth}`
        );
        expect(handle.getAttribute('aria-valuemax')).to.equal(`${max}`);
        // announced before any interaction, and kept current afterwards
        expect(handle.getAttribute('aria-valuenow')).to.equal(`${max}`);

        layout.mainWidth = 500;
        await layout.updateComplete;
        expect(
          layout.shadowRoot
            .querySelector('.resize-handle')
            .getAttribute('aria-valuenow')
        ).to.equal('500');
      });

      it('keeps the announced width inside the range in tab mode', async () => {
        const layout = await createLayout(1000);
        layout.mainWidth = 700;
        await waitForCondition(() => layout.narrow);
        await layout.updateComplete;

        const handle = layout.shadowRoot.querySelector('.resize-handle.edge');
        const max = 1000 - CardLayout.COLUMN_FOOTPRINT;
        expect(handle.getAttribute('aria-valuemax')).to.equal(`${max}`);
        // the pane spans the whole layout in tabs — announce the maximum
        // rather than a value outside the advertised range
        expect(handle.getAttribute('aria-valuenow')).to.equal(`${max}`);
      });
    });

    it('stops tracking the pointer once the drag is released', async () => {
      const layout = await createLayout(1000);
      const handle = layout.shadowRoot.querySelector('.resize-handle');

      press(handle, 600);
      move(500);
      await layout.updateComplete;
      const released = layout.mainWidth;

      release();
      move(300);
      await layout.updateComplete;
      expect(layout.mainWidth).to.equal(released);
    });

    it('restores the body styles when removed mid-drag', async () => {
      const layout = await createLayout(1000);
      const handle = layout.shadowRoot.querySelector('.resize-handle');

      press(handle, 600);
      move(500);
      expect(document.body.style.cursor).to.equal('col-resize');
      expect(document.body.style.userSelect).to.equal('none');

      layout.remove();
      expect(document.body.style.cursor).to.equal('');
      expect(document.body.style.userSelect).to.equal('');
    });
  });

  describe('settings persistence', () => {
    const SETTINGS_URL = /\/user\/settings\//;

    // HTMLElement.click() is unreliable under the puppeteer harness —
    // dispatch the click on a card's header directly
    const clickHeader = (card: Card) => {
      card.shadowRoot
        .querySelector('.card-header')
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    };

    const getSettingsPosts = () => {
      return (window.fetch as SinonStub)
        .getCalls()
        .filter(
          (call) =>
            SETTINGS_URL.test(String(call.args[0])) &&
            call.args[1]?.method === 'POST'
        )
        .map((call) => JSON.parse(call.args[1].body));
    };

    const createPersistentLayout = async (settings: string) => {
      mockPOST(SETTINGS_URL, { settings: {} });
      const initialPosts = getSettingsPosts().length;
      const layout = await createLayout(
        1000,
        html`
          <temba-card-layout
            breakpoint="800"
            settings-endpoint="/user/settings/"
            settings=${settings}
          >
            <div slot="main">main</div>
            <temba-card id="card-a" label="Alpha"><div>A</div></temba-card>
            <temba-card id="card-b" label="Beta"><div>B</div></temba-card>
          </temba-card-layout>
        `
      );
      layout.saveDelay = 10;
      return {
        layout,
        newPosts: () => getSettingsPosts().slice(initialPosts)
      };
    };

    it('seeds order and collapsed state from settings', async () => {
      const { layout } = await createPersistentLayout(
        '{"order": ["card-b", "card-a"], "collapsed": ["card-a"]}'
      );

      expect(layout.getIds()).to.deep.equal(['card-b', 'card-a']);
      expect((layout.querySelector('#card-a') as Card).collapsed).to.be.true;
      expect((layout.querySelector('#card-b') as Card).collapsed).to.be.false;
    });

    it('posts merged settings on toggle without clobbering other pages', async () => {
      // saved state includes cards this page doesn't render — card-x in the
      // order and card-z collapsed — which must survive a save from here
      const { layout, newPosts } = await createPersistentLayout(
        '{"order": ["card-b", "card-x", "card-a"], "collapsed": ["card-z", "card-a"]}'
      );
      expect(layout.getIds()).to.deep.equal(['card-b', 'card-a']);

      // expand card-a
      clickHeader(layout.querySelector('#card-a') as Card);

      await waitForCondition(() => newPosts().length > 0);
      expect(newPosts()[0]).to.deep.equal({
        contact_cards: {
          order: ['card-b', 'card-x', 'card-a'],
          collapsed: ['card-z']
        }
      });
    });

    it('posts the merged order after a drag', async () => {
      const { layout, newPosts } = await createPersistentLayout(
        '{"order": ["card-x", "card-a", "card-b"]}'
      );
      expect(layout.getIds()).to.deep.equal(['card-a', 'card-b']);

      const header = layout
        .querySelector('#card-a')
        .shadowRoot.querySelector('.card-header') as HTMLElement;
      const rect = header.getBoundingClientRect();
      const bounds = layout.getBoundingClientRect();

      await moveMouse(rect.left + rect.width / 2, rect.top + rect.height / 2);
      await mouseDown();
      await moveMouse(rect.left + rect.width / 2, bounds.bottom - 5);
      await mouseUp();

      // card-x keeps its saved slot; the present cards swap around it
      await waitForCondition(() => newPosts().length > 0);
      expect(newPosts()[0].contact_cards.order).to.deep.equal([
        'card-x',
        'card-b',
        'card-a'
      ]);
    });

    it('seeds the main width from settings and includes it in saves', async () => {
      const { layout, newPosts } =
        await createPersistentLayout('{"width": 500}');
      expect(layout.mainWidth).to.equal(500);
      expect(layout.narrow).to.be.false;

      clickHeader(layout.querySelector('#card-a') as Card);
      await waitForCondition(() => newPosts().length > 0);
      expect(newPosts()[0].contact_cards.width).to.equal(500);
    });

    it('keeps the saved width when this page has no chosen width', async () => {
      // the width is shared across pages like the order and collapsed
      // lists — a save from a page rendering at the automatic width must
      // carry the stored width through rather than clearing it
      const { layout, newPosts } =
        await createPersistentLayout('{"width": 500}');
      layout.mainWidth = 0;
      await layout.updateComplete;

      clickHeader(layout.querySelector('#card-a') as Card);
      await waitForCondition(() => newPosts().length > 0);
      expect(newPosts()[0].contact_cards.width).to.equal(500);
    });

    it('renders a sub-floor saved width at the floor without rewriting it', async () => {
      // a width chosen on a page with a lower main-min-width still renders
      // at this page's floor, but the stored value must survive a save so
      // the page it was chosen on keeps it
      const { layout, newPosts } =
        await createPersistentLayout('{"width": 300}');
      expect(layout.mainWidth).to.equal(300);
      expect(layout.narrow).to.be.false;

      const main = layout.shadowRoot.querySelector('.main') as HTMLElement;
      expect(main.offsetWidth).to.equal(layout.mainMinWidth);

      clickHeader(layout.querySelector('#card-a') as Card);
      await waitForCondition(() => newPosts().length > 0);
      expect(newPosts()[0].contact_cards.width).to.equal(300);
    });

    it('returns to the automatic width on double-click', async () => {
      const { layout, newPosts } =
        await createPersistentLayout('{"width": 500}');
      expect(layout.mainWidth).to.equal(500);

      const handle = layout.shadowRoot.querySelector('.resize-handle');
      const resized = oneEvent(layout, CustomEventType.Resized, false);
      handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

      const event = await resized;
      expect(event.detail.width).to.equal(0);
      expect(layout.mainWidth).to.equal(0);
      await layout.updateComplete;
      expect(layout.style.getPropertyValue('--main-width')).to.equal('');

      // an explicit reset clears the stored width rather than carrying
      // it through
      await waitForCondition(() => newPosts().length > 0);
      expect(newPosts()[0].contact_cards.width).to.be.undefined;
    });

    it('posts the width after a resize drag', async () => {
      const { layout, newPosts } = await createPersistentLayout('{}');
      const handle = layout.shadowRoot.querySelector('.resize-handle');

      handle.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          button: 0,
          clientX: 600,
          cancelable: true,
          pointerType: 'mouse'
        })
      );
      window.dispatchEvent(
        new PointerEvent('pointermove', {
          clientX: 500,
          cancelable: true,
          pointerType: 'mouse'
        })
      );
      window.dispatchEvent(
        new PointerEvent('pointerup', { pointerType: 'mouse' })
      );

      await waitForCondition(() => newPosts().length > 0);
      expect(newPosts()[0].contact_cards.width).to.equal(layout.mainWidth);
      expect(layout.mainWidth).to.be.greaterThan(0);
    });

    it('flushes a pending save on disconnect', async () => {
      const { layout, newPosts } = await createPersistentLayout('{}');
      layout.saveDelay = 60000;

      clickHeader(layout.querySelector('#card-a') as Card);
      expect(newPosts().length).to.equal(0);

      layout.remove();
      await waitForCondition(() => newPosts().length > 0);
      expect(newPosts()[0].contact_cards.collapsed).to.deep.equal(['card-a']);
    });
  });

  it('reorders on drag through the forwarded slots', async () => {
    const layout = await createLayout(1000);

    const header = layout
      .querySelector('#card-a')
      .shadowRoot.querySelector('.card-header') as HTMLElement;
    const rect = header.getBoundingClientRect();
    const bounds = layout.getBoundingClientRect();

    const orderChanged = oneEvent(layout, CustomEventType.OrderChanged, false);

    await moveMouse(rect.left + rect.width / 2, rect.top + rect.height / 2);
    await mouseDown();
    await moveMouse(rect.left + rect.width / 2, bounds.bottom - 5);
    await mouseUp();

    const event = await orderChanged;
    expect(event.detail.ids).to.deep.equal(['card-b', 'card-a']);
    expect(layout.getIds()).to.deep.equal(['card-b', 'card-a']);

    // a later squeeze into tabs reflects the dragged order
    (layout.parentElement as HTMLElement).style.width = '600px';
    await waitForCondition(() => layout.narrow);
    await layout.updateComplete;

    const tabs = layout.shadowRoot.querySelectorAll('temba-tab');
    expect(tabs[1].getAttribute('name')).to.equal('Beta');
    expect(tabs[2].getAttribute('name')).to.equal('Alpha');
  });
});
