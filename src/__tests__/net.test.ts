/**
 * Net tests — signaling code encode/decode, protocol message serialization,
 * and a full in-memory mock of RTCPeerConnection/RTCDataChannel that drives
 * the complete host⇄joiner flow: offer → answer → channel open → hello →
 * roster broadcast → star relay (events + 15Hz unreliable state) → leave.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_PLAYERS,
  NET_ERRORS,
  RoomSession,
  type NetMessage,
  type PlayerInfo,
  type RemoteState,
} from '@/lib/net';

/* --------------------------- WebRTC mocks --------------------------- */

interface MockDesc {
  type: string;
  sdp: string;
}

interface ChannelOpts {
  ordered?: boolean;
  maxRetransmits?: number;
}

class MockDataChannel {
  readonly label: string;
  readonly ordered: boolean;
  readonly maxRetransmits: number | undefined;
  readyState: 'connecting' | 'open' | 'closed' = 'connecting';
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  peer: MockDataChannel | null = null;
  readonly sent: string[] = [];

  constructor(label: string, opts: ChannelOpts = {}) {
    this.label = label;
    this.ordered = opts.ordered ?? true;
    this.maxRetransmits = opts.maxRetransmits;
  }

  send(data: string): void {
    if (this.readyState !== 'open') throw new Error(`send on ${this.readyState} channel`);
    this.sent.push(String(data));
    this.peer?.onmessage?.({ data });
  }

  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    const p = this.peer;
    if (p && p.readyState !== 'closed') {
      p.readyState = 'closed';
      p.onclose?.();
    }
    this.onclose?.();
  }

  open(): void {
    if (this.readyState === 'open') return;
    this.readyState = 'open';
    this.onopen?.();
  }
}

class MockRTCPeerConnection {
  static offerRegistry = new Map<string, MockRTCPeerConnection>();
  static all: MockRTCPeerConnection[] = [];

  readonly channels: MockDataChannel[] = [];
  localDescription: (MockDesc & { toJSON(): MockDesc }) | null = null;
  remoteDescription: MockDesc | null = null;
  iceGatheringState = 'complete';
  ondatachannel: ((ev: { channel: MockDataChannel }) => void) | null = null;
  remotePc: MockRTCPeerConnection | null = null;

  constructor() {
    MockRTCPeerConnection.all.push(this);
  }

  createDataChannel(label: string, opts: ChannelOpts = {}): MockDataChannel {
    const ch = new MockDataChannel(label, opts);
    this.channels.push(ch);
    return ch;
  }

  createOffer(): Promise<MockDesc> {
    return Promise.resolve({ type: 'offer', sdp: `mock-offer-sdp-${MockRTCPeerConnection.all.length}-${this.channels.length}` });
  }

  createAnswer(): Promise<MockDesc> {
    return Promise.resolve({ type: 'answer', sdp: `mock-answer-sdp-${MockRTCPeerConnection.all.length}` });
  }

  setLocalDescription(desc: MockDesc): Promise<void> {
    this.localDescription = { ...desc, toJSON: () => ({ type: desc.type, sdp: desc.sdp }) };
    if (desc.type === 'offer') MockRTCPeerConnection.offerRegistry.set(desc.sdp, this);
    return Promise.resolve();
  }

  setRemoteDescription(desc: MockDesc): Promise<void> {
    this.remoteDescription = desc;
    if (desc.type === 'offer') {
      // joiner side: link back to the host pc that issued this offer
      this.remotePc = MockRTCPeerConnection.offerRegistry.get(desc.sdp) ?? null;
      if (this.remotePc) this.remotePc.remotePc = this;
    } else if (this.remotePc) {
      // host side: answer accepted → wire + open the channel pairs
      MockRTCPeerConnection.connect(this, this.remotePc);
    }
    return Promise.resolve();
  }

  private static connect(host: MockRTCPeerConnection, joiner: MockRTCPeerConnection): void {
    const pairs: MockDataChannel[] = [];
    for (const hostCh of host.channels) {
      const joinerCh = new MockDataChannel(hostCh.label, {
        ordered: hostCh.ordered,
        maxRetransmits: hostCh.maxRetransmits,
      });
      hostCh.peer = joinerCh;
      joinerCh.peer = hostCh;
      joiner.ondatachannel?.({ channel: joinerCh });
      pairs.push(hostCh, joinerCh);
    }
    for (const ch of pairs) ch.open();
  }

  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}

/* ------------------------------ helpers ------------------------------ */

