/**
 * WebRTC P2P multiplayer — native RTCPeerConnection, manual copy-paste
 * signaling, zero server (design.md §11.5).
 *
 * Topology: star — the host is the authority. Joiners connect only to the
 * host; the host rebroadcasts roster/state/events to every other peer.
 * Max 4 players per room.
 *
 * Channels per peer:
 *   `events` — reliable + ordered (hello, roster, start, emote, checkpoint,
 *              summit, respawn, leave, ping/pong)
 *   `state`  — maxRetransmits 0, unordered (15Hz position snapshots)
 *
 * Codes: local SDP (offer/answer) → JSON → lz-string compressToBase64 →
 * URL-safe alphabet, so they survive copy-paste through any chat app.
 */

import { compressToBase64, decompressFromBase64 } from 'lz-string';

export const MAX_PLAYERS = 4;
const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
const ICE_GATHER_TIMEOUT_MS = 2500;
const CONNECT_TIMEOUT_MS = 10000;
const HEARTBEAT_MS = 2000;
const PONG_TIMEOUT_MS = 10000;

export type PlayerId = string;

export interface PlayerInfo {
  id: PlayerId;
  name: string;
  color: string;
  cosmetic: string;
  altitude: number;
  ping?: number;
  isHost?: boolean;
}

/** 15Hz position snapshot (design.md §11.5 `state`). */
export interface RemoteState {
  id: PlayerId;
  p: [number, number, number];
  ry: number;
  pitch: number;
  /** bitflags: 1=moving 2=hanging 4=exhausted 8=falling */
  f: number;
  /** stamina 0–100 */
  s: number;
}

export type EventType =
  | 'hello'
  | 'roster'
  | 'start'
  | 'emote'
  | 'checkpoint'
  | 'summit'
  | 'respawn'
  | 'leave'
  | 'pull'
  | 'ping'
  | 'pong';

export interface NetMessage {
  t: EventType | string;
  [key: string]: unknown;
}

export type EmoteKind = 'wave' | 'cheer' | 'point' | 'sos';

export interface RoomCallbacks {
  /** Full roster update (host-authoritative). */
  onRoster?: (players: PlayerInfo[]) => void;
  /** 15Hz remote state snapshot, after host relay. */
  onState?: (state: RemoteState) => void;
  /** Game events: start, emote, checkpoint, summit, respawn, leave. */
  onEvent?: (msg: NetMessage, from: PlayerId) => void;
  onPeerJoined?: (p: PlayerInfo) => void;
  onPeerLeft?: (id: PlayerId) => void;
  /** Round-trip latency update per peer (ms). Joiners only track the host. */
  onPingUpdate?: (id: PlayerId, ms: number) => void;
  /** Host channel closed — run continues solo (no host migration). */
  onHostLeft?: () => void;
  onError?: (err: Error) => void;
}

export const NET_ERRORS = {
  badCode: '无法识别的邀请码',
  connectFailed: '连接失败，请重试',
  roomFull: '房间已满（最多 4 人）',
} as const;

interface PeerEntry {
  pc: RTCPeerConnection;
  events: RTCDataChannel | null;
  state: RTCDataChannel | null;
  info: PlayerInfo | null;
  open: boolean;
  lastPong: number;
  pingSentAt: number;
  ping: number;
  /** pending connect timeout timer */
  timer?: ReturnType<typeof setTimeout>;
}

function genId(): PlayerId {
  return Math.random().toString(36).slice(2, 10);
}

/* ------------------------- code encode/decode ------------------------- */

function encodeCode(desc: RTCSessionDescriptionInit): string {
  return compressToBase64(JSON.stringify(desc))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function decodeCode(code: string): RTCSessionDescriptionInit {
  const cleaned = code.trim().replace(/\s+/g, '');
  if (!cleaned || cleaned.length < 32) throw new Error(NET_ERRORS.badCode);
  const b64 = cleaned.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const json = decompressFromBase64(padded);
  if (!json) throw new Error(NET_ERRORS.badCode);
  try {
    const desc = JSON.parse(json) as RTCSessionDescriptionInit;
    if (!desc || (desc.type !== 'offer' && desc.type !== 'answer') || typeof desc.sdp !== 'string') {
      throw new Error('bad desc');
    }
    return desc;
  } catch {
    throw new Error(NET_ERRORS.badCode);
  }
}

function waitIceGather(pc: RTCPeerConnection, timeout = ICE_GATHER_TIMEOUT_MS): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', onChange);
      resolve();
    };
    const timer = setTimeout(done, timeout);
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') done();
    };
    pc.addEventListener('icegatheringstatechange', onChange);
  });
}

/* ------------------------------ session ------------------------------ */

