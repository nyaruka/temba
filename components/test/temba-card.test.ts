import { expect, fixture, oneEvent } from '@open-wc/testing';
import { html } from 'lit';
import { Card } from '../src/layout/Card';
import { assertScreenshot, getClip } from './utils.test';

const getCard = async (def: any) => {
  const parentNode = document.createElement('div');
  parentNode.setAttribute('style', 'width: 300px;');
  return (await fixture(def, { parentNode })) as Card;
};

describe('temba-card', () => {
  it('renders label and icon', async () => {
    const card = await getCard(html`
      <temba-card label="Details" icon="info">
        <div>Some content</div>
      </temba-card>
    `);

    expect(card.shadowRoot.textContent).to.contain('Details');
    expect(card.shadowRoot.querySelector('.label temba-icon')).to.exist;
    await assertScreenshot('layout/card', getClip(card));
  });

  it('is picked up by its grip unless given another icon', async () => {
    const card = await getCard(html`
      <temba-card label="Details"><div>Some content</div></temba-card>
    `);
    const grip = card.shadowRoot.querySelector('.grip');
    expect(grip.getAttribute('name')).to.equal('dots-grid');

    card.setAttribute('grip-icon', 'folder');
    await card.updateComplete;
    expect(grip.getAttribute('name')).to.equal('folder');
  });

  it('renders collapsed', async () => {
    const card = await getCard(html`
      <temba-card label="Details" icon="info" collapsed>
        <div>Some content</div>
      </temba-card>
    `);

    expect(card.collapsed).to.be.true;
    expect(card.shadowRoot.querySelector('.body.collapsed')).to.exist;
    await assertScreenshot('layout/card-collapsed', getClip(card));
  });

  it('toggles on header click and fires toggle', async () => {
    const card = await getCard(html`
      <temba-card label="Details">
        <div>Some content</div>
      </temba-card>
    `);

    const header = card.shadowRoot.querySelector('.card-header') as HTMLElement;

    const toggled = oneEvent(card, 'toggle', false);
    header.click();
    const event = await toggled;

    expect(event.detail).to.deep.equal({ collapsed: true, label: 'Details' });
    expect(card.collapsed).to.be.true;

    header.click();
    await card.updateComplete;
    expect(card.collapsed).to.be.false;
  });

  it('shows count badge', async () => {
    const card = await getCard(html`
      <temba-card label="Fields" count="12">
        <div>Some content</div>
      </temba-card>
    `);

    const badge = card.shadowRoot.querySelector('.count');
    expect(badge.textContent.trim()).to.equal('12');
    expect(card.shadowRoot.querySelector('.dot')).to.not.exist;
  });

  it('shows activity dot instead of count', async () => {
    const card = await getCard(html`
      <temba-card label="Notepad" count="1" activity>
        <div>Some content</div>
      </temba-card>
    `);

    expect(card.shadowRoot.querySelector('.dot')).to.exist;
    expect(card.shadowRoot.querySelector('.count')).to.not.exist;
  });

  it('updates count and dirty from slotted details-changed', async () => {
    const card = await getCard(html`
      <temba-card label="Fields">
        <div id="content">Some content</div>
      </temba-card>
    `);

    expect(card.count).to.equal(0);
    expect(card.shadowRoot.querySelector('.count')).to.not.exist;

    card.querySelector('#content').dispatchEvent(
      new CustomEvent('temba-details-changed', {
        detail: { count: 3, dirty: true },
        bubbles: true,
        composed: true
      })
    );
    await card.updateComplete;

    expect(card.count).to.equal(3);
    expect(card.dirty).to.be.true;
    expect(card.shadowRoot.querySelector('.count').textContent.trim()).to.equal(
      '3'
    );
    expect(card.shadowRoot.textContent).to.contain('*');
  });

  it('drops content padding in bleed mode', async () => {
    const card = await getCard(html`
      <temba-card label="Notepad" bleed>
        <div style="height:30px">note surface</div>
      </temba-card>
    `);

    const content = card.shadowRoot.querySelector('.content') as HTMLElement;
    expect(getComputedStyle(content).padding).to.equal('0px');
  });

  it('clears overflow clipping once expand animation ends', async () => {
    const card = await getCard(html`
      <temba-card label="Details" collapsed>
        <div>Some content</div>
      </temba-card>
    `);

    const header = card.shadowRoot.querySelector('.card-header') as HTMLElement;
    header.click();
    await card.updateComplete;

    // mid-animation the body clips its contents
    const body = card.shadowRoot.querySelector('.body') as HTMLElement;
    expect(body.classList.contains('animating')).to.be.true;

    // transitions from slotted content must not clear the clipping state
    body.dispatchEvent(
      new TransitionEvent('transitionend', {
        propertyName: 'opacity',
        bubbles: true
      })
    );
    await card.updateComplete;
    expect(body.classList.contains('animating')).to.be.true;

    body.dispatchEvent(
      new TransitionEvent('transitionend', {
        propertyName: 'grid-template-rows'
      })
    );
    await card.updateComplete;
    expect(body.classList.contains('animating')).to.be.false;
  });
});
