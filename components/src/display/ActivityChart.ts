import { css, html, svg, TemplateResult } from 'lit';
import { property, state } from 'lit/decorators.js';
import { msg, str } from '@lit/localize';
import { RapidElement } from '../RapidElement';

/** Daily counts for a dashboard's activity chart, oldest day first */
export interface ActivityData {
  /** ISO dates (YYYY-MM-DD), one per day */
  days: string[];
  /** two series stacked on each other, drawn in order from the bottom */
  series: { label: string; values: number[] }[];
}

// the shortest the chart gets, which matches its min-height in the styles
const MIN_HEIGHT = 170;

// the largest change shown as a percentage, beyond which it's just more than this
const MAX_CHANGE = 999;
const TOP = 8;
const BOTTOM = 18;
const LEFT = 34;

/**
 * A dashboard's activity panel: a stacked bar chart of daily counts with a
 * choice of how many recent days to show, and each series' total for them
 * underneath. It's the summary - the full history is opened from the
 * `actions` slot, e.g. a link to a sheet.
 */
export class ActivityChart extends RapidElement {
  static get styles() {
    return css`
      /* the frame is on an inner element, since page styles (a css reset,
         say) win over :host and would restyle its border */
      :host {
        display: flex;
        flex-direction: column;
        min-width: 0;
        --bar-1: var(--accent, #2563eb);
        --bar-2: var(--accent-200, #bfd3fb);
      }

      .frame {
        flex: 1;
        display: flex;
        flex-direction: column;
        min-width: 0;
        border: 1px solid var(--border, #e5e7eb);
        border-radius: var(--r-lg, 12px);
        background: var(--surface, #fff);
        box-shadow: var(--shadow-1);
        overflow: hidden;
        font-family: var(--font, inherit);
        color: var(--text-1, #111);
      }

      /* the same height as a dashboard section's head, so panels side by side line up */
      .head {
        box-sizing: border-box;
        display: flex;
        align-items: center;
        gap: 12px;
        min-height: 48px;
        padding: 8px 16px;
        border-bottom: 1px solid var(--border, #e5e7eb);
      }

      .title {
        flex: 1;
        font-size: 14px;
        font-weight: var(--w-semibold, 600);
      }

      [hidden] {
        display: none !important;
      }

      .ranges {
        display: inline-flex;
        gap: 2px;
        padding: 2px;
        border-radius: 7px;
        background: var(--sunken, #f1f3f5);
      }

      .ranges button {
        padding: 3px 9px;
        border: none;
        border-radius: 5px;
        background: none;
        color: var(--text-2, #374151);
        font: inherit;
        font-size: 12px;
        cursor: pointer;
      }

      .ranges button[aria-pressed='true'] {
        background: var(--surface, #fff);
        color: var(--text-1, #111);
        font-weight: var(--w-semibold, 600);
        box-shadow: var(--shadow-1);
      }

      /* given data-sheet, the panel as a whole opens what it summarizes,
         looking and behaving like a dashboard card */
      :host([data-sheet]) .frame {
        cursor: pointer;
        transition:
          border-color 150ms ease,
          box-shadow 150ms ease,
          transform 150ms ease;
      }

      :host([data-sheet]:hover) .frame {
        border-color: var(--border-strong, #cdd3df);
        box-shadow: var(--shadow-2);
        transform: translateY(-1px);
      }

      :host([data-sheet].dash-opened:hover) .frame {
        border-color: var(--border, #e5e7eb);
        box-shadow: var(--shadow-1);
        transform: none;
      }

      :host([data-sheet]:focus-visible) {
        outline: none;
      }

      :host([data-sheet]:focus-visible) .frame {
        outline: 2px solid var(--accent, #2563eb);
        outline-offset: 1px;
      }

      @media (prefers-reduced-motion: reduce) {
        :host([data-sheet]) .frame {
          transition: none;
        }

        :host([data-sheet]:hover) .frame {
          transform: none;
        }
      }

      .ranges button:focus-visible {
        outline: 2px solid var(--accent, #2563eb);
        outline-offset: 1px;
      }

      /* the chart takes whatever height the panel has to spare, so it can
         match a taller neighbour; the svg is laid over it so its own size
         never feeds back into the measurement */
      .chart {
        position: relative;
        flex: 1;
        min-height: 170px;
        margin: 14px 16px 4px;
      }

      svg {
        position: absolute;
        inset: 0;
        display: block;
        width: 100%;
        height: 100%;
      }

      svg text {
        fill: var(--text-3, #6b7280);
        font-size: 10px;
        font-family: var(--font, inherit);
      }

      .grid {
        stroke: var(--border, #e5e7eb);
        stroke-width: 1;
      }

      .bar-0 {
        fill: var(--bar-1);
      }

      .bar-1 {
        fill: var(--bar-2);
      }

      .legend {
        display: flex;
        gap: 16px;
        padding: 0 16px 12px;
        color: var(--text-2, #374151);
        font-size: 12px;
      }

      .legend i {
        display: inline-block;
        width: 9px;
        height: 9px;
        margin-right: 6px;
        border-radius: 2px;
        vertical-align: -1px;
      }

      .totals {
        margin-top: auto;
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(0, 1fr));
        border-top: 1px solid var(--border, #e5e7eb);
      }

      .total {
        padding: 10px 16px;
      }

      .total + .total {
        border-left: 1px solid var(--border, #e5e7eb);
      }

      .total b {
        display: block;
        font-size: 17px;
        font-weight: var(--w-semibold, 600);
        font-variant-numeric: tabular-nums;
      }

      .total b {
        display: flex;
        align-items: baseline;
        gap: 8px;
      }

      .total span {
        color: var(--text-3, #6b7280);
        font-size: 12px;
      }

      /* the change from the window before, e.g. ↑ 12% */
      .change {
        color: var(--text-3, #6b7280);
        font-size: 12px;
        font-style: normal;
        font-weight: var(--w-medium, 500);
        white-space: nowrap;
      }

      .change.up {
        color: var(--success, #23864a);
      }

      .change.down {
        color: var(--danger, #c2343b);
      }

      ::slotted([slot='actions']) {
        font-size: 12.5px;
      }
    `;
  }

