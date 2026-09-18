import { Centrifuge, Subscription, SubscriptionState } from 'centrifuge';
import { Watchers } from './Watchers';

/**
 * Access to our realtime messaging socket (centrifugo). The server lives
 * behind the same origin at /ws/connect and authenticates connections with
 * the browser's session cookie (via a server-side connect proxy), so no
 * token handling is needed here.
 *
 * The connection is owned by a SocketManager which is page-scoped - it hangs
 * off `window` rather than any component, so it survives components mounting
 * and unmounting, and vanilla js on the containing page can share the same
 * connection:
 *
 *   const sub = window.sockets.subscribe('notifications:<org>:<user>', (event) => {
 *     ...
 *   });
 *   sub.unsubscribe();
 *
 * Any number of subscribers (components or page js) can watch the same
 * channel - the underlying centrifugo subscription is created on first use
 * and torn down when the last subscriber leaves. The connection itself stays
 * open for the life of the page. Each published event arrives as raw JSON.
 *
 * The connection's state is readable too, so a page can tell its user when it
 * has gone quiet rather than silently showing stale data:
 *
 *   window.sockets.onConnectionState((state) => { ... });
 *
 * The server re-authorizes every subscription against the live session as it
 * goes, so one can be taken away after the fact - the session logged out, or
 * moved to another workspace in a different tab. That arrives as a refused
 * (re)subscribe, which the client doesn't retry, so it is reported rather than
 * left as a channel that has silently gone dead:
 *
 *   window.sockets.onDenied((channel) => { ... });
 */

export interface SocketSubscription {
  unsubscribe(): void;
}

export type PublicationHandler = (data: any) => void;

/**
 * Where the shared connection is. Mirrors centrifugo's own client states -
 * connecting covers the first attempt and every reconnect after a drop, so a
 * page showing a "reconnecting" hint wants that one.
 */
export enum ConnectionState {
  Disconnected = 'disconnected',
  Connecting = 'connecting',
  Connected = 'connected'
}

export type ConnectionStateHandler = (state: ConnectionState) => void;

export type DeniedHandler = (channel: string) => void;

// what the subscribe proxy answers when the session may not have a channel
const FORBIDDEN = 403;

export interface SocketProvider {
  subscribe(
    channel: string,
    onPublication: PublicationHandler,
    onSubscribed?: () => void
  ): SocketSubscription;

  publish(channel: string, data: any): Promise<void>;

  getConnectionState(): ConnectionState;

  onConnectionState(handler: ConnectionStateHandler): SocketSubscription;

  onDenied(handler: DeniedHandler): SocketSubscription;

  recheck(channel: string): void;
}

interface ChannelEntry {
  sub: Subscription;
  count: number;
  onUnsubscribed: (ctx: { code: number }) => void;
}

export class SocketManager implements SocketProvider {
  private socket: Centrifuge = null;
  private channels = new Map<string, ChannelEntry>();
  private createSocket: () => Centrifuge;

  // no connection exists until something asks for one, so that is where we
  // start rather than pretending we know the server is unreachable
  private state = ConnectionState.Disconnected;
  private stateHandlers = new Watchers<ConnectionStateHandler>(
    'socket connection handler'
  );

  private deniedHandlers = new Watchers<DeniedHandler>('socket denied handler');

  constructor(createSocket?: () => Centrifuge) {
    this.createSocket =
      createSocket ||
      (() => {
        const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const socket = new Centrifuge(
          `${protocol}://${window.location.host}/ws/connect`
        );
        socket.connect();
        return socket;
      });
  }

  /**
   * Closes the connection, if one was opened, and forgets its
   * subscriptions. For a manager owned by a single component - the page's
   * shared one lives for the life of the page and is never closed.
   */
  public disconnect(): void {
    if (this.socket) {
      this.channels.clear();
      this.socket.disconnect();
      this.socket = null;
    }
  }

  /**
   * Publishes data on a channel. The server proxies client publications
   * (e.g. typing events on history channels) to mailroom for authorization
   * and fan-out; a rejection means the publication was denied.
   */
  public publish(channel: string, data: any): Promise<void> {
    const socket = this.ensureSocket();

    // prefer the channel's live subscription when we have one
    const entry = this.channels.get(channel);
    const published = entry
      ? entry.sub.publish(data)
      : socket.publish(channel, data);
    return published.then(() => undefined);
  }

  /**
   * The shared connection, opened on first use. Its state is tracked from
   * here on, seeded with whatever it is already in - creating it connects, so
   * the first transition can happen before we are listening.
   */
  private ensureSocket(): Centrifuge {
    if (!this.socket) {
      this.socket = this.createSocket();
      this.socket.on('connecting', () =>
        this.setState(ConnectionState.Connecting)
      );
      this.socket.on('connected', () =>
        this.setState(ConnectionState.Connected)
      );
      this.socket.on('disconnected', () =>
        this.setState(ConnectionState.Disconnected)
      );
      this.setState(this.socket.state as unknown as ConnectionState);
    }
    return this.socket;
  }

  // counts transitions, so an initial delivery can tell whether one beat it
  // to the handler
  private stateSeq = 0;

  private setState(state: ConnectionState): void {
    if (!state || state === this.state) {
      return;
    }
    this.state = state;
    this.stateSeq++;
    this.stateHandlers.each((handler) => handler(state));
  }

