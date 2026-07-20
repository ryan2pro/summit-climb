import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { CheckCircle2, Dices, Loader2, Mountain, UserPlus, Users } from 'lucide-react';
import Button from '@/components/Button';
import Card from '@/components/Card';
import CodeBox from '@/components/CodeBox';
import PlayerChip from '@/components/PlayerChip';
import { useToast } from '@/components/Toast';
import { useSession } from '@/lib/session';
import { MAX_PLAYERS, NET_ERRORS, RoomSession } from '@/lib/net';
import type { PlayerInfo } from '@/lib/net';
import { formatSeed, newWorldSeed } from '@/lib/prng';
import { cn } from '@/lib/utils';

/**
 * Room panel 集结营地 (lobby.md): three tabs implementing the design.md
 * §11.5 manual-signaling UX state machines.
 *
 *   创建房间 (host): idle → generating → waiting-answer → connected(≥1) → starting
 *   加入房间 (join): idle → pasted → answer-ready → connecting → connected → auto-start
 *   单人试炼 (solo): seed + 开始攀登
 *
 * Rooms that are not handed off to the game page (via session startHost /
 * startJoin) are closed on tab switch / unmount (lobby.md 路由守卫).
 */

type TabId = 'host' | 'join' | 'solo';
type HostStep = 'idle' | 'generating' | 'open';
type JoinStep = 'idle' | 'generating' | 'waiting' | 'connected';

const TABS: { id: TabId; label: string }[] = [
  { id: 'host', label: '创建房间' },
  { id: 'join', label: '加入房间' },
  { id: 'solo', label: '单人试炼' },
];

function errorText(err: unknown): string {
  if (err instanceof Error) {
    if (err.message === NET_ERRORS.badCode) return '无法识别的邀请码，请检查后重试';
    if (err.message === NET_ERRORS.roomFull) return err.message;
  }
  return '连接失败，请重试';
}

/* ------------------------------------------------------------------ */
/* small building blocks                                               */
/* ------------------------------------------------------------------ */

/** Step transition: old step x -24 out, new step x +24 in (300ms spring). */
function Step({ stepKey, children }: { stepKey: string; children: ReactNode }) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={stepKey}
        initial={{ opacity: 0, x: 24 }}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: -24 }}
        transition={{ duration: 0.3, ease: [0.34, 1.56, 0.64, 1] }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}

function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, x: [0, -8, 8, -5, 5, 0] }}
      transition={{ duration: 0.45 }}
      role="alert"
      className="flex items-center justify-between gap-3 rounded-2xl border-2 border-danger bg-danger/10 px-4 py-3 text-sm font-bold text-danger"
    >
      <span>{message}</span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 underline underline-offset-2 transition-colors hover:text-ink"
        >
          重试
        </button>
      )}
    </motion.div>
  );
}

function StatusLine({ connected }: { connected: boolean }) {
  return (
    <div className="flex items-center gap-2 text-sm font-bold text-ink-soft">
      <span
        className={cn('h-2.5 w-2.5 rounded-full', connected ? 'bg-sage' : 'animate-pulse bg-sky')}
        aria-hidden
      />
      {connected ? '已就位，可以出发！' : '等待好友连接…'}
    </div>
  );
}