  @property({ type: String, attribute: 'chart-title' })
  chartTitle = '';

  @property({ type: Object })
  data: ActivityData = null;

  /** the numbers of recent days that can be shown, comma separated */
  @property({ type: String })
  ranges = '7,30,90';

  /** the first day to show (YYYY-MM-DD), for a window chosen outside, e.g.
   * by a range picker in the actions slot - instead of the recent days */
  @property({ type: String })
  start = '';

  /** the last day to show (YYYY-MM-DD), with start */
  @property({ type: String })
  end = '';

  @state()
  private range = 30;

  // drawn at its actual width so its labels stay their real size
  @state()
  private width = 0;

  @state()
  private height = 0;

  private resizer: ResizeObserver = null;

  public connectedCallback(): void {
    super.connectedCallback();

    // when the panel opens something, it can be reached and opened from the keyboard too
    if (this.hasAttribute('data-sheet')) {
      this.tabIndex = 0;
      this.setAttribute('role', 'button');
      this.addEventListener('keydown', this.handleKeyDown);
    }

    this.resizer = new ResizeObserver((entries) => {
      const width = Math.round(entries[0].contentRect.width);
      const height = Math.round(entries[0].contentRect.height);
      if (width && width !== this.width) {
        this.width = width;
      }
      if (height && height !== this.height) {
        this.height = height;
      }
    });
    this.updateComplete.then(() => {
      const chart = this.shadowRoot.querySelector('.chart');
      if (chart && this.resizer) {
        this.resizer.observe(chart);
      }
    });
  }

