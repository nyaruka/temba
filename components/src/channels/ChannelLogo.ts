import { css, html, TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import { Icon } from '../Icons';
import { RapidElement } from '../RapidElement';
import { COLOR_LOGOS } from './colorLogos';

/**
 * Full color logos for channel types - the type's glyph from the icon
 * sprite in white on its brand color, or a monogram for a type we have no
 * glyph for. WhatsApp providers share WhatsApp's logo with a small badge
 * naming the provider.
 */

interface Brand {
  /** the tile's background - any css background */
  bg: string;
  /** the glyph color, white unless set */
  fg?: string;
  /** another type whose glyph this type uses, e.g. a WhatsApp provider without one of its own */
  glyph?: string;
  /** an icon to use as the glyph, for a type with no brand of its own */
  icon?: string;
  /** a small badge in the corner naming a provider */
  badge?: { text?: string; code?: string; bg: string };
}

const WHATSAPP = '#25D366';
const TWILIO = '#F22F46';
const META = '#0866FF';
const SLATE = '#4A5568';

const BRANDS: Record<string, Brand> = {
  // WhatsApp and its providers
  WAC: { bg: WHATSAPP },
  WA: { bg: WHATSAPP },
  D3C: { bg: WHATSAPP, glyph: 'WAC', badge: { text: '360', bg: '#111827' } },
  TWA: { bg: WHATSAPP, glyph: 'WAC', badge: { code: 'T', bg: TWILIO } },
  TRN: { bg: WHATSAPP, glyph: 'WAC', badge: { text: 'T', bg: '#5B3DF5' } },
  KWA: { bg: WHATSAPP, glyph: 'WAC', badge: { text: 'K', bg: '#E8430F' } },
  ZVW: { bg: WHATSAPP, glyph: 'WAC', badge: { text: 'Z', bg: '#3C2B8E' } },

  // social and chat
  FBA: { bg: META },
  FB: { bg: META },
  IG: {
    bg: 'linear-gradient(45deg, #feda75 0%, #fa7e1e 25%, #d62976 50%, #962fbf 75%, #4f5bd5 100%)'
  },
  TG: { bg: '#27A7E7' },
  VP: { bg: '#7360F2' },
  LN: { bg: '#06C755' },
  WC: { bg: '#07C160' },
  VK: { bg: '#0077FF' },
  JC: { bg: '#1A4AB7' },
  SL: { bg: '#4A154B' },
  RC: { bg: '#F5455C' },
  CHP: { bg: '#2387CA', icon: Icon.webchat },

  // sms and voice
  A: { bg: '#3DDC84', fg: '#0B3D23' },
  T: { bg: TWILIO },
  TMS: { bg: '#8B1A2B' },
  NX: { bg: '#000000' },
  PL: { bg: '#3DAE49' },
  SW: { bg: '#044EF4' },
  AT: { bg: '#FC9206' },
  AC: { bg: '#F26532' },
  BW: { bg: '#079CEE' },
  BS: { bg: '#4C23CC' },
  CM: { bg: '#007BB5' },
  CT: { bg: '#2A7DE1' },
  CS: { bg: '#00AAFF' },
  DA: { bg: '#F48536' },
  DK: { bg: '#00719E' },
  GL: { bg: '#179DFF' },
  HX: { bg: '#5733FF' },
  HM: { bg: '#00A550' },
  I2: { bg: '#008CBA' },
  IB: { bg: '#FC6423' },
  JCL: { bg: '#003BB3' },
  KN: { bg: '#5D4A8A' },
  MK: { bg: '#468FF3' },
  MBD: { bg: '#000000' },
  MG: { bg: '#1111F0' },
  MT: { bg: '#23BE96' },
  MTN: { bg: '#FFCB05', fg: '#1A1A1A' },
  PM: { bg: '#EC1111' },
  TW: { bg: '#6C63FF' },
  TS: { bg: '#283090' },
  ST: { bg: '#C02222' },
  TQ: { bg: '#0077FF' },
  YO: { bg: '#324A7C' },
  ZVS: { bg: '#EC0886' },

  // types whose provider we couldn't find a brand for, e.g. as it's gone or its site can't be reached
  H9: { bg: SLATE },
  JS: { bg: SLATE },
  M3: { bg: SLATE },
  MB: { bg: SLATE },
  SC: { bg: SLATE },

  // api
  EX: { bg: '#2D3440', icon: Icon.code },
  FCM: { bg: '#FFCA28', fg: '#7A3500' },
  FC: { bg: '#0C6AE6' }
};

// tiles for the types we have no brand for, picked by hashing the code
const FALLBACKS = [
  '#0A2A4D',
  '#EE6C24',
  '#2481D7',
  '#2D6A4F',
  '#7A3FA0',
  '#C05621',
  '#285E61',
  '#9B2335',
  '#2B6CB0',
  '#553C9A',
  '#B83280',
  '#2F855A'
];

/** The sprite icon for a channel type, or null if it has no glyph of its own */
export const getChannelIcon = (code: string): string | null => {
  const icon = (Icon as any)[`channel_${(code || '').toLowerCase()}`];
  return icon && icon !== Icon.channel ? icon : null;
};

const getBrand = (code: string): Brand => {
  if (BRANDS[code]) {
    return BRANDS[code];
  }
  let hash = 0;
  for (const c of code || '') {
    hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  }
  return { bg: FALLBACKS[hash % FALLBACKS.length] };
};

/** Up to two letters standing in for a type with no glyph, e.g. "Africa's Talking" -> "AT" */
export const getMonogram = (name: string): string => {
  const words = (name || '')
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0);
  if (words.length === 0) {
    return '?';
  }
  if (words.length === 1) {
    return words[0].substring(0, 2).toUpperCase();
  }
  return (words[0][0] + words[1][0]).toUpperCase();
};