function PlayerList({
  players,
  selfId,
  pending,
}: {
  players: PlayerInfo[];
  selfId: string | undefined;
  pending: boolean;
}) {
  return (
    <div>
      <div className="mb-2 flex items-center gap-1.5 text-sm font-bold text-ink-soft">
        <Users size={15} aria-hidden />
        队伍
      </div>
      <ul className="flex flex-col gap-2">
        <AnimatePresence initial={false}>
          {players.map((p, i) => (
            <motion.li
              key={p.id}
              layout="position"
              initial={{ opacity: 0, scale: 0.8, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, height: 0 }}
              transition={{ type: 'spring', stiffness: 480, damping: 24, delay: i * 0.05 }}
              className="flex items-center gap-2.5"
            >
              <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-sage" title="已连接" aria-hidden />
              <PlayerChip
                name={p.name}
                color={p.color}
                isHost={p.isHost}
                isSelf={p.id === selfId}
                ping={p.ping && p.ping > 0 ? p.ping : undefined}
              />
            </motion.li>
          ))}
          {pending && (
            <motion.li
              key="__pending__"
              layout="position"
              initial={{ opacity: 0, scale: 0.8, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, height: 0 }}
              transition={{ type: 'spring', stiffness: 480, damping: 24 }}
              className="flex items-center gap-2.5"
            >
              <span className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-sky" aria-hidden />
              <span className="rounded-full border-2 border-dashed border-ink/25 px-3 py-1.5 text-sm font-bold text-ink-soft/70">
                等待好友加入…
              </span>
            </motion.li>
          )}
        </AnimatePresence>
      </ul>
      <div className="mt-2 text-right font-mono text-xs text-ink-soft">
        {players.length}/{MAX_PLAYERS} 名登山者
      </div>
    </div>
  );
}