export class RoomSession {
  readonly mode: 'host' | 'join';
  readonly id: PlayerId;
  readonly profile: { name: string; color: string; cosmetic: string };

  private peers = new Map<PlayerId, PeerEntry>();
  /** host: offers created but not yet answered/open (FIFO). */
  private pending: PeerEntry[] = [];
  private roster: PlayerInfo[] = [];
  private callbacks: RoomCallbacks = {};
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  private constructor(mode: 'host' | 'join', profile: { name: string; color: string; cosmetic: string }) {
    this.mode = mode;
    this.id = genId();
    this.profile = profile;
  }

  static host(profile: { name: string; color: string; cosmetic: string }): RoomSession {
    return new RoomSession('host', profile);
  }

  static join(profile: { name: string; color: string; cosmetic: string }): RoomSession {
    return new RoomSession('join', profile);
  }

  on(cb: RoomCallbacks): void {
    this.callbacks = { ...this.callbacks, ...cb };
  }

  getPlayers(): PlayerInfo[] {
    return [...this.roster];
  }

  getPeerCount(): number {
    return this.peers.size;
  }

  get localPlayer(): PlayerInfo {
    return {
      id: this.id,
      name: this.profile.name,
      color: this.profile.color,
      cosmetic: this.profile.cosmetic,
      altitude: 0,
      isHost: this.mode === 'host',
    };
  }

  /* --------------------------- host side --------------------------- */

  /**
   * Host step 1: create a fresh RTCPeerConnection + channels, produce an
   * 邀请码 (offer code). One code admits exactly one joiner — call again for
   * each additional player (max 4 total).
   */
  async createHostOffer(): Promise<string> {
    this.ensureMode('host');
    if (this.peers.size + this.pending.length >= MAX_PLAYERS - 1) {
      throw new Error(NET_ERRORS.roomFull);
    }
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const entry: PeerEntry = {
      pc,
      events: null,
      state: null,
      info: null,
      open: false,
      lastPong: Date.now(),
      pingSentAt: 0,
      ping: 0,
    };
    entry.events = pc.createDataChannel('events', { ordered: true });
    entry.state = pc.createDataChannel('state', { ordered: false, maxRetransmits: 0 });
    this.wireHostChannel(entry, entry.events);
    this.wireHostChannel(entry, entry.state);
    this.pending.push(entry);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitIceGather(pc);
    return encodeCode(pc.localDescription!.toJSON());
  }

  /** Host step 2: paste the joiner's 应答码 (answer code). */
  async hostAcceptAnswer(code: string): Promise<void> {
    this.ensureMode('host');
    const desc = decodeCode(code);
    if (desc.type !== 'answer') throw new Error(NET_ERRORS.badCode);
    const entry = this.pending.find((p) => !p.pc.remoteDescription);
    if (!entry) throw new Error(NET_ERRORS.badCode);
    await entry.pc.setRemoteDescription(desc);
    entry.timer = setTimeout(() => {
      if (!entry.open) {
        this.dropEntry(entry);
        this.fail(new Error(NET_ERRORS.connectFailed));
      }
    }, CONNECT_TIMEOUT_MS);
  }

  /* --------------------------- join side --------------------------- */

  /**
   * Joiner step 1+2: paste the host's 邀请码, returns the 应答码 to send back.
   */
  async joinWithOffer(code: string): Promise<string> {
    this.ensureMode('join');
    const desc = decodeCode(code);
    if (desc.type !== 'offer') throw new Error(NET_ERRORS.badCode);
    // a joiner keeps a single connection to the host
    for (const p of this.peers.values()) this.dropEntry(p);

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const entry: PeerEntry = {
      pc,
      events: null,
      state: null,
      info: null,
      open: false,
      lastPong: Date.now(),
      pingSentAt: 0,
      ping: 0,
    };
    pc.ondatachannel = (ev) => {
      if (ev.channel.label === 'events') {
        entry.events = ev.channel;
      } else if (ev.channel.label === 'state') {
        entry.state = ev.channel;
      }
      this.wireJoinerChannel(entry, ev.channel);
    };
    this.peers.set('host', entry);
    entry.timer = setTimeout(() => {
      if (!entry.open) {
        this.dropEntry(entry);
        this.fail(new Error(NET_ERRORS.connectFailed));
      }
    }, CONNECT_TIMEOUT_MS);

    await pc.setRemoteDescription(desc);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitIceGather(pc);
    return encodeCode(pc.localDescription!.toJSON());
  }

  /* ------------------------- channel wiring ------------------------- */

