import { property } from 'lit/decorators.js';
import { RapidElement } from '../RapidElement';
import { DateTime } from 'luxon';
import { html, css, PropertyValues } from 'lit';
import { DatePicker } from './DatePicker';
import { CustomEventType } from '../interfaces';
import { Icon } from '../Icons';
import { designTokens } from '../styles/designTokens';

export class RangePicker extends RapidElement {
  static styles = css`
    ${designTokens}

    :host {
      display: inline-block;
      font-family: var(--font);
    }

    .range-container {
      display: flex;
      gap: 8px;
      align-items: center;
      font-size: 13.5px;
      color: var(--text-1);
    }

    .date-display {
      cursor: pointer;
      padding: 3px 6px;
      border-radius: var(--r-sm);
      transition:
        background 120ms,
        color 120ms;
    }

    .date-display:hover {
      background: var(--sunken);
    }

    .range-separator {
      color: var(--text-3);
    }

    .navigation-container {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    /* Chevron-only step buttons, same chrome as the list pager: bare
       glyph at rest, sunken wash on hover. No border of their own, so
       they don't compete with the period track between them. */
    .nav-arrow {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      padding: 0;
      border: 0;
      background: transparent;
      border-radius: var(--r-sm);
      color: var(--text-3);
      cursor: pointer;
      transition:
        background 120ms,
        color 120ms,
        opacity 120ms;
    }

    .nav-arrow temba-icon {
      --icon-color: currentColor;
    }

    .nav-arrow:hover:not(:disabled) {
      background: var(--sunken);
      color: var(--text-1);
    }

    .nav-arrow:disabled {
      opacity: 0.35;
      cursor: default;
    }

    .nav-arrow.hidden {
      visibility: hidden;
    }

    /* Segmented control — one bordered sunken track holds every
       period and the selected one lifts out as a surface pill. The
       buttons carry no borders themselves, so there are no
       overlapping 1px edges to clip the selection's outline (the old
       -1px margin stacking left the selected button's left border
       painted over by its neighbor). */
    .button-group {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      padding: 2px;
      background: var(--sunken);
      border: 1px solid var(--border);
      border-radius: var(--r-sm);
    }

    .range-btn {
      height: 22px;
      padding: 0 10px;
      border: 0;
      background: transparent;
      border-radius: var(--r-xs);
      font-family: inherit;
      font-size: 12.5px;
      font-weight: var(--w-medium);
      line-height: 1;
      color: var(--text-2);
      cursor: pointer;
      transition:
        background 120ms,
        color 120ms,
        box-shadow 120ms;
    }

    /* The hover wash sits on the sunken track, so --sunken itself
       would be invisible here. Derived from --text-1 rather than a raw
       rgba literal so it follows the palette (the tokens file mixes
       against transparent the same way for --focus-halo). The rgba
       fallback pre-mixes the default --text-1 for browsers without
       color-mix(). */
    .range-btn:hover:not(.selected) {
      background: rgba(26, 31, 38, 0.06);
      color: var(--text-1);
    }

    @supports (color: color-mix(in srgb, red, red)) {
      .range-btn:hover:not(.selected) {
        background: color-mix(in srgb, var(--text-1) 6%, transparent);
      }
    }

    .range-btn.selected {
      background: var(--surface);
      color: var(--accent-700);
      box-shadow: var(--shadow-1);
      cursor: default;
    }

    .range-btn:focus-visible,
    .nav-arrow:focus-visible {
      outline: none;
      box-shadow: var(--focus-halo);
    }
  `;

  // the periods in the segmented control, in display order
  private static RANGES: {
    type: 'W' | 'M' | 'Y' | 'ALL';
    label: string;
    title: string;
  }[] = [
    { type: 'W', label: 'W', title: 'Last week' },
    { type: 'M', label: 'M', title: 'Last month' },
    { type: 'Y', label: 'Y', title: 'Last year' },
    { type: 'ALL', label: 'All', title: 'All time' }
  ];

  @property({ type: String, attribute: 'start' })
  startDate = '';

  @property({ type: String, attribute: 'end' })
  endDate = '';