  /**
   * Where the shared connection is right now. Disconnected until something
   * subscribes or publishes, since that is what opens it.
   */
  public getConnectionState(): ConnectionState {
    return this.state;
  }

  /**
   * Watches the connection. The handler is called on every transition, and
   * once up front with the current state so a caller never has to pair this
   * with getConnectionState to render.
   */
  public onConnectionState(
    handler: ConnectionStateHandler
  ): SocketSubscription {
    this.stateHandlers.add(handler);

    // where we are now, rather than wherever we've got to by the time the
    // prime lands - opening the connection in this same tick transitions us
    // and delivers that to the handler ahead of it, and saying the same thing
    // again is the repeat this is supposed to suppress
    const initial = this.state;
    const seq = this.stateSeq;
    this.stateHandlers.prime(handler, () => {
      if (this.stateSeq === seq) {
        handler(initial);
      }
    });
    return {
      unsubscribe: () => {
        this.stateHandlers.remove(handler);
      }
    };
  }

  /**
   * Watches for subscriptions the server refuses. A refusal is final - the
   * client leaves the channel unsubscribed rather than retrying - and covers
   * both a channel we were never allowed and one that was taken away when the
   * server re-authorized it.
   */
  public onDenied(handler: DeniedHandler): SocketSubscription {
    this.deniedHandlers.add(handler);
    return {
      unsubscribe: () => {
        this.deniedHandlers.remove(handler);
      }
    };
  }

  /**
   * Has the server authorize a channel's subscription again now, rather than
   * whenever it next gets round to it, by subscribing afresh. For a caller
   * with reason to think access has changed - if it has, that arrives via
   * onDenied. Does nothing for a channel nobody is subscribed to.
   */
  public recheck(channel: string): void {
    const entry = this.channels.get(channel);
    if (entry) {
      entry.sub.unsubscribe();
      entry.sub.subscribe();
    }
  }

  public subscribe(
    channel: string,
    onPublication: PublicationHandler,
    onSubscribed?: () => void
  ): SocketSubscription {
    const socket = this.ensureSocket();

    let entry = this.channels.get(channel);
    if (!entry) {
      entry = {
        sub: socket.getSubscription(channel) || socket.newSubscription(channel),
        count: 0,
        onUnsubscribed: (ctx) => {
          if (ctx && ctx.code === FORBIDDEN) {
            this.deniedHandlers.each((handler) => handler(channel));
          }
        }
      };
      this.channels.set(channel, entry);
      entry.sub.on('unsubscribed', entry.onUnsubscribed);
      entry.sub.subscribe();
    }
    entry.count++;

    const sub = entry.sub;
    const pubHandler = (ctx: { data: any }) => onPublication(ctx.data);
    sub.on('publication', pubHandler);

    let subHandler: () => void = null;
    if (onSubscribed) {
      // fires on every (re)subscribe, including after reconnects, so
      // subscribers can catch up on anything missed while offline
      subHandler = () => onSubscribed();
      sub.on('subscribed', subHandler);

      // late joiners on an already-live channel won't see a subscribed
      // event, so give them their initial one
      if (sub.state === SubscriptionState.Subscribed) {
        window.setTimeout(() => subHandler && subHandler(), 0);
      }
    }

    let active = true;
    return {
      unsubscribe: () => {
        if (!active) {
          return;
        }
        active = false;

        sub.off('publication', pubHandler);
        if (subHandler) {
          sub.off('subscribed', subHandler);
          subHandler = null;
        }

        entry.count--;
        if (entry.count === 0) {
          this.channels.delete(channel);
          sub.off('unsubscribed', entry.onUnsubscribed);
          sub.unsubscribe();
          this.socket.removeSubscription(sub);
        }
      }
    };
  }
}

// the page-scoped manager, shared with vanilla js as window.sockets and
// reused if another copy of this module already created it
const getManager = (): SocketManager => {
  const w = window as any;
  if (!w.sockets) {
    w.sockets = new SocketManager();
  }
  return w.sockets;
};
getManager();

// when set, components subscribe through this instead of the page manager
let provider: SocketProvider = null;

export const subscribeToSocket = (
  channel: string,
  onPublication: PublicationHandler,
  onSubscribed?: () => void
): SocketSubscription => {
  return (provider || getManager()).subscribe(
    channel,
    onPublication,
    onSubscribed
  );
};

export const publishToSocket = (channel: string, data: any): Promise<void> => {
  return (provider || getManager()).publish(channel, data);
};

export const getSocketConnectionState = (): ConnectionState => {
  return (provider || getManager()).getConnectionState();
};

export const onSocketConnectionState = (
  handler: ConnectionStateHandler
): SocketSubscription => {
  return (provider || getManager()).onConnectionState(handler);
};

export const onSocketDenied = (handler: DeniedHandler): SocketSubscription => {
  return (provider || getManager()).onDenied(handler);
};

export const recheckSocket = (channel: string): void => {
  (provider || getManager()).recheck(channel);
};

// for tests to swap in a mock provider, returns the previous provider
export const setSocketProvider = (newProvider: SocketProvider) => {
  const previous = provider;
  provider = newProvider;
  return previous;
};