  private wireHostChannel(entry: PeerEntry, ch: RTCDataChannel): void {
    ch.onopen = () => {
      // wait for `hello` on the events channel before announcing
    };
    ch.onmessage = (ev) => {
      let msg: NetMessage;
      try {
        msg = JSON.parse(String(ev.data)) as NetMessage;
      } catch {
        return;
      }
      if (ch.label === 'state') {
        if (msg.t === 'state') {
          const st = msg as unknown as RemoteState;
          if (entry.info) st.id = entry.info.id;
          this.callbacks.onState?.(st);
          this.relayState(entry, msg); // star relay
        }
        return;
      }
      this.hostOnEvent(entry, msg);
    };
    ch.onclose = () => this.hostPeerClosed(entry);
    ch.onerror = () => this.hostPeerClosed(entry);
  }

  private wireJoinerChannel(entry: PeerEntry, ch: RTCDataChannel): void {
    if (ch.label === 'events') {
      ch.onopen = () => {
        if (entry.timer) clearTimeout(entry.timer);
        entry.open = true;
        this.sendOnChannel(ch, {
          t: 'hello',
          id: this.id,
          name: this.profile.name,
          color: this.profile.color,
          cosmetic: this.profile.cosmetic,
        });
        this.startHeartbeat();
      };
    }
    ch.onmessage = (ev) => {
      let msg: NetMessage;
      try {
        msg = JSON.parse(String(ev.data)) as NetMessage;
      } catch {
        return;
      }
      if (ch.label === 'state') {
        if (msg.t === 'state') this.callbacks.onState?.(msg as unknown as RemoteState);
        return;
      }
      this.joinerOnEvent(entry, msg);
    };
    ch.onclose = () => this.hostConnectionClosed();
    ch.onerror = () => this.hostConnectionClosed();
  }

  /* ------------------------- message handling ------------------------- */

  private hostOnEvent(entry: PeerEntry, msg: NetMessage): void {
    switch (msg.t) {
      case 'hello': {
        const info: PlayerInfo = {
          id: String(msg.id ?? genId()),
          name: String(msg.name ?? '登山者'),
          color: String(msg.color ?? '#D0713F'),
          cosmetic: String(msg.cosmetic ?? 'beanie'),
          altitude: 0,
        };
        if (entry.timer) clearTimeout(entry.timer);
        entry.info = info;
        entry.open = true;
        // move from pending → live peers
        this.pending = this.pending.filter((p) => p !== entry);
        this.peers.set(info.id, entry);
        this.broadcastRoster();
        this.callbacks.onPeerJoined?.(info);
        break;
      }
      case 'ping': {
        if (entry.events?.readyState === 'open') {
          this.sendOnChannel(entry.events, { t: 'pong', ts: msg.ts });
        }
        break;
      }
      case 'pong': {
        entry.lastPong = Date.now();
        entry.ping = Math.max(0, Date.now() - Number(msg.ts ?? Date.now()));
        if (entry.info) this.callbacks.onPingUpdate?.(entry.info.id, entry.ping);
        break;
      }
      case 'leave': {
        this.hostPeerClosed(entry);
        break;
      }
      default: {
        // game events from a joiner → relay to everyone else + surface locally
        if (entry.info) {
          this.callbacks.onEvent?.(msg, entry.info.id);
          this.relayEvent(entry, msg);
        }
      }
    }
  }

  private joinerOnEvent(_entry: PeerEntry, msg: NetMessage): void {
    switch (msg.t) {
      case 'roster': {
        const players = (msg.players as PlayerInfo[]) ?? [];
        this.roster = players;
        this.callbacks.onRoster?.(players);
        break;
      }
      case 'ping': {
        const host = this.peers.get('host');
        if (host?.events?.readyState === 'open') {
          this.sendOnChannel(host.events, { t: 'pong', ts: msg.ts });
        }
        break;
      }
      case 'pong': {
        const host = this.peers.get('host');
        if (host) {
          host.lastPong = Date.now();
          host.ping = Math.max(0, Date.now() - Number(msg.ts ?? Date.now()));
          this.callbacks.onPingUpdate?.('host', host.ping);
        }
        break;
      }
      default:
        this.callbacks.onEvent?.(msg, String(msg.id ?? 'host'));
    }
  }

  /* ------------------------------ relay ------------------------------ */

  /** Host → all other peers (star topology). */
  private relayEvent(from: PeerEntry, msg: NetMessage): void {
    for (const [id, p] of this.peers) {
      if (p === from || !p.open) continue;
      if (p.events?.readyState === 'open') this.sendOnChannel(p.events, msg);
      void id;
    }
  }

  private relayState(from: PeerEntry, msg: NetMessage): void {
    for (const p of this.peers.values()) {
      if (p === from || !p.open) continue;
      if (p.state?.readyState === 'open') this.sendOnChannel(p.state, msg);
    }
  }