  @property({ type: Boolean })
  editingStart = false;

  @property({ type: Boolean })
  editingEnd = false;

  @property({ type: String })
  selectedRange: 'W' | 'M' | 'Y' | 'ALL' | '' = '';

  @property({ type: String, attribute: 'min' })
  minDate = '2012-01-01';

  @property({ type: String, attribute: 'max' })
  maxDate = DateTime.now().toISODate();

  @property({ type: Boolean, attribute: 'hideall' })
  hideAll = false;

  private handleStartClick() {
    this.editingStart = true;
  }

  private handleEndClick() {
    this.editingEnd = true;
  }

  private setRange(type: 'W' | 'M' | 'Y' | 'ALL') {
    const today = DateTime.now().toISODate();
    let start = '';
    if (type === 'W') {
      start = DateTime.now().minus({ days: 6 }).toISODate();
    } else if (type === 'M') {
      start = DateTime.now().minus({ months: 1 }).plus({ days: 1 }).toISODate();
    } else if (type === 'Y') {
      start = DateTime.now().minus({ years: 1 }).plus({ days: 1 }).toISODate();
    } else if (type === 'ALL') {
      start = this.minDate || '2012-01-01';
    }
    this.startDate = start;
    this.endDate = today;
    this.selectedRange = type;
    this.editingStart = false;
    this.editingEnd = false;

    this.fireCustomEvent(CustomEventType.DateRangeChanged, {
      start: this.startDate,
      end: this.endDate,
      range: this.selectedRange
    });
  }

  private setValidRange(type: 'start' | 'end', value: string) {
    // Enforce min/max
    let newValue = value;
    if (newValue < this.minDate) newValue = this.minDate;
    if (newValue > this.maxDate) newValue = this.maxDate;
    const start = DateTime.fromISO(
      type === 'start' ? newValue : this.startDate
    );
    const end = DateTime.fromISO(type === 'end' ? newValue : this.endDate);

    if (!start.isValid || !end.isValid) return;
    if (start > end) {
      if (type === 'start') {
        this.startDate = newValue;
        this.endDate = start.toISODate();
      } else {
        this.endDate = newValue;
        this.startDate = end.toISODate();
      }
    } else {
      if (type === 'start') this.startDate = newValue;
      else this.endDate = newValue;
    }

    this.fireCustomEvent(CustomEventType.DateRangeChanged, {
      start: this.startDate,
      end: this.endDate,
      range: this.selectedRange
    });
  }

  private canNavigatePrevious(): boolean {
    if (this.selectedRange === 'ALL') return false;

    const currentStart = DateTime.fromISO(this.startDate);
    let previousStart: DateTime;

    if (this.selectedRange === 'W') {
      previousStart = currentStart.minus({ weeks: 1 });
    } else if (this.selectedRange === 'M') {
      previousStart = currentStart.minus({ months: 1 });
    } else if (this.selectedRange === 'Y') {
      previousStart = currentStart.minus({ years: 1 });
    } else if (this.selectedRange === '') {
      // Custom range - determine the interval and navigate by that amount
      const interval = this.getCustomRangeInterval();
      if (interval.type === 'days') {
        previousStart = currentStart.minus({ days: interval.amount });
      } else if (interval.type === 'months') {
        previousStart = currentStart.minus({ months: interval.amount });
      } else if (interval.type === 'years') {
        previousStart = currentStart.minus({ years: interval.amount });
      } else {
        return false;
      }
    } else {
      return false;
    }

    return previousStart.toISODate() >= this.minDate;
  }

  private canNavigateNext(): boolean {
    if (this.selectedRange === 'ALL') return false;

    const currentEnd = DateTime.fromISO(this.endDate);
    let nextEnd: DateTime;

    if (this.selectedRange === 'W') {
      nextEnd = currentEnd.plus({ weeks: 1 });
    } else if (this.selectedRange === 'M') {
      nextEnd = currentEnd.plus({ months: 1 });
    } else if (this.selectedRange === 'Y') {
      nextEnd = currentEnd.plus({ years: 1 });
    } else if (this.selectedRange === '') {
      // Custom range - determine the interval and navigate by that amount
      const interval = this.getCustomRangeInterval();
      if (interval.type === 'days') {
        nextEnd = currentEnd.plus({ days: interval.amount });
      } else if (interval.type === 'months') {
        nextEnd = currentEnd.plus({ months: interval.amount });
      } else if (interval.type === 'years') {
        nextEnd = currentEnd.plus({ years: interval.amount });
      } else {
        return false;
      }
    } else {
      return false;
    }

    return nextEnd.toISODate() <= this.maxDate;
  }

