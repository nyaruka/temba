/**
 * Reports to the webchat service which of the messages sent to a visitor
 * reached their browser (delivered) and which they've seen (read), so that
 * the people replying get the same ticks they would on any other channel.
 *
 * Acks are batched: a report goes out a moment after the first message is
 * queued, carries as many messages as the service takes in one call, and
 * reports are spaced out to stay under the service's per-chat limit. A read
 * supersedes a queued delivered, and a message is never reported again at
 * the same or a lower status - including after a reload, since what's been
 * reported is remembered on the embedding site, keyed by chat id.
 */
export type AckStatus = 'delivered' | 'read';

// what the service accepts in one report
export const MAX_BATCH = 25;

// how long to gather acks before reporting them
export const FLUSH_DELAY = 1000;

// the service allows 20 reports a minute per chat
export const MIN_INTERVAL = 3000;

// how long to wait before retrying a report the service refused for rate
// (429) or didn't answer properly
const THROTTLED_DELAY = 60000;
const FAILED_DELAY = 30000;

// how many messages' acks to remember per chat
const MAX_REMEMBERED = 500;

const STORAGE_PREFIX = 'temba-chat-status-';

const LEVELS: { [status in AckStatus]: number } = { delivered: 1, read: 2 };

export type StatusSender = (
  status: AckStatus,
  uuids: string[]
) => Promise<number>;

export class StatusReporter {
  // what the service has been told, highest status per message
  private acked = new Map<string, AckStatus>();

  // what it's yet to be told
  private pending = new Map<string, AckStatus>();

  // what's reached the widget since the page loaded - the only messages the
  // visitor can be looking at, unlike older ones remembered as acked
  private present = new Set<string>();

  private timer: number = null;
  private inFlight = false;
  private lastSentAt = 0;
  private paused = false;

  constructor(
    public readonly chatId: string,
    private readonly send: StatusSender
  ) {
    this.load();
  }

  private level(uuid: string): number {
    const acked = this.acked.get(uuid);
    const pending = this.pending.get(uuid);
    return Math.max(acked ? LEVELS[acked] : 0, pending ? LEVELS[pending] : 0);
  }

  /**
   * Messages that have reached the visitor, read already if they're looking
   * at the chat.
   */
  public received(uuids: string[], shown: boolean): void {
    const status: AckStatus = shown ? 'read' : 'delivered';
    uuids.forEach((uuid) => {
      this.present.add(uuid);
      if (this.level(uuid) < LEVELS[status]) {
        this.pending.set(uuid, status);
      }
    });
    this.schedule();
  }

  /**
   * The visitor is now looking at the chat, so everything delivered to it has
   * been read.
   */
  public shown(): void {
    this.present.forEach((uuid) => {
      if (this.level(uuid) < LEVELS.read) {
        this.pending.set(uuid, 'read');
      }
    });
    this.schedule();
  }

  /**
   * Holds reports while the widget is off the page
   */
  public pause(): void {
    this.paused = true;
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  public resume(): void {
    this.paused = false;
    this.schedule();
  }

  private schedule(delay = FLUSH_DELAY): void {
    if (this.paused || this.inFlight || this.timer !== null) {
      return;
    }
    if (this.pending.size === 0) {
      return;
    }
    const wait = Math.max(delay, this.lastSentAt + MIN_INTERVAL - Date.now());
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.flush();
    }, wait);
  }

  // reports one batch - reads first, so a message read while its delivered
  // report was waiting only gets the one
  private async flush(): Promise<void> {
    const status: AckStatus = [...this.pending.values()].includes('read')
      ? 'read'
      : 'delivered';
    const uuids = [...this.pending.entries()]
      .filter(([, s]) => s === status)
      .map(([uuid]) => uuid)
      .slice(0, MAX_BATCH);
    if (uuids.length === 0) {
      return;
    }

    this.inFlight = true;
    this.lastSentAt = Date.now();

    let retryIn = 0;
    try {
      const result = await this.send(status, uuids);
      if (result === 200) {
        this.settle(uuids, status);
      } else if (result === 429) {
        retryIn = THROTTLED_DELAY;
      } else if (result >= 400 && result < 500) {
        // the service won't take these whatever we do
        this.settle(uuids, status);
      } else {
        retryIn = FAILED_DELAY;
      }
    } catch (err) {
      retryIn = FAILED_DELAY;
    } finally {
      this.inFlight = false;
    }

    this.schedule(retryIn || FLUSH_DELAY);
  }

  private settle(uuids: string[], status: AckStatus): void {
    uuids.forEach((uuid) => {
      this.acked.set(uuid, status);
      // unless it was promoted while the report was out
      if (this.pending.get(uuid) === status) {
        this.pending.delete(uuid);
      }
    });
    this.save();
  }

  private storageKey(): string {
    return `${STORAGE_PREFIX}${this.chatId}`;
  }

  private load(): void {
    try {
      const saved = JSON.parse(
        window.localStorage.getItem(this.storageKey()) || '[]'
      );
      saved.forEach(([uuid, status]: [string, AckStatus]) => {
        if (LEVELS[status]) {
          this.acked.set(uuid, status);
        }
      });
    } catch (err) {
      // nothing remembered, so anything we're sent is reported again
    }
  }

  private save(): void {
    const entries = [...this.acked.entries()];
    const kept = entries.slice(Math.max(0, entries.length - MAX_REMEMBERED));
    try {
      window.localStorage.setItem(this.storageKey(), JSON.stringify(kept));
    } catch (err) {
      // storage off or full - reports after a reload will be repeats
    }
  }
}
