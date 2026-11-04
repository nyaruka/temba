import { expect, fixture } from '@open-wc/testing';
import { html } from 'lit';
import '../temba-modules';
import { HeaderBar } from '../src/layout/HeaderBar';
import { assertScreenshot, getClip } from './utils.test';

describe('temba-header-bar', () => {
  it('renders a fixed strip with its rule and grows slotted content', async () => {
    const bar = (await fixture(html`
      <temba-header-bar>
        <div id="content">title</div>
      </temba-header-bar>
    `)) as HeaderBar;

    const styles = getComputedStyle(bar);

    // the 52px strip plus its full-bleed 1px rule — an inset box-shadow
    // so host-page border resets (tailwind preflight) can't strip it
    expect(styles.height).to.equal('53px');
    expect(styles.boxShadow).to.contain('inset');
    expect(styles.display).to.equal('flex');

    // slotted content stretches to fill the strip
    const content = bar.querySelector('#content');
    expect(getComputedStyle(content).flexGrow).to.equal('1');
  });

  // Measured from the rendered boxes rather than read off the declared
  // padding, so a height that hands slack to one side of the title shows up.
  for (const subtitle of ['', 'Supporting context']) {
    it(`centers a fit-content title${subtitle ? ' with a subtitle' : ''}`, async () => {
      const bar = (await fixture(html`
        <temba-header-bar fit-content>
          <temba-page-header
            header-title="Knowledge"
            subtitle=${subtitle}
          ></temba-page-header>
        </temba-header-bar>
      `)) as HeaderBar;
      const header = bar.querySelector('temba-page-header') as HTMLElement & {
        updateComplete: Promise<unknown>;
      };
      await header.updateComplete;

      const barBox = bar.getBoundingClientRect();
      const titleBox = header.shadowRoot
        .querySelector('.title-block')
        .getBoundingClientRect();
      const actionsBox = header.shadowRoot
        .querySelector('.actions')
        .getBoundingClientRect();

      // the content sits evenly between the top of the bar and its rule
      const above = titleBox.top - barBox.top;
      const below = barBox.bottom - titleBox.bottom;
      expect(below, 'below title').to.be.closeTo(above, 0.5);

      // inset at the sides like the list pages' headers
      expect(titleBox.left - barBox.left, 'left of title').to.be.closeTo(
        12,
        0.5
      );
      expect(barBox.right - actionsBox.right, 'right of actions').to.be.closeTo(
        12,
        0.5
      );

      // the strip height is a floor: a single line fills it exactly, a
      // subtitle grows the bar by keeping the header's own 12px padding
      expect(getComputedStyle(bar).minHeight).to.equal('53px');
      if (subtitle) {
        expect(barBox.height).to.be.closeTo(titleBox.height + 24, 0.5);
        expect(barBox.height).to.be.greaterThan(53);
      } else {
        expect(barBox.height).to.be.closeTo(53, 0.5);
      }
    });
  }

  // the geometry assertions above prove the surround is balanced; these
  // record what that actually looks like, so a restyle that keeps the maths
  // true but changes the strip's character still shows up in review
  for (const subtitle of ['', 'Supporting context']) {
    const state = subtitle ? 'subtitle' : 'title-only';
    it(`renders a fit-content bar (${state}, screenshot)`, async () => {
      const bar = (await fixture(html`
        <div style="width: 700px;">
          <temba-header-bar fit-content>
            <temba-page-header
              header-title="Knowledge"
              subtitle=${subtitle}
            ></temba-page-header>
          </temba-header-bar>
        </div>
      `)) as HTMLElement;
      const header = bar.querySelector('temba-page-header') as HTMLElement & {
        updateComplete: Promise<unknown>;
      };
      await header.updateComplete;

      await assertScreenshot(
        `header-bar/fit-content-${state}`,
        getClip(bar.querySelector('temba-header-bar') as HeaderBar)
      );
    });
  }
});