  private getCustomRangeInterval(): {
    type: 'days' | 'months' | 'years';
    amount: number;
  } {
    const start = DateTime.fromISO(this.startDate);
    const end = DateTime.fromISO(this.endDate);

    if (!start.isValid || !end.isValid) {
      return { type: 'days', amount: 1 };
    }

    // Check if it's a complete month (first day to last day of any month)
    const isLastDayOfMonth = end.day === end.daysInMonth;
    if (start.day === 1 && isLastDayOfMonth) {
      // Single complete month
      if (start.month === end.month && start.year === end.year) {
        return { type: 'months', amount: 1 };
      }

      // Multiple complete months - check if we span complete months only
      const startOfFirstMonth = start.startOf('month');
      const endOfLastMonth = end.endOf('month');
      const monthsDiff =
        endOfLastMonth.diff(startOfFirstMonth, 'months').months + 1;

      if (monthsDiff > 0 && Number.isInteger(monthsDiff)) {
        return { type: 'months', amount: Math.round(monthsDiff) };
      }
    }

    // Check if it's a full year
    if (
      start.month === 1 &&
      start.day === 1 &&
      end.month === 12 &&
      end.day === 31
    ) {
      // Single complete year
      if (start.year === end.year) {
        return { type: 'years', amount: 1 };
      }

      // Multiple complete years
      const yearsDiff = end.year - start.year + 1;
      if (yearsDiff > 0) {
        return { type: 'years', amount: yearsDiff };
      }
    }

    // Default to days for any other custom range
    const daysDiff = end.diff(start, 'days').days + 1; // +1 to include both start and end days
    return { type: 'days', amount: Math.max(1, Math.round(daysDiff)) };
  }

  private navigatePrevious() {
    if (!this.canNavigatePrevious()) return;

    const currentStart = DateTime.fromISO(this.startDate);
    const currentEnd = DateTime.fromISO(this.endDate);
    let newStart: DateTime;
    let newEnd: DateTime;

    if (this.selectedRange === 'W') {
      newStart = currentStart.minus({ weeks: 1 });
      newEnd = currentEnd.minus({ weeks: 1 });
    } else if (this.selectedRange === 'M') {
      // Check if current M range is a complete month, if so maintain month boundaries
      const interval = this.getCustomRangeInterval();
      if (interval.type === 'months') {
        newStart = currentStart.minus({ months: 1 }).startOf('month');
        newEnd = newStart
          .plus({ months: interval.amount })
          .minus({ days: 1 })
          .endOf('day');
      } else {
        newStart = currentStart.minus({ months: 1 });
        newEnd = currentEnd.minus({ months: 1 });
      }
    } else if (this.selectedRange === 'Y') {
      newStart = currentStart.minus({ years: 1 });
      newEnd = currentEnd.minus({ years: 1 });
    } else if (this.selectedRange === '') {
      // Custom range - determine the interval and navigate by that amount
      const interval = this.getCustomRangeInterval();
      if (interval.type === 'days') {
        newStart = currentStart.minus({ days: interval.amount });
        newEnd = currentEnd.minus({ days: interval.amount });
      } else if (interval.type === 'months') {
        // For month navigation, maintain complete month boundaries
        newStart = currentStart
          .minus({ months: interval.amount })
          .startOf('month');
        newEnd = newStart
          .plus({ months: interval.amount })
          .minus({ days: 1 })
          .endOf('day');
      } else if (interval.type === 'years') {
        newStart = currentStart.minus({ years: interval.amount });
        newEnd = currentEnd.minus({ years: interval.amount });
      } else {
        return;
      }
    } else {
      return;
    }

    // Enforce min/max bounds
    const minDateTime = DateTime.fromISO(this.minDate);
    const maxDateTime = DateTime.fromISO(this.maxDate);
    const startDate =
      newStart < minDateTime ? this.minDate : newStart.toISODate();
    const endDate = newEnd > maxDateTime ? this.maxDate : newEnd.toISODate();

    this.startDate = startDate;
    this.endDate = endDate;

    this.fireCustomEvent(CustomEventType.DateRangeChanged, {
      start: this.startDate,
      end: this.endDate,
      range: this.selectedRange
    });
  }

