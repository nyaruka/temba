import { Chat } from './src/display/Chat';
import { VectorIcon } from './src/display/Icon';
import { Lightbox } from './src/display/Lightbox';
import { Loading } from './src/display/Loading';
import { TembaDate } from './src/display/TembaDate';
import { TembaUser } from './src/display/TembaUser';
import { Thumbnail } from './src/display/Thumbnail';
import { WebChat } from './src/webchat/WebChat';
import webchatSprite from './static/svg/webchat.svg';

/**
 * The standalone webchat bundle, embedded on third-party websites alongside a
 * <temba-webchat> tag. It carries the widget and everything the chat renders.
 */

// a page on another site can't reference the platform's icon sprite (SVG <use>
// is same-origin only), so the bundle carries the icons it needs and renders
// them inline. The sprite is built from src/webchat/index.ts by `bun run svg-wc`.
VectorIcon.addInlineSprite(webchatSprite);

export function addCustomElement(name: string, comp: any) {
  if (!window.customElements.get(name)) {
    window.customElements.define(name, comp);
  }
}

addCustomElement('temba-icon', VectorIcon);
addCustomElement('temba-loading', Loading);
addCustomElement('temba-date', TembaDate);
addCustomElement('temba-user', TembaUser);
addCustomElement('temba-thumbnail', Thumbnail);
addCustomElement('temba-lightbox', Lightbox);
addCustomElement('temba-chat', Chat);
addCustomElement('temba-webchat', WebChat);