  private broadcastRoster(): void {
    const players: PlayerInfo[] = [this.localPlayer];
    for (const p of this.peers.values()) {
      if (p.info) players.push({ ...p.info, ping: p.ping });
    }
    this.roster = players;
    const msg: NetMessage = { t: 'roster', players };
    for (const p of this.peers.values()) {
      if (p.open && p.events?.readyState === 'open') this.sendOnChannel(p.events, msg);
    }
    this.callbacks.onRoster?.(players);
  }

  /* --------------------------- send helpers --------------------------- */

  private sendOnChannel(ch: RTCDataChannel, msg: NetMessage): void {
    try {
      ch.send(JSON.stringify(msg));
    } catch {
      /* channel closing mid-send */
    }
  }

  /** Reliable game event. Host: broadcast to all. Joiner: send to host (host relays). */
  sendEvent(msg: NetMessage): void {
    if (this.mode === 'host') {
      for (const p of this.peers.values()) {
        if (p.open && p.events?.readyState === 'open') this.sendOnChannel(p.events, msg);
      }
    } else {
      const host = this.peers.get('host');
      if (host?.open && host.events?.readyState === 'open') this.sendOnChannel(host.events, msg);
    }
  }

  /** 15Hz unreliable state snapshot. */
  sendState(state: Omit<RemoteState, 'id'>): void {
    const msg = { t: 'state', id: this.id, ...state };
    if (this.mode === 'host') {
      for (const p of this.peers.values()) {
        if (p.open && p.state?.readyState === 'open') this.sendOnChannel(p.state, msg);
      }
    } else {
      const host = this.peers.get('host');
      if (host?.open && host.state?.readyState === 'open') this.sendOnChannel(host.state, msg);
    }
  }

  /** Host only: start a run / 再来一局 with a fresh world seed. */
  startGame(seed: number): void {
    this.sendEvent({ t: 'start', seed });
  }

  /** Host only: notify that a peer reached a checkpoint, summit, etc. */
  sendEmote(e: EmoteKind): void {
    this.sendEvent({ t: 'emote', id: this.id, e });
  }

  /**
   * Helping hand (援手): ask `target` to glide up to your position. Sent on
   * the reliable events channel; the host relays it like any other event,
   * and the target client animates the pull (authority of own position).
   */
  sendPull(target: PlayerId): void {
    this.sendEvent({ t: 'pull', id: this.id, target });
  }

  /* ---------------------------- heartbeat ---------------------------- */

  private startHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      const now = Date.now();
      for (const p of this.peers.values()) {
        if (!p.open) continue;
        if (p.events?.readyState === 'open') {
          p.pingSentAt = now;
          this.sendOnChannel(p.events, { t: 'ping', ts: now });
        }
        if (now - p.lastPong > PONG_TIMEOUT_MS) {
          // stale peer
          if (this.mode === 'host') this.hostPeerClosed(p);
          else this.hostConnectionClosed();
        }
      }
    }, HEARTBEAT_MS);
  }

  /* ----------------------------- teardown ----------------------------- */

  private hostPeerClosed(entry: PeerEntry): void {
    if (!entry.info) {
      this.dropEntry(entry);
      return;
    }
    const id = entry.info.id;
    // both channels (events + state) fire onclose — report the leave once
    entry.info = null;
    this.dropEntry(entry);
    this.broadcastRoster();
    this.callbacks.onPeerLeft?.(id);
  }

  private hostConnectionClosed(): void {
    if (this.closed) return;
    const host = this.peers.get('host');
    if (!host) return; // already handled — both channels fire onclose
    this.dropEntry(host);
    this.callbacks.onHostLeft?.();
  }

  private dropEntry(entry: PeerEntry): void {
    if (entry.timer) clearTimeout(entry.timer);
    this.pending = this.pending.filter((p) => p !== entry);
    for (const [k, v] of this.peers) {
      if (v === entry) this.peers.delete(k);
    }
    try {
      entry.events?.close();
    } catch {
      /* noop */
    }
    try {
      entry.state?.close();
    } catch {
      /* noop */
    }
    try {
      entry.pc.close();
    } catch {
      /* noop */
    }
  }

  /** Graceful leave: notify peers, close everything. */
  leave(): void {
    if (this.closed) return;
    try {
      this.sendEvent({ t: 'leave', id: this.id });
    } catch {
      /* noop */
    }
    this.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    for (const p of [...this.peers.values(), ...this.pending]) this.dropEntry(p);
    this.peers.clear();
    this.pending = [];
  }

  private ensureMode(mode: 'host' | 'join'): void {
    if (this.mode !== mode) throw new Error(`RoomSession is in '${this.mode}' mode`);
    if (this.closed) throw new Error('RoomSession is closed');
  }

  private fail(err: Error): void {
    if (this.callbacks.onError) this.callbacks.onError(err);
    else console.error('[net]', err);
  }
}
