/**
 * Game page (`/game`) — full-screen chromeless Three.js climb (game.md).
 *
 * Orchestrates: engine + world gen (chunked, seeded) + player controller +
 * input + remotes + HUD + RoomSession multiplayer + IndexedDB persistence.
 * State machine (design.md §11.8): BOOT → READY → PLAYING ⇄ PAUSED → SUMMIT.
 * Route guard: no run context → /lobby.
 */

import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import * as THREE from 'three';
import { useSession } from '@/lib/session';
import type { SessionApi } from '@/lib/session';
import { useToast } from '@/components/Toast';
import { getSettings, saveSettings, getProfile, saveProfile, defaultSettings } from '@/lib/db';
import type { Settings } from '@/lib/db';
import { newWorldSeed } from '@/lib/prng';
import type { NetMessage, PlayerInfo, PlayerId, EmoteKind } from '@/lib/net';
import { Engine, resolveQuality } from '@/game/engine';
import type { ResolvedQuality } from '@/game/engine';
import { generateWorld, MOUNTAIN_H } from '@/game/world';
import type { World } from '@/game/world';
import { Player } from '@/game/player';
import type { FrameInput, PlayerEvents } from '@/game/player';
import { InputManager } from '@/game/input';
import { RemoteManager } from '@/game/remotes';
import { GameAudio } from '@/game/audio';
import { GameHud } from '@/game/hud';
import type {
  CheckpointTick,
  GamePhase,
  HudActions,
  HudData,
  InviteState,
  LoadingInfo,
  Prompt,
  TeamEntry,
  VictoryData,
} from '@/game/hud';

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const PITCH_LIMIT = (87 * Math.PI) / 180;

export default function Game() {
  const session = useSession();
  if (!session.hasRunContext) return <Navigate to="/lobby" replace />;
  return <GameRoot session={session} />;
}