  private navigateNext() {
    if (!this.canNavigateNext()) return;

    const currentStart = DateTime.fromISO(this.startDate);
    const currentEnd = DateTime.fromISO(this.endDate);
    let newStart: DateTime;
    let newEnd: DateTime;

    if (this.selectedRange === 'W') {
      newStart = currentStart.plus({ weeks: 1 });
      newEnd = currentEnd.plus({ weeks: 1 });
    } else if (this.selectedRange === 'M') {
      // Check if current M range is a complete month, if so maintain month boundaries
      const interval = this.getCustomRangeInterval();
      if (interval.type === 'months') {
        newStart = currentStart.plus({ months: 1 }).startOf('month');
        newEnd = newStart
          .plus({ months: interval.amount })
          .minus({ days: 1 })
          .endOf('day');
      } else {
        newStart = currentStart.plus({ months: 1 });
        newEnd = currentEnd.plus({ months: 1 });
      }
    } else if (this.selectedRange === 'Y') {
      newStart = currentStart.plus({ years: 1 });
      newEnd = currentEnd.plus({ years: 1 });
    } else if (this.selectedRange === '') {
      // Custom range - determine the interval and navigate by that amount
      const interval = this.getCustomRangeInterval();
      if (interval.type === 'days') {
        newStart = currentStart.plus({ days: interval.amount });
        newEnd = currentEnd.plus({ days: interval.amount });
      } else if (interval.type === 'months') {
        // For month navigation, maintain complete month boundaries
        newStart = currentStart
          .plus({ months: interval.amount })
          .startOf('month');
        newEnd = newStart
          .plus({ months: interval.amount })
          .minus({ days: 1 })
          .endOf('day');
      } else if (interval.type === 'years') {
        newStart = currentStart.plus({ years: interval.amount });
        newEnd = currentEnd.plus({ years: interval.amount });
      } else {
        return;
      }
    } else {
      return;
    }

    // Enforce min/max bounds
    const minDateTime = DateTime.fromISO(this.minDate);
    const maxDateTime = DateTime.fromISO(this.maxDate);
    const startDate =
      newStart < minDateTime ? this.minDate : newStart.toISODate();
    const endDate = newEnd > maxDateTime ? this.maxDate : newEnd.toISODate();

    this.startDate = startDate;
    this.endDate = endDate;

    this.fireCustomEvent(CustomEventType.DateRangeChanged, {
      start: this.startDate,
      end: this.endDate,
      range: this.selectedRange
    });
  }

  private getNavigationLabel(direction: 'previous' | 'next'): string {
    const interval = this.getCustomRangeInterval();
    const amount = interval.amount;
    const unit =
      interval.type === 'days'
        ? amount === 1
          ? 'day'
          : 'days'
        : interval.type === 'months'
          ? amount === 1
            ? 'month'
            : 'months'
          : amount === 1
            ? 'year'
            : 'years';

    return `${
      direction === 'previous' ? 'Previous' : 'Next'
    } ${amount} ${unit}`;
  }

  private getNavigationTitle(direction: 'previous' | 'next'): string {
    const prefix = direction === 'previous' ? 'Previous' : 'Next';
    if (this.selectedRange === 'W') return `${prefix} week`;
    if (this.selectedRange === 'M') return `${prefix} month`;
    if (this.selectedRange === 'Y') return `${prefix} year`;
    if (this.selectedRange === '') return this.getNavigationLabel(direction);
    return `${prefix} period`;
  }