/** Renders a channel type's logo at the given size in pixels */
export const renderChannelLogo = (
  code: string,
  name: string,
  size: number
): TemplateResult => {
  const brand = getBrand(code);
  const icon = brand.icon || getChannelIcon(brand.glyph || code);
  const radius = Math.round(size * 0.26);

  // a multicolor brand mark goes on a white tile as is
  const colorLogo = COLOR_LOGOS[code];
  if (colorLogo) {
    const markSize = Math.round(size * 0.68);
    return html`<span
      class="channel-logo color"
      style="width:${size}px; height:${size}px; border-radius:${radius}px"
      ><span class="mark" style="width:${markSize}px; height:${markSize}px"
        >${unsafeSVG(colorLogo)}</span
      ></span
    >`;
  }
  const glyph = icon
    ? html`<temba-icon
        name=${icon}
        style="--icon-color:${brand.fg || '#fff'}; font-size:${Math.round(
          size * 0.6
        )}px"
      ></temba-icon>`
    : html`<span
        class="monogram"
        style="font-size:${Math.round(size * 0.4)}px; color:${brand.fg ||
        '#fff'}"
        >${getMonogram(name)}</span
      >`;

  let badge: TemplateResult = null;
  if (brand.badge) {
    const badgeSize = Math.round(size * 0.46);
    const badgeIcon = brand.badge.code
      ? getChannelIcon(brand.badge.code)
      : null;
    badge = html`<span
      class="badge"
      style="background:${brand.badge
        .bg}; width:${badgeSize}px; height:${badgeSize}px"
      >${badgeIcon
        ? html`<temba-icon
            name=${badgeIcon}
            style="--icon-color:#fff; font-size:${Math.round(
              badgeSize * 0.66
            )}px"
          ></temba-icon>`
        : html`<span
            style="font-size:${Math.round(
              badgeSize * (brand.badge.text.length > 1 ? 0.42 : 0.62)
            )}px"
            >${brand.badge.text}</span
          >`}</span
    >`;
  }

  return html`<span
    class="channel-logo"
    style="width:${size}px; height:${size}px; border-radius:${radius}px; background:${brand.bg}"
    >${glyph}${badge}</span
  >`;
};

/** Styles for {@link renderChannelLogo}, for the components which use it */
export const channelLogoStyles = css`
  .channel-logo {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    box-sizing: border-box;
  }
  .channel-logo temba-icon {
    display: flex;
  }
  .channel-logo.color {
    background: #fff;
    box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.1);
  }
  .channel-logo .mark {
    display: flex;
  }
  .channel-logo .mark svg {
    width: 100%;
    height: 100%;
  }
  .channel-logo .monogram {
    font-weight: 700;
    letter-spacing: -0.02em;
    line-height: 1;
  }
  .channel-logo .badge {
    position: absolute;
    right: -3px;
    bottom: -3px;
    border-radius: 30%;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #fff;
    font-weight: 800;
    letter-spacing: -0.04em;
    line-height: 1;
    box-shadow: 0 0 0 2px var(--channel-logo-ring, #fff);
  }
`;

/** A channel type's logo, for pages outside the components, e.g. a channel's read page */
export class ChannelLogo extends RapidElement {
  static get styles() {
    return [
      channelLogoStyles,
      css`
        /* room for a provider's badge, which hangs off the corner, even where the page clips its overflow */
        :host {
          display: inline-flex;
          flex: none;
          padding: 5px 5px 5px 0;
        }
      `
    ];
  }

  /** the channel type's code, e.g. TG */
  @property({ type: String })
  type: string;

  /** the channel type's name, for its monogram if it has no glyph */
  @property({ type: String })
  name = '';

  @property({ type: Number })
  size = 28;

  public render(): TemplateResult {
    return this.type
      ? renderChannelLogo(this.type, this.name, this.size)
      : null;
  }
}