  private handleKeyDown = (e: KeyboardEvent) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target === this) {
      e.preventDefault();
      this.click();
    }
  };

  public disconnectedCallback(): void {
    super.disconnectedCallback();
    this.removeEventListener('keydown', this.handleKeyDown);
    if (this.resizer) {
      this.resizer.disconnect();
      this.resizer = null;
    }
  }

  private get rangeOptions(): number[] {
    return this.ranges
      .split(',')
      .map((r) => parseInt(r, 10))
      .filter((r) => r > 0);
  }

  public firstUpdated(): void {
    // start on the middle option, or the longest there's data for
    const options = this.rangeOptions;
    const available = this.data ? this.data.days.length : 0;
    const middle = options[Math.floor(options.length / 2)];
    this.range = Math.min(middle || 30, available || middle || 30);
  }

  private formatDay(iso: string): string {
    const [y, m, d] = iso.split('-').map((p) => parseInt(p, 10));
    return new Date(y, m - 1, d).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric'
    });
  }

  private formatCount(n: number): string {
    if (n >= 1000) {
      return `${+(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
    }
    return String(n);
  }

  /** a round number at or above the max, so gridlines land on tidy values */
  private niceMax(max: number): number {
    if (max <= 4) return 4;
    const magnitude = Math.pow(10, Math.floor(Math.log10(max)));
    for (const step of [1, 2, 2.5, 5, 10]) {
      if (step * magnitude >= max) return step * magnitude;
    }
    return 10 * magnitude;
  }

  private renderChart(days: string[], series: number[][]): TemplateResult {
    const WIDTH = this.width || 400;
    const HEIGHT = Math.max(this.height, MIN_HEIGHT);
    const count = days.length;
    const totals = days.map((_, i) => series.reduce((t, s) => t + s[i], 0));
    const max = this.niceMax(Math.max(...totals, 1));
    const y = (v: number) =>
      HEIGHT - BOTTOM - (v / max) * (HEIGHT - TOP - BOTTOM);
    const slot = (WIDTH - LEFT) / count;
    const gap = Math.min(3, slot * 0.25);

    const grid = [0, max / 2, max].map(
      (t) => svg`
        <line class="grid" x1=${LEFT} x2=${WIDTH} y1=${y(t)} y2=${y(t)}></line>
        <text x=${LEFT - 6} y=${y(t) + 3} text-anchor="end">${this.formatCount(t)}</text>
      `
    );

    const bars = days.map((day, i) => {
      let base = 0;
      const x = LEFT + i * slot + gap / 2;
      const title = `${this.formatDay(day)}: ${this.data.series
        .map(
          (s, si) =>
            `${series[si][i].toLocaleString()} ${s.label.toLowerCase()}`
        )
        .join(', ')}`;
      return svg`<g><title>${title}</title>${series.map((values, si) => {
        const v = values[i];
        const rect = svg`<rect class="bar-${si}" x=${x} y=${y(base + v)} width=${Math.max(slot - gap, 1)} height=${y(base) - y(base + v)} rx="1.5"></rect>`;
        base += v;
        return rect;
      })}</g>`;
    });

    const labelAt = [0, Math.floor((count - 1) / 2), count - 1];
    const labels = labelAt.map(
      (i, n) => svg`<text x=${LEFT + i * slot + slot / 2} y=${HEIGHT - 4}
        text-anchor=${n === 0 ? 'start' : n === 2 ? 'end' : 'middle'}>${this.formatDay(days[i])}</text>`
    );

    return html`<svg
      viewBox="0 0 ${WIDTH} ${HEIGHT}"
      role="img"
      aria-label=${this.chartTitle}
    >
      ${grid}${bars}${labels}
    </svg>`;
  }

  /** the indexes into the data of the window shown, end exclusive */
  private getWindow(): [number, number] {
    const days = this.data.days;
    if (this.start && this.end) {
      const from = days.findIndex((d) => d >= this.start);
      const to = days.findIndex((d) => d > this.end);
      return [from === -1 ? days.length : from, to === -1 ? days.length : to];
    }
    return [Math.max(days.length - this.range, 0), days.length];
  }

  /** the window's length in days, which may run past the data we have */
  private getWindowDays(from: number, to: number): number {
    if (this.start && this.end) {
      const ms = Date.parse(this.end) - Date.parse(this.start);
      return Math.round(ms / 86400000) + 1;
    }
    return to - from;
  }

  /**
   * The change of a series over the window from the window of the same
   * length before it, as a rounded percentage, or null if we don't have all
   * of that window or there was nothing in it to compare with
   */
  private getChange(values: number[], from: number, to: number): number {
    const length = this.getWindowDays(from, to);
    if (from - length < 0) {
      return null;
    }
    const sum = (a: number[]) => a.reduce((t, v) => t + v, 0);
    const before = sum(values.slice(from - length, from));
    if (!before) {
      return null;
    }
    return Math.round((100 * (sum(values.slice(from, to)) - before)) / before);
  }

  private renderChange(change: number, length: number): TemplateResult {
    if (change === null) {
      return null;
    }
    // past a point a percentage stops meaning much (a quiet period before a
    // busy one can make it tens of thousands), so it's capped
    const arrow = change > 0 ? '↑' : change < 0 ? '↓' : '';
    const amount =
      change > MAX_CHANGE ? `>${MAX_CHANGE}%` : `${Math.abs(change)}%`;
    return html`<span
      class="change ${change > 0 ? 'up' : change < 0 ? 'down' : ''}"
      title=${msg(str`Compared with the ${length} days before`)}
      >${arrow} ${amount}</span
    >`;
  }

  public render(): TemplateResult {
    if (!this.data || !this.data.days.length) {
      return html``;
    }

    const [from, to] = this.getWindow();
    const length = this.getWindowDays(from, to);
    const days = this.data.days.slice(from, to);
    const series = this.data.series.map((s) => s.values.slice(from, to));
    const windowed = !!(this.start && this.end);

    return html`<div class="frame">
      <div class="head">
        <div class="title">${this.chartTitle}</div>
        <div
          class="ranges"
          role="group"
          aria-label=${msg('Days shown')}
          ?hidden=${windowed}
        >
          ${this.rangeOptions.map(
            (r) =>
              html`<button
                aria-pressed=${String(r === this.range)}
                @click=${(e: MouseEvent) => {
                  // switching the range stays here, even when the panel as a whole opens something
                  e.stopPropagation();
                  this.range = r;
                }}
              >
                ${r}d
              </button>`
          )}
        </div>
        <slot name="actions"></slot>
      </div>
      <div class="chart">
        ${days.length ? this.renderChart(days, series) : null}
      </div>
      <div class="legend">
        ${this.data.series.map(
          (s, si) =>
            html`<span
              ><i
                class="bar-${si}"
                style="background: var(${si === 0 ? '--bar-1' : '--bar-2'})"
              ></i
              >${s.label}</span
            >`
        )}
      </div>
      <div class="totals">
        ${this.data.series.map(
          (s, si) =>
            html`<div class="total">
              <b
                >${series[si].reduce((t, v) => t + v, 0).toLocaleString()}
                ${this.renderChange(
                  this.getChange(s.values, from, to),
                  length
                )}</b
              >
              <span
                >${windowed
                  ? s.label
                  : html`${s.label}, ${msg(str`${length} days`)}`}</span
              >
            </div>`
        )}
      </div>
    </div>`;
  }
}