  willUpdate(changed: PropertyValues) {
    super.willUpdate(changed);

    if (
      changed.has('startDate') &&
      changed.has('endDate') &&
      (!this.startDate || !this.endDate)
    ) {
      const today = DateTime.now().toISODate();
      this.startDate = DateTime.now()
        .minus({ months: 1 })
        .plus({ days: 1 })
        .toISODate();
      this.endDate = today;
      this.selectedRange = 'M';
      this.editingStart = false;
      this.editingEnd = false;
    }
  }

  updated(changed: Map<string, any>) {
    super.updated(changed);

    if (changed.has('editingStart') && this.editingStart) {
      setTimeout(() => {
        const startPicker: DatePicker = this.shadowRoot?.querySelector(
          'temba-datepicker.start-picker'
        );

        if (startPicker) {
          startPicker.handleClicked();
        }
      }, 0);
    }

    if (changed.has('editingEnd') && this.editingEnd) {
      setTimeout(() => {
        const endPicker: DatePicker = this.shadowRoot?.querySelector(
          'temba-datepicker.end-picker'
        );
        if (endPicker) {
          endPicker.handleClicked();
        }
      }, 0);
    }
  }

  private formatDateForDisplay(dateString: string): string {
    if (!dateString) return '';

    const date = DateTime.fromISO(dateString);
    if (!date.isValid) return dateString;

    // Use the browser's locale for formatting
    return date.toLocaleString();
  }

  render() {
    return html`
      <div class="range-container">
        ${this.editingStart
          ? html`<temba-datepicker
              class="start-picker"
              .value=${this.startDate}
              .min=${this.minDate}
              .max=${this.maxDate}
              @change=${(e: Event) => {
                const value = (e.target as any).value;
                this.setValidRange('start', value);
                this.editingStart = false;
                this.selectedRange = '';
              }}
              @blur=${() => (this.editingStart = false)}
            ></temba-datepicker>`
          : html`<span class="date-display" @click=${this.handleStartClick}
              >${this.formatDateForDisplay(this.startDate) ||
              'Start date'}</span
            >`}
        <span class="range-separator">–</span>
        ${this.editingEnd
          ? html`<temba-datepicker
              .value=${this.endDate}
              class="end-picker"
              .min=${this.minDate}
              .max=${this.maxDate}
              @change=${(e: Event) => {
                const value = (e.target as any).value;
                this.setValidRange('end', value);
                this.editingEnd = false;
                this.selectedRange = '';
              }}
              @blur=${() => (this.editingEnd = false)}
            ></temba-datepicker>`
          : html`<span class="date-display" @click=${this.handleEndClick}
              >${this.formatDateForDisplay(this.endDate) || 'End date'}</span
            >`}
        <div class="navigation-container">
          <button
            class="nav-arrow ${this.selectedRange === 'ALL' ? 'hidden' : ''}"
            ?disabled=${!this.canNavigatePrevious()}
            @click=${this.navigatePrevious}
            title=${this.getNavigationTitle('previous')}
            aria-label=${this.getNavigationTitle('previous')}
          >
            <temba-icon name=${Icon.arrow_left}></temba-icon>
          </button>
          <div class="button-group" role="group" aria-label="Period">
            ${RangePicker.RANGES.filter(
              (range) => !(this.hideAll && range.type === 'ALL')
            ).map(
              (range) =>
                html`<button
                  class="range-btn ${this.selectedRange === range.type
                    ? 'selected'
                    : ''}"
                  title=${range.title}
                  aria-pressed=${this.selectedRange === range.type}
                  @click=${() => this.setRange(range.type)}
                >
                  ${range.label}
                </button>`
            )}
          </div>
          <button
            class="nav-arrow ${this.selectedRange === 'ALL' ? 'hidden' : ''}"
            ?disabled=${!this.canNavigateNext()}
            @click=${this.navigateNext}
            title=${this.getNavigationTitle('next')}
            aria-label=${this.getNavigationTitle('next')}
          >
            <temba-icon name=${Icon.arrow_right}></temba-icon>
          </button>
        </div>
      </div>
    `;
  }
}

customElements.define('temba-range-picker', RangePicker);