function GameRoot({ session }: { session: SessionApi }) {
  const navigate = useNavigate();
  const toast = useToast();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  /* ------------------------------ react state ------------------------------ */
  const [phase, setPhase] = useState<GamePhase>('boot');
  const [loading, setLoading] = useState<LoadingInfo>({ label: '正在生成山峰…', frac: 0 });
  const [wiping, setWiping] = useState(false);
  const [paused, setPaused] = useState(false);
  const [respawnName, setRespawnName] = useState<string | null>(null);
  const [team, setTeam] = useState<TeamEntry[]>([]);
  const [myPing, setMyPing] = useState<number | null>(null);
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [checkpoints, setCheckpoints] = useState<CheckpointTick[]>([]);
  const [victory, setVictory] = useState<VictoryData | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [gyroOn, setGyroOn] = useState(false);
  const [contextLost, setContextLost] = useState(false);
  const [showPlayers, setShowPlayers] = useState(false);
  const [invite, setInvite] = useState<InviteState | null>(null);
  const [selfEmote, setSelfEmote] = useState<{ kind: EmoteKind; at: number } | null>(null);
  const [bestMs, setBestMs] = useState<number | null>(null);
  const [multiplayerHint, setMultiplayerHint] = useState(false);
  const [hostLeft, setHostLeft] = useState(false);
  const [hostLeftBanner, setHostLeftBanner] = useState(false);
  const [isMobile] = useState(
    () =>
      typeof window !== 'undefined' &&
      (window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window),
  );

  /* --------------------------------- refs --------------------------------- */
  const engineRef = useRef<Engine | null>(null);
  const worldRef = useRef<World | null>(null);
  const playerRef = useRef<Player | null>(null);
  const inputRef = useRef<InputManager | null>(null);
  const remotesRef = useRef<RemoteManager | null>(null);
  const audioRef = useRef<GameAudio | null>(null);
  const hudRef = useRef<HudData>({
    stamina: 100,
    hanging: false,
    exhausted: false,
    canGrab: false,
    altitude: 0,
    timeMs: 0,
    falls: 0,
    grabbed: false,
  });
  const phaseRef = useRef<GamePhase>('boot');
  const pausedRef = useRef(false);
  const settingsRef = useRef<Settings | null>(null);
  const qualityRef = useRef<ResolvedQuality>('medium');
  const isMobileRef = useRef(false);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const seedRef = useRef(session.seed);
  const modeRef = useRef(session.mode);
  const hostLeftRef = useRef(false);
  const startedRef = useRef(false);
  const playedRef = useRef(false);
  const summitHandledRef = useRef(false);
  const simTimeRef = useRef(0);
  const timeMsRef = useRef(0);
  const maxAltRef = useRef(0);
  const milestoneRef = useRef(0);
  const lastStatsSaveRef = useRef(0);
  const rosterRef = useRef<PlayerInfo[]>([]);
  const altByIdRef = useRef(new Map<PlayerId, number>());
  const cpByIdRef = useRef(new Map<PlayerId, number>());
  const pingByIdRef = useRef(new Map<string, number>());
  const summitedRef = useRef(new Set<PlayerId>());
  const lostPeerRef = useRef(new Set<PlayerId>());
  const gonePeerRef = useRef(new Set<PlayerId>());
  const expectUnlockRef = useRef(false);
  const fovKickRef = useRef(0);
  const hintShownRef = useRef(false);
  const promptIdRef = useRef(0);
  const timersRef = useRef<number[]>([]);
  const buildWorldRef = useRef<(seed: number) => Promise<void>>(async () => undefined);
  const victoryRef = useRef<VictoryData | null>(null);
  victoryRef.current = victory;

  const later = (ms: number, fn: () => void) => {
    const id = window.setTimeout(fn, ms);
    timersRef.current.push(id);
    return id;
  };

  const pushPrompt = (text: string) => {
    const id = ++promptIdRef.current;
    setPrompts((list) => [...list.slice(-2), { id, text }]);
    later(2500, () => setPrompts((list) => list.filter((p) => p.id !== id)));
  };

  const setPhaseBoth = (p: GamePhase) => {
    phaseRef.current = p;
    setPhase(p);
  };
  const setPausedBoth = (v: boolean) => {
    pausedRef.current = v;
    setPaused(v);
  };

  /* ------------------------------- team builder ------------------------------- */
  const refreshTeam = () => {
    const s = sessionRef.current;
    const player = playerRef.current;
    const room = s.room;
    const selfAltitude = player ? player.pos.y : 0;
    const entries: TeamEntry[] = [
      {
        id: room?.id ?? 'solo',
        name: s.profile.name,
        color: s.profile.color,
        isHost: modeRef.current === 'host',
        isSelf: true,
        altitude: selfAltitude,
        checkpoint: player?.checkpointIndex ?? 0,
        summited: summitHandledRef.current,
      },
    ];
    if (room && !hostLeftRef.current) {
      const nowS = performance.now() / 1000;
      for (const p of rosterRef.current) {
        if (p.id === room.id) continue;
        // ICE-loss heartbeat: silent >5s → reconnecting toast; >15s → leave
        const lastSeen = remotesRef.current?.getLastSeen(p.id) ?? null;
        const silent = lastSeen == null ? 0 : nowS - lastSeen;
        let lost = false;
        if (silent > 15) {
          if (!gonePeerRef.current.has(p.id)) {
            gonePeerRef.current.add(p.id);
            lostPeerRef.current.delete(p.id);
            toast(`${nameOf(p.id)} 离开了登山队`, 'info');
            remotesRef.current?.removePlayer(p.id);
          }
          continue;
        }
        if (silent > 5) {
          lost = true;
          if (!lostPeerRef.current.has(p.id)) {
            lostPeerRef.current.add(p.id);
            toast(`正在重连 ${nameOf(p.id)}…`, 'info');
          }
        } else if (lostPeerRef.current.delete(p.id)) {
          lost = false;
        }
        entries.push({
          id: p.id,
          name: p.name,
          color: p.color,
          isHost: !!p.isHost,
          isSelf: false,
          altitude: altByIdRef.current.get(p.id) ?? 0,
          checkpoint: cpByIdRef.current.get(p.id) ?? 0,
          summited: summitedRef.current.has(p.id),
          ping: pingByIdRef.current.get(p.id),
          lost,
        });
      }
    }
    setTeam(entries);
    if (modeRef.current === 'solo' || hostLeftRef.current) {
      setMyPing(null);
    } else if (modeRef.current === 'join') {
      setMyPing(pingByIdRef.current.get('host') ?? null);
    } else {
      let max = 0;
      pingByIdRef.current.forEach((v) => {
        max = Math.max(max, v);
      });
      setMyPing(max);
    }
  };

  const nameOf = (id: PlayerId): string => rosterRef.current.find((p) => p.id === id)?.name ?? '队友';

  /* ------------------------------ main lifecycle ------------------------------ */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    const isMobile =
      window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
    isMobileRef.current = isMobile;

    // viewport: prevent double-tap zoom on this route only
    const meta = document.querySelector('meta[name="viewport"]');
    const prevViewport = meta?.getAttribute('content') ?? null;
    meta?.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover');

    let engine: Engine | null = null;
    let input: InputManager | null = null;
    let remotes: RemoteManager | null = null;
    let audio: GameAudio | null = null;
    let raf = 0;
    let lastT = 0;
    let acc = 0;
    let lastSend = 0;
    let lastUiTick = 0;
    let confettiTimer = 0;
    const frameInput: FrameInput = { moveX: 0, moveY: 0, jump: false, grab: false };
    const lookTmp = { dx: 0, dy: 0 };
    const gyroTmp = { dx: 0, dy: 0 };
    const camPos = new THREE.Vector3(0, 10, 40);

    const doPause = () => {
      if (phaseRef.current !== 'playing') return;
      setPausedBoth(true);
      if (modeRef.current !== 'solo' && !hostLeftRef.current && !hintShownRef.current) {
        hintShownRef.current = true;
        setMultiplayerHint(true);
        toast('联机模式下世界不会暂停', 'info');
      }
    };
    const playerEvents: PlayerEvents = {
      onGrab: (hit) => {
        hudRef.current.grabbed = true;
        audio?.grab();
        worldRef.current?.burstAmber(hit.point);
      },
      onJump: () => audio?.jump(),
      onWallJump: () => {
        audio?.wallJump();
        fovKickRef.current = 4;
        const p = playerRef.current;
        if (p) worldRef.current?.burstDust(p.pos.clone().add(new THREE.Vector3(0, 1, 0)));
      },
      onLand: (hard) => {
        audio?.land(hard);
        if (hard) {
          const p = playerRef.current;
          if (p) worldRef.current?.burstDust(p.pos.clone());
        }
      },
      onCheckpoint: (ledge) => {
        toast('已保存检查点', 'success');
        pushPrompt(`已保存检查点 · ${ledge.name}`);
        audio?.checkpoint();
        worldRef.current?.igniteCampfire(ledge.index);
        const room = sessionRef.current.room;
        room?.sendEvent({ t: 'checkpoint', id: room.id, cp: ledge.index });
        refreshTeam();
      },
      onSummit: () => void handleSummit(),
      onRespawn: (auto) => {
        const p = playerRef.current;
        const world = worldRef.current;
        if (p && world) {
          const L = world.ledges[Math.min(p.checkpointIndex, world.ledges.length - 1)];
          setRespawnName(L.name);
          later(1150, () => setRespawnName(null));
          if (auto) toast('巡逻队把你带回了营地', 'info');
        }
        const room = sessionRef.current.room;
        room?.sendEvent({ t: 'respawn', id: room.id });
        refreshTeam();
      },
      onExhausted: () => {
        toast('力竭！脱手了', 'danger');
        pushPrompt('体力见底！');
        audio?.exhausted();
      },
      onFallPrompt: () => {
        pushPrompt(isMobileRef.current ? '打开菜单回到营地' : '按 R 回到营地');
      },
    };

    const handleSummit = async () => {
      if (summitHandledRef.current) return;
      summitHandledRef.current = true;
      const world = worldRef.current;
      const player = playerRef.current;
      if (!world || !player) return;
      const timeMs = timeMsRef.current;
      setPhaseBoth('summit');
      expectUnlockRef.current = true;
      input?.exitLock();
      audio?.summit();
      const summitTop = world.summitPos.clone().add(new THREE.Vector3(0, 2, 0));
      world.burstConfetti(summitTop);
      let bursts = 0;
      confettiTimer = window.setInterval(() => {
        world.burstConfetti(summitTop);
        if (++bursts >= 3) window.clearInterval(confettiTimer);
      }, 850);
      const room = sessionRef.current.room;
      room?.sendEvent({ t: 'summit', id: room.id, timeMs: Math.round(timeMs) });
      const players = 1 + (room && !hostLeftRef.current ? room.getPeerCount() : 0);
      // persistence: record + stats + unlock check (design.md §11.6/§11.7)
      const prevBest = bestMs;
      let unlocks: string[] = [];
      let bestAfter: number | null = prevBest;
      try {
        // compute post-summit stats locally (recordRun's save races getProfile)
        const prev = await getProfile().catch(() => null);
        const stats = prev
          ? { ...prev.stats }
          : { summits: 1, attempts: 1, bestTimeMs: Math.round(timeMs), maxAltitudeM: world.heightM, totalClimbM: world.heightM };
        stats.attempts += 1;
        stats.summits += 1;
        if (stats.bestTimeMs == null || timeMs < stats.bestTimeMs) stats.bestTimeMs = Math.round(timeMs);
        stats.maxAltitudeM = Math.max(stats.maxAltitudeM, Math.round(Math.max(maxAltRef.current, world.heightM)));
        await sessionRef.current.recordRun({
          seed: seedRef.current,
          date: new Date().toISOString(),
          timeMs: Math.round(timeMs),
          summited: true,
          peakAltitude: Math.round(Math.max(maxAltRef.current, world.heightM)),
          players,
        });
        bestAfter = stats.bestTimeMs;
        const earned: string[] = [];
        if (stats.summits >= 1) earned.push('bandana');
        if (stats.summits >= 3) earned.push('goggles');
        if (stats.summits >= 5) earned.push('carabiner');
        if (stats.bestTimeMs != null && stats.bestTimeMs < 8 * 60 * 1000) earned.push('champion');
        const owned = prev?.unlocked ?? [];
        unlocks = earned.filter((c) => !owned.includes(c));
        if (unlocks.length > 0) {
          await sessionRef.current.updateProfile({ unlocked: [...owned, ...unlocks] });
          toast('解锁新装扮！', 'success');
        }
      } catch {
        /* fail-soft */
      }
      if (cancelled) return;
      setVictory({
        timeMs,
        isRecord: prevBest == null || timeMs < prevBest,
        bestMs: bestAfter,
        altitude: world.heightM,
        checkpoints: player.checkpointIndex,
        falls: player.falls,
        players,
        unlocks,
        teammates: [],
        canRestart: modeRef.current !== 'join' || hostLeftRef.current,
      });
      refreshTeam();
    };

    const buildWorld = async (seed: number) => {
      seedRef.current = seed;
      summitHandledRef.current = false;
      startedRef.current = false;
      timeMsRef.current = 0;
      maxAltRef.current = 0;
      milestoneRef.current = 0;
      summitedRef.current.clear();
      cpByIdRef.current.clear();
      setVictory(null);
      setPausedBoth(false);
      setPhaseBoth('boot');
      setWiping(false);
      setLoading({ label: '正在生成山峰…', frac: 0 });
      const bestPromise = sessionRef.current.bestForSeed(seed).catch(() => null);
      // teardown previous world
      if (worldRef.current && engine) {
        engine.scene.remove(worldRef.current.group);
        worldRef.current.dispose();
        worldRef.current = null;
        playerRef.current = null;
      }
      const world = await generateWorld(seed, qualityRef.current, (p) => {
        if (!cancelled) setLoading(p);
      });
      if (cancelled) {
        world.dispose();
        return;
      }
      engine?.scene.add(world.group);
      worldRef.current = world;
      const player = new Player(world, playerEvents);
      player.spawnAt(0);
      player.yaw = player.yawTowardRoute(0);
      playerRef.current = player;
      setCheckpoints(world.ledges.map((l) => ({ index: l.index, frac: l.topY / world.heightM, name: l.name })));
      const best = await bestPromise;
      if (!cancelled) setBestMs(best?.timeMs ?? null);
      setLoading({ label: modeRef.current === 'solo' ? '完成！' : '等待队友…', frac: 0.97 });
      await delay(modeRef.current === 'solo' ? 250 : 650);
      if (cancelled) return;
      setLoading({ label: '完成！', frac: 1 });
      setWiping(true); // iris-wipe reveal → loadingDone
      // safety: if transitionend never fires, still open the ready gate
      later(750, () => {
        if (phaseRef.current === 'boot') setPhaseBoth('ready');
      });
      refreshTeam();
    };
    buildWorldRef.current = buildWorld;

    const handleNetEvent = (msg: NetMessage, from: PlayerId) => {
      switch (msg.t) {
        case 'start': {
          if (modeRef.current !== 'join') return;
          const seed = Number(msg.seed) >>> 0;
          toast('房主开启了新的山峰', 'info');
          void buildWorld(seed);
          break;
        }
        case 'emote': {
          remotes?.showEmote(String(msg.id ?? from), msg.e as EmoteKind);
          break;
        }
        case 'checkpoint': {
          const id = String(msg.id ?? from);
          const cp = Number(msg.cp ?? 0);
          cpByIdRef.current.set(id, cp);
          const L = worldRef.current?.ledges[cp];
          toast(`${nameOf(id)} 到达了 ${L?.name ?? `营地 ${cp}`}`, 'info');
          refreshTeam();
          break;
        }
        case 'summit': {
          const id = String(msg.id ?? from);
          summitedRef.current.add(id);
          toast(`${nameOf(id)} 登顶了！`, 'success');
          refreshTeam();
          setVictory((v) => (v ? { ...v } : v)); // re-render footnote
          break;
        }
        case 'respawn':
          break;
        default:
          break;
      }
    };

    /* ------------------------------- boot ------------------------------- */
    const boot = async () => {
      const s = await getSettings().catch(() => null);
      if (cancelled) return;
      if (s) {
        settingsRef.current = s;
        setSettings(s);
      }
      const quality = resolveQuality(s?.quality ?? 'auto', isMobile);
      qualityRef.current = quality;
      try {
        engine = new Engine(canvas, {
          quality,
          isMobile,
          onContextLost: () => setContextLost(true),
        });
      } catch {
        setContextLost(true);
        return;
      }
      engineRef.current = engine;
      engine.camera.position.set(0, 12, 60);
      input = new InputManager(canvas, isMobile);
      input.attach();
      inputRef.current = input;
      input.onPauseRequest = doPause;
      input.onLockChange = (locked) => {
        if (!locked && phaseRef.current === 'playing' && !pausedRef.current) {
          if (expectUnlockRef.current) {
            expectUnlockRef.current = false;
            return;
          }
          doPause();
        }
      };
      input.onFirstInteract = () => audio?.resume();
      remotes = new RemoteManager(engine.scene);
      remotesRef.current = remotes;
      audio = new GameAudio(s?.volume ?? 0.8);
      audioRef.current = audio;

      // multiplayer wiring
      const room = sessionRef.current.room;
      if (room) {
        rosterRef.current = room.getPlayers();
        room.on({
          onRoster: (players) => {
            rosterRef.current = players;
            remotes?.syncRoster(players, room.id);
            refreshTeam();
          },
          onState: (st) => remotes?.pushState(st),
          onEvent: (msg, from) => handleNetEvent(msg, from),
          onPeerJoined: (p) => {
            gonePeerRef.current.delete(p.id);
            lostPeerRef.current.delete(p.id);
            toast(`${p.name} 加入了登山队`, 'success');
            refreshTeam();
          },
          onPeerLeft: (id) => {
            toast(`${nameOf(id)} 离开了登山队`, 'info');
            remotes?.removePlayer(id);
            altByIdRef.current.delete(id);
            cpByIdRef.current.delete(id);
            gonePeerRef.current.delete(id);
            lostPeerRef.current.delete(id);
            refreshTeam();
          },
          onHostLeft: () => {
            hostLeftRef.current = true;
            setHostLeft(true);
            setHostLeftBanner(true);
            later(5000, () => setHostLeftBanner(false));
            refreshTeam();
          },
          onPingUpdate: (id, ms) => {
            pingByIdRef.current.set(id, ms);
          },
        });
        remotes.syncRoster(room.getPlayers(), room.id);
      }

      await buildWorld(seedRef.current);

      /* ------------------------------ game loop ------------------------------ */
      lastT = performance.now();
      const loop = (t: number) => {
        raf = requestAnimationFrame(loop);
        if (!engine) return;
        if (document.hidden) {
          lastT = t;
          return;
        }
        const dtRaw = Math.min(0.1, Math.max(0, (t - lastT) / 1000));
        lastT = t;
        const world = worldRef.current;
        const player = playerRef.current;
        const solo = modeRef.current === 'solo' || hostLeftRef.current;
        const simRunning = phaseRef.current === 'playing' && !(pausedRef.current && solo);
        const dt = simRunning ? dtRaw : 0;
        simTimeRef.current += dt;
        const now = simTimeRef.current;

        if (world && player && input) {
          // look (mouse/touch via sensitivity; gyro 1:1)
          const s = settingsRef.current;
          input.consumeLook(lookTmp);
          const sens = 0.0022 * (s?.sensitivity ?? 1);
          player.yaw -= lookTmp.dx * sens;
          player.pitch -= lookTmp.dy * sens * (s?.invertY ? -1 : 1);
          input.consumeGyro(gyroTmp);
          player.yaw += gyroTmp.dx;
          player.pitch += gyroTmp.dy;
          player.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, player.pitch));

          input.frame(frameInput); // consume edges every rAF
          if (simRunning) {
            if (input.consumeRespawn()) player.respawn(false);
            acc += dt;
            const step = 1 / 120;
            let n = 0;
            while (acc >= step && n < 8) {
              player.update(step, frameInput, now);
              acc -= step;
              n++;
            }
            if (n >= 8) acc = 0;
            if (startedRef.current && !summitHandledRef.current) {
              timeMsRef.current += dt * 1000;
            }
            // altitude milestones (§11.6 crash-safe stats, throttled 5s)
            if (player.pos.y > maxAltRef.current) maxAltRef.current = player.pos.y;
            const crossed = Math.floor(maxAltRef.current / 25);
            if (crossed > milestoneRef.current) {
              milestoneRef.current = crossed;
              if (t - lastStatsSaveRef.current > 5000) {
                lastStatsSaveRef.current = t;
                const alt = Math.round(maxAltRef.current);
                void getProfile()
                  .then((p) => {
                    if (alt > p.stats.maxAltitudeM) {
                      p.stats.maxAltitudeM = alt;
                      return saveProfile(p);
                    }
                    return undefined;
                  })
                  .catch(() => undefined);
              }
            }
            // 15Hz state broadcast
            const room = sessionRef.current.room;
            if (room && !hostLeftRef.current && t - lastSend > 66) {
              lastSend = t;
              room.sendState({
                p: [player.pos.x, player.pos.y, player.pos.z],
                ry: player.yaw,
                pitch: player.pitch,
                f: player.flags,
                s: Math.round(player.stamina),
              });
            }
            engine.setAltitudeMood(player.pos.y / world.heightM);
            audio?.setAltitude(player.pos.y / world.heightM);
          } else {
            input.consumeRespawn();
          }
          player.getEye(camPos);
          engine.camera.position.copy(camPos);
          engine.camera.rotation.y = player.yaw;
          engine.camera.rotation.x = player.pitch;
          fovKickRef.current = Math.max(0, fovKickRef.current - dtRaw * 14);
          const speed = player.horizontalSpeed;
          const targetFov = 75 + Math.min(3, Math.max(0, (speed - 3.6) * 1.5)) + fovKickRef.current;
          const fov = engine.camera.fov + (targetFov - engine.camera.fov) * Math.min(1, dtRaw * 8);
          if (Math.abs(fov - engine.camera.fov) > 0.01) {
            engine.camera.fov = fov;
            engine.camera.updateProjectionMatrix();
          }

          world.update(dtRaw, t / 1000);
          remotes?.update(dtRaw, engine.camera);

          // hud ref writes
          const h = hudRef.current;
          h.stamina = player.stamina;
          h.hanging = player.state === 'hang';
          h.exhausted = player.exhausted;
          h.canGrab = player.canGrab;
          h.altitude = player.pos.y;
          h.timeMs = timeMsRef.current;
          h.falls = player.falls;
          remotes?.forEach((id, alt) => altByIdRef.current.set(id, alt));

          if (t - lastUiTick > 500) {
            lastUiTick = t;
            refreshTeam();
            setShowPlayers(input.tabHeld);
          }
        }
        engine.render();
      };
      raf = requestAnimationFrame(loop);
    };

    void boot();

    const onVisibility = () => {
      if (document.hidden && (modeRef.current === 'solo' || hostLeftRef.current) && phaseRef.current === 'playing') {
        doPause();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      if (confettiTimer) window.clearInterval(confettiTimer);
      timersRef.current.forEach((id) => window.clearTimeout(id));
      timersRef.current = [];
      document.removeEventListener('visibilitychange', onVisibility);
      if (prevViewport != null) meta?.setAttribute('content', prevViewport);
      // record unfinished run (fire-and-forget)
      if (playedRef.current && !summitHandledRef.current) {
        void sessionRef.current
          .recordRun({
            seed: seedRef.current,
            date: new Date().toISOString(),
            timeMs: null,
            summited: false,
            peakAltitude: Math.round(maxAltRef.current),
            players: 1,
          })
          .catch(() => undefined);
      }
      input?.dispose();
      remotes?.dispose();
      worldRef.current?.dispose();
      worldRef.current = null;
      playerRef.current = null;
      audio?.dispose();
      engine?.dispose();
      engineRef.current = null;
      inputRef.current = null;
      remotesRef.current = null;
      audioRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* --------------------------------- actions --------------------------------- */

  const doStart = () => {
    const input = inputRef.current;
    input?.requestLock();
    audioRef.current?.resume();
    const s = settingsRef.current;
    if (isMobileRef.current && s?.gyroEnabled && input && !input.gyroEnabled) {
      void input.enableGyro().then((ok) => setGyroOn(ok));
    }
    startedRef.current = true;
    playedRef.current = true;
    setPhaseBoth('playing');
  };

  const doPauseAction = () => {
    if (phaseRef.current !== 'playing') return;
    pausedRef.current = true;
    setPaused(true);
    if (modeRef.current !== 'solo' && !hostLeftRef.current && !hintShownRef.current) {
      hintShownRef.current = true;
      setMultiplayerHint(true);
      toast('联机模式下世界不会暂停', 'info');
    }
  };

  const doResumeAction = () => {
    pausedRef.current = false;
    setPaused(false);
    inputRef.current?.requestLock();
  };

  const doRespawnAction = () => {
    playerRef.current?.respawn(false);
    doResumeAction();
  };

  const recordUnfinished = () => {
    if (!playedRef.current || summitHandledRef.current) return;
    playedRef.current = false;
    void sessionRef.current
      .recordRun({
        seed: seedRef.current,
        date: new Date().toISOString(),
        timeMs: null,
        summited: false,
        peakAltitude: Math.round(maxAltRef.current),
        players: 1,
      })
      .catch(() => undefined);
  };

  const doLeave = () => {
    recordUnfinished();
    sessionRef.current.reset();
    navigate('/lobby');
  };

  const doBackToLobby = () => {
    sessionRef.current.reset();
    navigate('/lobby');
  };

  const doAgain = () => {
    const canRestart = modeRef.current !== 'join' || hostLeftRef.current;
    if (!canRestart) return;
    const seed = newWorldSeed();
    const room = sessionRef.current.room;
    if (modeRef.current === 'host' && !hostLeftRef.current) room?.startGame(seed);
    void buildWorldRef.current(seed);
  };

  const doEmote = (kind: EmoteKind) => {
    const room = sessionRef.current.room;
    if (room && !hostLeftRef.current) room.sendEmote(kind);
    setSelfEmote({ kind, at: Date.now() });
    later(2100, () => setSelfEmote((v) => (v && v.kind === kind ? null : v)));
  };

  const doGyroToggle = async () => {
    const input = inputRef.current;
    if (!input) return;
    if (gyroOn) {
      input.disableGyro();
      setGyroOn(false);
      applySettings({ gyroEnabled: false });
      return;
    }
    const ok = await input.enableGyro();
    if (ok) {
      setGyroOn(true);
      applySettings({ gyroEnabled: true });
      toast('陀螺仪已开启', 'success');
    } else {
      toast('陀螺仪权限被拒绝，已保持触屏视角', 'danger');
    }
  };

  const applySettings = (patch: Partial<Settings>) => {
    const cur = settingsRef.current;
    if (!cur) return;
    const next = { ...cur, ...patch };
    settingsRef.current = next;
    setSettings(next);
    void saveSettings(next).catch(() => undefined);
    if (patch.volume !== undefined) audioRef.current?.setVolume(patch.volume);
    if (patch.quality !== undefined) {
      const q = resolveQuality(patch.quality, isMobileRef.current);
      qualityRef.current = q;
      engineRef.current?.setQuality(q);
    }
    if (patch.gyroEnabled !== undefined && isMobileRef.current) {
      const input = inputRef.current;
      if (patch.gyroEnabled && !gyroOn) void doGyroToggle();
      else if (!patch.gyroEnabled && gyroOn) {
        input?.disableGyro();
        setGyroOn(false);
      }
    }
  };

  const doMakeInvite = async () => {
    const room = sessionRef.current.room;
    if (!room || modeRef.current !== 'host') return;
    setInvite({ offer: '', busy: true, error: null });
    try {
      const offer = await room.createHostOffer();
      setInvite({ offer, busy: false, error: null });
    } catch (e) {
      setInvite({ offer: '', busy: false, error: e instanceof Error ? e.message : '生成失败' });
    }
  };

  const doAcceptAnswer = async (code: string) => {
    const room = sessionRef.current.room;
    if (!room || modeRef.current !== 'host') return;
    setInvite((v) => (v ? { ...v, busy: true, error: null } : v));
    try {
      await room.hostAcceptAnswer(code);
      setInvite((v) => (v ? { ...v, busy: false } : v));
    } catch (e) {
      setInvite((v) => (v ? { ...v, busy: false, error: e instanceof Error ? e.message : '连接失败，请重试' } : v));
    }
  };

  const doLoadingDone = () => {
    if (phaseRef.current === 'boot') setPhaseBoth('ready');
  };

  const actions: HudActions = {
    start: doStart,
    resume: doResumeAction,
    pause: doPauseAction,
    respawn: doRespawnAction,
    leave: doLeave,
    again: doAgain,
    backToLobby: doBackToLobby,
    emote: doEmote,
    gyroToggle: () => void doGyroToggle(),
    settingsChange: applySettings,
    makeInvite: () => void doMakeInvite(),
    acceptAnswer: (code) => void doAcceptAnswer(code),
    loadingDone: doLoadingDone,
  };

  const solo = modeRef.current === 'solo' || hostLeft;
  const multiplayer = modeRef.current !== 'solo';
  const victoryWithTeam = victory ? { ...victory, teammates: team } : null;

  return (
    <div className="fixed inset-0 z-[60] overflow-hidden bg-ink">
      <canvas
        ref={canvasRef}
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          touchAction: 'none',
          display: 'block',
        }}
      />
      <GameHud
        hud={hudRef as RefObject<HudData>}
        input={inputRef.current}
        isMobile={isMobile}
        phase={phase}
        loading={loading}
        wiping={wiping}
        seed={seedRef.current}
        bestMs={bestMs}
        paused={paused}
        solo={solo}
        isHost={modeRef.current === 'host' && !hostLeft}
        multiplayer={multiplayer}
        respawnName={respawnName}
        team={team}
        myPing={myPing}
        prompts={prompts}
        checkpoints={checkpoints}
        heightM={MOUNTAIN_H}
        victory={victoryWithTeam}
        settings={settings ?? defaultSettings()}
        gyroOn={gyroOn}
        contextLost={contextLost}
        showPlayers={showPlayers}
        invite={invite}
        selfEmote={selfEmote}
        multiplayerHint={multiplayerHint}
        hostLeftBanner={hostLeftBanner}
        actions={actions}
      />
    </div>
  );
}