const PROFILE_HOST = { name: '队长', color: '#D0713F', cosmetic: 'beanie' };
const PROFILE_A = { name: '安安', color: '#7FA07A', cosmetic: 'bandana' };
const PROFILE_B = { name: '小北', color: '#5E8FB9', cosmetic: 'goggles' };

let sessions: RoomSession[] = [];

function track<T extends RoomSession>(s: T): T {
  sessions.push(s);
  return s;
}

/** Run one full join handshake; returns once hello + roster are processed. */
async function connectJoiner(
  host: RoomSession,
  profile: typeof PROFILE_A,
  joiner: RoomSession = track(RoomSession.join(profile)),
): Promise<RoomSession> {
  const offerCode = await host.createHostOffer();
  const answerCode = await joiner.joinWithOffer(offerCode);
  await host.hostAcceptAnswer(answerCode);
  return joiner;
}

beforeEach(() => {
  sessions = [];
  MockRTCPeerConnection.all = [];
  MockRTCPeerConnection.offerRegistry = new Map();
  vi.stubGlobal('RTCPeerConnection', MockRTCPeerConnection);
});

afterEach(() => {
  for (const s of sessions) s.close();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/* ------------------------- code encode/decode ------------------------- */

describe('net: signaling code encode/decode', () => {
  it('round-trips an offer code: compress → paste → decompress → valid SDP JSON', async () => {
    const host = track(RoomSession.host(PROFILE_HOST));
    const code = await host.createHostOffer();
    expect(typeof code).toBe('string');
    expect(code.length).toBeGreaterThan(32);
    // URL-safe alphabet only (survives copy-paste through chat apps)
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
    // the joiner decodes it: must be a valid offer SDP
    const joiner = track(RoomSession.join(PROFILE_A));
    const answerCode = await joiner.joinWithOffer(code);
    expect(answerCode).toMatch(/^[A-Za-z0-9_-]+$/);
    // and the host decodes the answer in turn
    await host.hostAcceptAnswer(answerCode);
    expect(host.getPeerCount()).toBeLessThanOrEqual(1); // pending until hello
  });

  it('rejects garbage codes with 无法识别的邀请码', async () => {
    const joiner = track(RoomSession.join(PROFILE_A));
    await expect(joiner.joinWithOffer('')).rejects.toThrow(NET_ERRORS.badCode);
    await expect(joiner.joinWithOffer('abc')).rejects.toThrow(NET_ERRORS.badCode);
    await expect(joiner.joinWithOffer('x'.repeat(64))).rejects.toThrow(NET_ERRORS.badCode);
    await expect(joiner.joinWithOffer('aGVsbG8gd29ybGQgbm90LWx6LXN0cmluZyE='.repeat(2))).rejects.toThrow(
      NET_ERRORS.badCode,
    );
  });

  it('rejects a truncated/tampered valid code', async () => {
    const host = track(RoomSession.host(PROFILE_HOST));
    const code = await host.createHostOffer();
    const truncated = code.slice(0, Math.floor(code.length * 0.6));
    const joiner = track(RoomSession.join(PROFILE_A));
    await expect(joiner.joinWithOffer(truncated)).rejects.toThrow(NET_ERRORS.badCode);
  });

  it('host rejects an offer pasted where an answer is expected (and vice versa)', async () => {
    const host = track(RoomSession.host(PROFILE_HOST));
    const offerCode = await host.createHostOffer();
    // an offer is not a valid answer
    await expect(host.hostAcceptAnswer(offerCode)).rejects.toThrow(NET_ERRORS.badCode);
    // a joiner cannot consume an answer either — build one via a second pair
    const host2 = track(RoomSession.host(PROFILE_HOST));
    const j2 = track(RoomSession.join(PROFILE_B));
    const answerCode = await j2.joinWithOffer(await host2.createHostOffer());
    const joiner = track(RoomSession.join(PROFILE_A));
    await expect(joiner.joinWithOffer(answerCode)).rejects.toThrow(NET_ERRORS.badCode);
  });
});

/* ----------------------- message serialization ----------------------- */

describe('net: protocol message serialization', () => {
  const players: PlayerInfo[] = [
    { id: 'h1', name: '队长', color: '#D0713F', cosmetic: 'beanie', altitude: 12, isHost: true },
    { id: 'j1', name: '安安', color: '#7FA07A', cosmetic: 'bandana', altitude: 30, ping: 42 },
  ];
  const cases: [string, NetMessage][] = [
    ['hello', { t: 'hello', id: 'j1', name: '安安', color: '#7FA07A', cosmetic: 'bandana' }],
    ['roster', { t: 'roster', players }],
    ['start', { t: 'start', seed: 4294967295 }],
    ['state', { t: 'state', id: 'j1', p: [1.5, -2.25, 3], ry: 0.5, pitch: -0.2, f: 3, s: 88 } satisfies RemoteState & { t: string }],
    ['emote', { t: 'emote', id: 'j1', e: 'cheer' }],
    ['checkpoint', { t: 'checkpoint', id: 'j1', index: 2 }],
    ['summit', { t: 'summit', id: 'j1', timeMs: 75432 }],
    ['respawn', { t: 'respawn', id: 'j1' }],
    ['leave', { t: 'leave', id: 'j1' }],
    ['ping', { t: 'ping', ts: 1700000000000 }],
    ['pong', { t: 'pong', ts: 1700000000000 }],
  ];

  it.each(cases)('%s survives a JSON serialize/parse round-trip', (_name, msg) => {
    expect(JSON.parse(JSON.stringify(msg))).toEqual(msg);
  });

  it('covers every documented event type', () => {
    const types = new Set(cases.map(([, m]) => m.t));
    for (const t of ['hello', 'roster', 'start', 'state', 'emote', 'checkpoint', 'summit', 'respawn', 'leave', 'ping', 'pong']) {
      expect(types.has(t)).toBe(true);
    }
  });
});

/* --------------------------- full room flow --------------------------- */

describe('net: RoomSession over mocked RTC (star topology)', () => {
  it('host offer → join answer → accept → channels open → hello → roster to 2 joiners', async () => {
    const host = track(RoomSession.host(PROFILE_HOST));
    const hostRosters: PlayerInfo[][] = [];
    const hostJoined: PlayerInfo[] = [];
    host.on({ onRoster: (p) => hostRosters.push(p), onPeerJoined: (p) => hostJoined.push(p) });

    const j1 = track(RoomSession.join(PROFILE_A));
    const j1Rosters: PlayerInfo[][] = [];
    j1.on({ onRoster: (p) => j1Rosters.push(p) });
    const offer1 = await host.createHostOffer();
    await host.hostAcceptAnswer(await j1.joinWithOffer(offer1));

    expect(host.getPeerCount()).toBe(1);
    expect(hostJoined.map((p) => p.name)).toEqual(['安安']);
    // host roster: self (host flag) + joiner
    const hr = hostRosters.at(-1)!;
    expect(hr).toHaveLength(2);
    expect(hr[0].isHost).toBe(true);
    expect(hr[1].name).toBe('安安');
    // joiner received the same roster via the events channel
    expect(j1Rosters.at(-1)!.map((p) => p.name)).toEqual(['队长', '安安']);

    // second joiner → roster broadcast reaches BOTH joiners
    const j2 = track(RoomSession.join(PROFILE_B));
    const j2Rosters: PlayerInfo[][] = [];
    j2.on({ onRoster: (p) => j2Rosters.push(p) });
    await connectJoiner(host, PROFILE_B, j2);

    expect(host.getPeerCount()).toBe(2);
    expect(host.getPlayers().map((p) => p.name)).toEqual(['队长', '安安', '小北']);
    expect(j1Rosters.at(-1)!.map((p) => p.name)).toEqual(['队长', '安安', '小北']);
    expect(j2Rosters.at(-1)!.map((p) => p.name)).toEqual(['队长', '安安', '小北']);
  });

  it('creates a reliable events channel + an unreliable (maxRetransmits 0, unordered) state channel', async () => {
    const host = track(RoomSession.host(PROFILE_HOST));
    await connectJoiner(host, PROFILE_A);
    const hostPc = MockRTCPeerConnection.all[0];
    const events = hostPc.channels.find((c) => c.label === 'events')!;
    const state = hostPc.channels.find((c) => c.label === 'state')!;
    expect(events.ordered).toBe(true);
    expect(events.maxRetransmits).toBeUndefined();
    expect(state.ordered).toBe(false);
    expect(state.maxRetransmits).toBe(0);
  });

  it('relays joiner events through the host to every other peer (star)', async () => {
    const host = track(RoomSession.host(PROFILE_HOST));
    const hostEvents: [NetMessage, string][] = [];
    host.on({ onEvent: (m, from) => hostEvents.push([m, from]) });
    const j1 = await connectJoiner(host, PROFILE_A);
    const j2 = await connectJoiner(host, PROFILE_B);
    const j1Events: NetMessage[] = [];
    const j2Events: NetMessage[] = [];
    j1.on({ onEvent: (m) => j1Events.push(m) });
    j2.on({ onEvent: (m) => j2Events.push(m) });

    j1.sendEmote('wave');
    // host saw it (attributed to j1) and relayed it to j2 only — no echo to j1
    expect(hostEvents).toHaveLength(1);
    expect(hostEvents[0][0]).toMatchObject({ t: 'emote', e: 'wave', id: j1.id });
    expect(hostEvents[0][1]).toBe(j1.id);
    expect(j2Events).toHaveLength(1);
    expect(j2Events[0]).toMatchObject({ t: 'emote', e: 'wave' });
    expect(j1Events).toHaveLength(0);

    // host events broadcast to all joiners
    host.startGame(20260718);
    expect(j1Events.some((m) => m.t === 'start' && m.seed === 20260718)).toBe(true);
    expect(j2Events.some((m) => m.t === 'start' && m.seed === 20260718)).toBe(true);
  });

  it('routes 15Hz-style state snapshots over the unreliable channel + host relay', async () => {
    const host = track(RoomSession.host(PROFILE_HOST));
    const hostStates: RemoteState[] = [];
    host.on({ onState: (s) => hostStates.push(s) });
    const j1 = await connectJoiner(host, PROFILE_A);
    const j2 = await connectJoiner(host, PROFILE_B);
    const j2States: RemoteState[] = [];
    j2.on({ onState: (s) => j2States.push(s) });

    const snap = { p: [1, 2, 3] as [number, number, number], ry: 0.5, pitch: 0.1, f: 3, s: 87 };
    j1.sendState(snap);
    // host received it with the sender id rewritten to the authenticated peer id
    expect(hostStates).toHaveLength(1);
    expect(hostStates[0]).toMatchObject({ id: j1.id, p: [1, 2, 3], ry: 0.5, pitch: 0.1, f: 3, s: 87 });
    // and relayed to the other joiner
    expect(j2States).toHaveLength(1);
    expect(j2States[0].id).toBe(j1.id);

    // host state broadcasts to both joiners
    const j1States: RemoteState[] = [];
    j1.on({ onState: (s) => j1States.push(s) });
    host.sendState({ p: [0, 150, 0], ry: 0, pitch: 0, f: 0, s: 100 });
    expect(j1States.at(-1)).toMatchObject({ id: host.id, p: [0, 150, 0], s: 100 });
    expect(j2States.at(-1)).toMatchObject({ id: host.id, p: [0, 150, 0], s: 100 });
  });

  it('handles leave: roster shrinks and remaining peers keep working', async () => {
    const host = track(RoomSession.host(PROFILE_HOST));
    const left: string[] = [];
    host.on({ onPeerLeft: (id) => left.push(id) });
    const j1 = await connectJoiner(host, PROFILE_A);
    const j2 = await connectJoiner(host, PROFILE_B);
    const j2Rosters: PlayerInfo[][] = [];
    j2.on({ onRoster: (p) => j2Rosters.push(p) });
    expect(host.getPeerCount()).toBe(2);

    j1.leave();
    expect(left).toEqual([j1.id]);
    expect(host.getPlayers().map((p) => p.name)).toEqual(['队长', '小北']);
    expect(j2Rosters.at(-1)!.map((p) => p.name)).toEqual(['队长', '小北']);
  });

  it('notifies the joiner when the host leaves (no host migration)', async () => {
    const host = track(RoomSession.host(PROFILE_HOST));
    const j1 = await connectJoiner(host, PROFILE_A);
    let hostLeft = 0;
    j1.on({ onHostLeft: () => hostLeft++ });
    host.close();
    expect(hostLeft).toBe(1);
  });

  it('refuses a 5th player with 房间已满', async () => {
    const host = track(RoomSession.host(PROFILE_HOST));
    await connectJoiner(host, PROFILE_A);
    await connectJoiner(host, PROFILE_B);
    await connectJoiner(host, { name: 'CC', color: '#A97FB8', cosmetic: 'champion' });
    expect(host.getPeerCount()).toBe(MAX_PLAYERS - 1);
    await expect(host.createHostOffer()).rejects.toThrow(NET_ERRORS.roomFull);
  });

  it('heartbeat ping → pong updates RTT', async () => {
    vi.useFakeTimers();
    const host = track(RoomSession.host(PROFILE_HOST));
    const j1 = await connectJoiner(host, PROFILE_A);
    const pings: [string, number][] = [];
    j1.on({ onPingUpdate: (id, ms) => pings.push([id, ms]) });
    vi.advanceTimersByTime(2100); // one 2s heartbeat tick
    expect(pings.length).toBeGreaterThanOrEqual(1);
    expect(pings[0][0]).toBe('host');
    expect(pings[0][1]).toBeGreaterThanOrEqual(0);
  });
});