function SeedRow({ seed, onReroll }: { seed: number; onReroll: () => void }) {
  return (
    <div className="flex items-center justify-between rounded-2xl border-2 border-line bg-snow/60 px-4 py-2">
      <span className="font-mono text-sm text-ink-soft">
        种子 <span className="font-bold text-ink">#{formatSeed(seed)}</span>
      </span>
      <button
        type="button"
        onClick={onReroll}
        title="换一座山"
        aria-label="换一座山"
        className="rounded-full p-1.5 text-ink-soft transition-colors hover:bg-ink/5 hover:text-terracotta"
      >
        <Dices size={18} />
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* main panel                                                          */
/* ------------------------------------------------------------------ */

export default function RoomPanel({ guardName }: { guardName: () => boolean }) {
  const { profile, startSolo, startHost, startJoin } = useSession();
  const navigate = useNavigate();
  const toast = useToast();

  const [tab, setTab] = useState<TabId>('host');
  const [hostStep, setHostStep] = useState<HostStep>('idle');
  const [joinStep, setJoinStep] = useState<JoinStep>('idle');
  const [hostError, setHostError] = useState<string | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);

  const [offerCode, setOfferCode] = useState('');
  const [answerInput, setAnswerInput] = useState('');
  const [inviteInput, setInviteInput] = useState('');
  const [answerCode, setAnswerCode] = useState('');
  const [addingOffer, setAddingOffer] = useState(false);
  const [pendingOffer, setPendingOffer] = useState(false);
  const [roster, setRoster] = useState<PlayerInfo[]>([]);
  const [departing, setDeparting] = useState(false);

  const [hostSeed, setHostSeed] = useState(() => newWorldSeed());
  const [soloSeed, setSoloSeed] = useState(() => newWorldSeed());

  const roomRef = useRef<RoomSession | null>(null);
  const handedOffRef = useRef(false);
  const rosterRef = useRef<PlayerInfo[]>([]);
  const namesRef = useRef(new Map<string, string>());
  const joinStepRef = useRef<JoinStep>('idle');

  useEffect(() => {
    joinStepRef.current = joinStep;
  }, [joinStep]);

  // page exit: close any connection not handed off to the game page
  useEffect(() => {
    return () => {
      if (!handedOffRef.current) roomRef.current?.close();
    };
  }, []);

  const resetFlows = useCallback(() => {
    if (!handedOffRef.current) roomRef.current?.leave(); // graceful: notify peers
    roomRef.current = null;
    rosterRef.current = [];
    setRoster([]);
    setOfferCode('');
    setAnswerCode('');
    setAnswerInput('');
    setPendingOffer(false);
    setAddingOffer(false);
    setHostError(null);
    setJoinError(null);
    setHostStep('idle');
    setJoinStep('idle');
  }, []);

  const switchTab = useCallback(
    (t: TabId) => {
      if (t === tab) return;
      resetFlows();
      setTab(t);
    },
    [tab, resetFlows],
  );

  /* ------------------------------ host ------------------------------ */

  const createRoom = useCallback(async () => {
    if (!guardName()) return;
    setHostError(null);
    setHostStep('generating');
    const room = RoomSession.host({
      name: profile.name.trim(),
      color: profile.color,
      cosmetic: profile.cosmetic,
    });
    roomRef.current = room;
    room.on({
      onRoster: (players) => {
        rosterRef.current = players;
        for (const p of players) namesRef.current.set(p.id, p.name);
        setRoster(players);
        setPendingOffer(false);
      },
      onPeerJoined: (p) => {
        namesRef.current.set(p.id, p.name);
        toast(`已连接：${p.name}`, 'success');
      },
      onPeerLeft: (id) => {
        toast(`${namesRef.current.get(id) ?? '队友'} 离开了营地`);
      },
      onPingUpdate: (id, ms) => {
        setRoster((rs) => rs.map((r) => (r.id === id ? { ...r, ping: ms } : r)));
      },
      onError: (err) => setHostError(errorText(err)),
    });
    try {
      const code = await room.createHostOffer();
      if (roomRef.current !== room) return; // abandoned while ICE gathering
      setOfferCode(code);
      setPendingOffer(true);
      const self = room.localPlayer;
      rosterRef.current = [self];
      namesRef.current.set(self.id, self.name);
      setRoster([self]);
      setHostStep('open');
    } catch (err) {
      if (roomRef.current !== room) return;
      setHostError(errorText(err));
      setHostStep('idle');
      room.close();
      roomRef.current = null;
    }
  }, [guardName, profile, toast]);

  const acceptAnswer = useCallback(async () => {
    const room = roomRef.current;
    if (!room || !answerInput.trim()) return;
    setHostError(null);
    try {
      await room.hostAcceptAnswer(answerInput);
      if (roomRef.current !== room) return;
      setAnswerInput('');
    } catch (err) {
      if (roomRef.current !== room) return;
      setHostError(errorText(err));
    }
  }, [answerInput]);

  const addPlayer = useCallback(async () => {
    const room = roomRef.current;
    if (!room || addingOffer) return;
    setAddingOffer(true);
    setHostError(null);
    try {
      const code = await room.createHostOffer();
      if (roomRef.current !== room) return;
      setOfferCode(code);
      setPendingOffer(true);
    } catch (err) {
      if (roomRef.current === room) setHostError(errorText(err));
    } finally {
      setAddingOffer(false);
    }
  }, [addingOffer]);

  const beginHost = useCallback(
    (withPeers: boolean) => {
      if (!guardName()) return;
      const room = roomRef.current;
      if (withPeers && room) {
        // hand the live connection to the game page via session context
        handedOffRef.current = true;
        room.on({
          onRoster: undefined,
          onPeerJoined: undefined,
          onPeerLeft: undefined,
          onPingUpdate: undefined,
          onError: undefined,
        });
        startHost(hostSeed, room);
        room.startGame(hostSeed); // broadcast `start` {seed}
      } else {
        if (room) {
          room.leave();
          roomRef.current = null;
        }
        startSolo(hostSeed);
      }
      setDeparting(true);
      window.setTimeout(() => navigate('/game'), 850);
    },
    [guardName, hostSeed, navigate, startHost, startSolo],
  );

  /* ------------------------------ join ------------------------------ */

  const generateAnswer = useCallback(async () => {
    if (!guardName() || !inviteInput.trim()) return;
    setJoinError(null);
    setJoinStep('generating');
    const room = RoomSession.join({
      name: profile.name.trim(),
      color: profile.color,
      cosmetic: profile.cosmetic,
    });
    roomRef.current = room;
    room.on({
      onRoster: (players) => {
        rosterRef.current = players;
        for (const p of players) namesRef.current.set(p.id, p.name);
        setRoster(players);
        if (joinStepRef.current === 'waiting' || joinStepRef.current === 'generating') {
          const host = players.find((p) => p.isHost);
          toast(`已连接：${host?.name ?? '房主'}`, 'success');
          setJoinStep('connected');
        }
      },
      onEvent: (msg) => {
        if (msg.t !== 'start') return;
        const seed = Number(msg.seed) >>> 0;
        handedOffRef.current = true;
        room.on({
          onRoster: undefined,
          onEvent: undefined,
          onHostLeft: undefined,
          onError: undefined,
          onPingUpdate: undefined,
        });
        startJoin(seed, room);
        setDeparting(true);
        window.setTimeout(() => navigate('/game'), 600);
      },
      onHostLeft: () => {
        roomRef.current = null;
        setJoinError('连接失败，请重试');
        setJoinStep('idle');
      },
      onError: (err) => {
        roomRef.current = null;
        setJoinError(errorText(err));
        setJoinStep('idle');
      },
      onPingUpdate: (id, ms) => {
        setRoster((rs) => rs.map((r) => (r.id === id || (id === 'host' && r.isHost) ? { ...r, ping: ms } : r)));
      },
    });
    try {
      const answer = await room.joinWithOffer(inviteInput);
      if (roomRef.current !== room) return;
      setAnswerCode(answer);
      setJoinStep('waiting');
    } catch (err) {
      if (roomRef.current !== room) return;
      setJoinError(errorText(err));
      setJoinStep('idle');
      room.close();
      roomRef.current = null;
    }
  }, [guardName, inviteInput, navigate, profile, startJoin, toast]);

  const retryJoin = useCallback(() => {
    roomRef.current?.close();
    roomRef.current = null;
    setJoinError(null);
    setJoinStep('idle');
  }, []);

  /* ------------------------------ solo ------------------------------ */

  const beginSolo = useCallback(() => {
    if (!guardName()) return;
    startSolo(soloSeed);
    setDeparting(true);
    window.setTimeout(() => navigate('/game'), 850);
  }, [guardName, navigate, soloSeed, startSolo]);

  /* ------------------------------ render ---------------------------- */

  const connectedPeers = Math.max(0, roster.length - 1);
  const canStart = tab === 'host' && hostStep === 'open' && connectedPeers >= 1;

  return (
    <Card radius="lg" className="min-h-[520px] p-6 sm:p-8">
      <div className="font-latin text-sm font-semibold uppercase tracking-[0.3em] text-terracotta">
        Base Camp
      </div>
      <h2 className="mt-1 font-zh text-3xl text-ink">集结营地</h2>
      <p className="mt-1 text-sm text-ink-soft">创建房间邀请好友，或粘贴邀请码加入。</p>

      {/* segmented mode tabs with spring sliding indicator */}
      <div className="mt-5 flex rounded-full border-2 border-ink/10 bg-paper p-1">
        {TABS.map((t) => {
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => switchTab(t.id)}
              aria-pressed={active}
              className={cn(
                'relative flex-1 rounded-full py-2.5 text-sm font-bold transition-colors duration-200',
                active ? 'text-snow' : 'text-ink-soft hover:text-ink',
              )}
            >
              {active && (
                <motion.span
                  layoutId="room-tab-indicator"
                  className="absolute inset-0 rounded-full bg-ink"
                  transition={{ type: 'spring', stiffness: 480, damping: 38 }}
                />
              )}
              <span className="relative z-10">{t.label}</span>
            </button>
          );
        })}
      </div>

      <div className="mt-6">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={tab}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
          >
            {/* ------------------------- 创建房间 ------------------------- */}
            {tab === 'host' && (
              <Step stepKey={`host-${hostStep}`}>
                {hostStep === 'idle' && (
                  <div className="flex flex-col items-center gap-4 rounded-3xl border-2 border-dashed border-ink/30 bg-snow/40 px-6 py-12 text-center">
                    <Mountain size={44} className="text-terracotta" aria-hidden />
                    <p className="font-bold text-ink">成为房主，生成邀请码发给好友。</p>
                    {hostError && <ErrorBanner message={hostError} onRetry={() => setHostError(null)} />}
                    <Button size="lg" className="h-14 w-full" onClick={() => void createRoom()}>
                      创建房间
                    </Button>
                  </div>
                )}

                {hostStep === 'generating' && (
                  <div className="flex flex-col items-center gap-4 px-6 py-16 text-center">
                    <Loader2 size={32} className="animate-spin text-terracotta" aria-hidden />
                    <Button size="lg" className="h-14 w-full" disabled>
                      正在开辟营地…
                    </Button>
                  </div>
                )}

                {hostStep === 'open' && (
                  <div className="flex flex-col gap-5">
                    {hostError && <ErrorBanner message={hostError} onRetry={() => setHostError(null)} />}
                    <div>
                      <CodeBox mode="copy" label="邀请码（发给好友）" value={offerCode} rows={3} />
                      <p className="mt-1.5 text-xs text-ink-soft">通过任何聊天工具发给好友</p>
                    </div>
                    <div>
                      <CodeBox
                        mode="paste"
                        label="应答码（粘贴好友回传的码）"
                        value={answerInput}
                        onChange={setAnswerInput}
                        rows={3}
                        placeholder="粘贴应答码…"
                      />
                      <div className="mt-2 flex justify-end">
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={!answerInput.trim()}
                          onClick={() => void acceptAnswer()}
                        >
                          确认连接
                        </Button>
                      </div>
                    </div>

                    <StatusLine connected={connectedPeers > 0} />
                    <PlayerList
                      players={roster}
                      selfId={roomRef.current?.id}
                      pending={pendingOffer && roster.length < MAX_PLAYERS}
                    />

                    <div className="flex items-center justify-between gap-3">
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={roster.length >= MAX_PLAYERS || addingOffer}
                        onClick={() => void addPlayer()}
                      >
                        {addingOffer ? (
                          <Loader2 size={15} className="animate-spin" aria-hidden />
                        ) : (
                          <UserPlus size={15} aria-hidden />
                        )}
                        添加玩家（{roster.length}/{MAX_PLAYERS}）
                      </Button>
                      <button
                        type="button"
                        onClick={resetFlows}
                        className="text-sm font-bold text-ink-soft underline-offset-4 transition-colors hover:text-danger hover:underline"
                      >
                        解散房间
                      </button>
                    </div>

                    <SeedRow seed={hostSeed} onReroll={() => setHostSeed(newWorldSeed())} />

                    <motion.div
                      className="rounded-full"
                      animate={
                        canStart
                          ? {
                              boxShadow: [
                                '0 0 0px rgba(232,169,76,0)',
                                '0 0 24px rgba(232,169,76,0.8)',
                                '0 0 0px rgba(232,169,76,0)',
                              ],
                            }
                          : { boxShadow: '0 0 0px rgba(232,169,76,0)' }
                      }
                      transition={canStart ? { duration: 1.6, repeat: Infinity, ease: 'easeInOut' } : { duration: 0.2 }}
                    >
                      <Button
                        className="h-[60px] w-full bg-sage text-ink hover:bg-sage/90"
                        disabled={!canStart}
                        onClick={() => beginHost(true)}
                      >
                        开始攀登
                      </Button>
                    </motion.div>
                    <div className="text-center">
                      <button
                        type="button"
                        onClick={() => beginHost(false)}
                        className="text-sm font-bold text-ink-soft underline underline-offset-4 transition-colors hover:text-terracotta"
                      >
                        单人也开始
                      </button>
                    </div>
                  </div>
                )}
              </Step>
            )}

            {/* ------------------------- 加入房间 ------------------------- */}
            {tab === 'join' && (
              <Step stepKey={`join-${joinStep}`}>
                {joinStep === 'idle' && (
                  <div className="flex flex-col gap-4">
                    {joinError && <ErrorBanner message={joinError} onRetry={retryJoin} />}
                    <CodeBox
                      mode="paste"
                      label="邀请码（粘贴房主发来的码）"
                      value={inviteInput}
                      onChange={setInviteInput}
                      rows={5}
                      placeholder="粘贴邀请码…"
                    />
                    <Button
                      size="lg"
                      className="h-14 w-full"
                      disabled={!inviteInput.trim()}
                      onClick={() => void generateAnswer()}
                    >
                      生成应答码
                    </Button>
                  </div>
                )}

                {joinStep === 'generating' && (
                  <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
                    <Loader2 size={32} className="animate-spin text-sky" aria-hidden />
                    <p className="font-bold text-ink-soft">正在握手…</p>
                  </div>
                )}

                {joinStep === 'waiting' && (
                  <div className="flex flex-col gap-4">
                    {joinError && <ErrorBanner message={joinError} onRetry={retryJoin} />}
                    <CodeBox mode="copy" label="应答码（发回给房主）" value={answerCode} rows={3} />
                    <p className="text-xs text-ink-soft">把应答码发回给房主，等待连接…</p>
                    <StatusLine connected={false} />
                  </div>
                )}

                {joinStep === 'connected' && (
                  <div className="flex flex-col items-center gap-4 text-center">
                    <motion.div
                      initial={{ scale: 0 }}
                      animate={{ scale: [0, 1.1, 1] }}
                      transition={{ duration: 0.5, times: [0, 0.7, 1], ease: [0.34, 1.56, 0.64, 1] }}
                    >
                      <CheckCircle2 size={56} className="text-sage" aria-hidden />
                    </motion.div>
                    <p className="font-zh text-2xl text-ink">已连接到房主的营地！</p>
                    <div className="w-full text-left">
                      <PlayerList players={roster} selfId={roomRef.current?.id} pending={false} />
                    </div>
                    <p className="flex items-center gap-2 text-sm font-bold text-ink-soft">
                      <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-sky" aria-hidden />
                      等待房主开始攀登…
                    </p>
                  </div>
                )}
              </Step>
            )}

            {/* ------------------------- 单人试炼 ------------------------- */}
            {tab === 'solo' && (
              <Step stepKey="solo">
                <div className="flex flex-col items-center gap-5 rounded-3xl border-2 border-dashed border-ink/30 bg-snow/40 px-6 py-10 text-center">
                  <Mountain size={44} className="text-sage" aria-hidden />
                  <p className="font-bold text-ink">一个人也能爬。随机生成一座山，成绩照样计入最佳。</p>
                  <div className="w-full">
                    <SeedRow seed={soloSeed} onReroll={() => setSoloSeed(newWorldSeed())} />
                  </div>
                  <Button size="lg" className="h-14 w-full" onClick={beginSolo}>
                    开始攀登
                  </Button>
                </div>
              </Step>
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      {/* starting overlay 出发！ */}
      <AnimatePresence>
        {departing && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="fixed inset-0 z-[95] flex flex-col items-center justify-center gap-4 bg-paper/90 backdrop-blur-sm"
          >
            <motion.div
              initial={{ scale: 0.6, y: 24, opacity: 0 }}
              animate={{ scale: 1, y: 0, opacity: 1 }}
              transition={{ type: 'spring', stiffness: 320, damping: 20 }}
              className="flex flex-col items-center gap-4"
            >
              <Mountain size={56} className="text-terracotta" aria-hidden />
              <div className="font-zh text-5xl text-ink">出发！</div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </Card>
  );
}
