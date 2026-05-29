import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AGENT_KINDS,
  CronActivity,
  KIND_THEMES,
  Signal,
  SignalKind,
  SignalPriority,
  WindowBounds,
  isSignal,
} from './types';
import { Mascot, MascotMode } from './Mascot';

// Transparent walking video of the Nous Research Hermes-chan mascot,
// generated with Google Veo and chroma-keyed to a VP9-alpha WebM. All agents
// share the same character; the per-kind glow color differentiates them.
const HERMES_WALK = './hermes-walk.webm';
const HERMES_IDLE = './hermes-idle.png';
const VIDEO_FOR_KIND: Record<SignalKind, string> = {
  'x-radar': HERMES_WALK,
  'ai-radar': HERMES_WALK,
  wiki: HERMES_WALK,
  system: HERMES_WALK,
  generic: HERMES_WALK,
};
const IDLE_FOR_KIND: Record<SignalKind, string> = {
  'x-radar': HERMES_IDLE,
  'ai-radar': HERMES_IDLE,
  wiki: HERMES_IDLE,
  system: HERMES_IDLE,
  generic: HERMES_IDLE,
};

// Width of the mascot in px. Hermes walk video is cropped to 560×720,
// so visual height is MASCOT_SIZE * (720/560).
const MASCOT_SIZE = 172;
const MASCOT_ASPECT = 720 / 560;
// Fallback px from window bottom when Electron cannot report the Dock inset.
const MASCOT_BASELINE_FALLBACK = 24;
// Electron's work-area inset reaches to the top edge of the Dock. The mascot
// should sit on the visible bar surface, which is lower than that edge.
const DOCK_SURFACE_DROP_PX = 176;
const MASCOT_HALF = MASCOT_SIZE / 2;
const STRIP_PADDING = 80;

const WALK_TICK_MIN_MS = 7000;
const WALK_TICK_MAX_MS = 16000;

const PRIORITY_LABEL: Record<SignalPriority, string> = {
  high: 'Güçlü sinyal',
  medium: 'Fırsat',
  low: 'SAKİN',
};

interface AgentState {
  kind: SignalKind;
  x: number;
  facing: 1 | -1;
  mode: MascotMode;
  // Duration of the current left-slide, computed from distance so travel speed
  // stays constant regardless of how far the agent strolls.
  moveDurationMs: number;
}

// Stroll speed in px/sec, tuned so the walk video's leg cadence roughly
// matches ground travel (≈ a natural 1.3 m/s walk at this mascot scale).
// Too slow looks like moonwalking; too fast looks like skating.
const STROLL_SPEED_PX_S = 95;
const MIN_WALK_TRAVEL_PX = 80;
const MIN_AUTONOMOUS_TRAVEL_PX = 180;

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const diff = Date.now() - d.getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'şimdi';
    if (mins < 60) return `${mins} dk önce`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} sa önce`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days} gün önce`;
    return d.toLocaleDateString();
  } catch {
    return '';
  }
}

function shortenSignalText(text: string, max = 96): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= max) return compact;
  return compact.slice(0, max - 1).trimEnd() + '…';
}

function firstSignalText(signal: Signal, keys: Array<keyof Signal>): string | null {
  for (const key of keys) {
    const value = signal[key];
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }
  return null;
}

function bubbleLine(signal: Signal): string {
  if (signal.id.startsWith('fallback')) {
    return shortenSignalText(firstSignalText(signal, ['bubble', 'summary', 'title']) ?? '');
  }
  return shortenSignalText(
    firstSignalText(signal, ['bubble', 'summary', 'title', 'detail', 'rawExcerpt']) ?? '',
  );
}

function missingSignalTitle(kind: SignalKind): string {
  const label = KIND_THEMES[kind]?.label ?? KIND_THEMES.generic.label;
  return `${label} sinyali yüklenemedi`;
}

function missingSignalSummary(kind: SignalKind, activity: CronActivity | null | undefined): string {
  const byKindKey = `byKind[${kind}]`;
  const when = activity ? formatTimestamp(activity.timestamp) : '';
  return when
    ? `data/current-signal.json içindeki ${byKindKey} kaydı bekleniyor. Son cron kontrolü ${when}.`
    : `data/current-signal.json içindeki ${byKindKey} kaydı bekleniyor.`;
}

type SignalsByKind = Partial<Record<SignalKind, Signal | null>>;
type ActivityByKind = Partial<Record<SignalKind, CronActivity | null>>;
interface SignalBundle {
  byKind: SignalsByKind;
  primaryKind: SignalKind;
  activityByKind: ActivityByKind;
  latestActivity: CronActivity | null;
}

function isCronActivity(value: unknown): value is CronActivity {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.jobName === 'string' &&
    typeof v.source === 'string' &&
    typeof v.sourcePath === 'string' &&
    typeof v.kind === 'string' &&
    typeof v.timestamp === 'string'
  );
}

function activityLine(kind: SignalKind, activity: CronActivity | null | undefined): string {
  return missingSignalSummary(kind, activity);
}

function quietBubbleLine(kind: SignalKind, activity: CronActivity | null | undefined): string {
  return shortenSignalText(missingSignalSummary(kind, activity));
}

// Parse either the schema-2 per-kind bundle or a legacy single signal.
function parseBundle(data: unknown): SignalBundle | null {
  const d = data as Record<string, unknown>;
  if (d && typeof d === 'object' && d.byKind && typeof d.byKind === 'object') {
    const src = d.byKind as Record<string, unknown>;
    const activitySrc =
      d.activityByKind && typeof d.activityByKind === 'object'
        ? (d.activityByKind as Record<string, unknown>)
        : {};
    const byKind: SignalsByKind = {};
    const activityByKind: ActivityByKind = {};
    for (const k of AGENT_KINDS) {
      byKind[k] = isSignal(src[k]) ? (src[k] as Signal) : null;
      activityByKind[k] = isCronActivity(activitySrc[k])
        ? (activitySrc[k] as CronActivity)
        : null;
    }
    const latestActivity = isCronActivity(d.latestActivity) ? d.latestActivity : null;
    const pk = d.primaryKind as SignalKind;
    const primaryKind = AGENT_KINDS.includes(pk)
      ? pk
      : (AGENT_KINDS.find((k) => byKind[k]) ?? 'x-radar');
    return { byKind, primaryKind, activityByKind, latestActivity };
  }
  if (isSignal(data)) {
    const k = AGENT_KINDS.includes(data.kind) ? data.kind : 'x-radar';
    return { byKind: { [k]: data }, primaryKind: k, activityByKind: {}, latestActivity: null };
  }
  return null;
}

async function fetchSignalBundle(): Promise<SignalBundle> {
  if (window.tinyHermes?.getSignal) {
    try {
      const b = parseBundle(await window.tinyHermes.getSignal());
      if (b) return b;
    } catch {
      /* fall through */
    }
  }
  for (const path of ['./data/current-signal.json', './data/sample-signal.json']) {
    try {
      const res = await fetch(path);
      if (res.ok) {
        const b = parseBundle(await res.json());
        if (b) return b;
      }
    } catch {
      /* keep trying */
    }
  }
  return { byKind: {}, primaryKind: 'x-radar', activityByKind: {}, latestActivity: null };
}

function isNightTime(): boolean {
  const hour = new Date().getHours();
  return hour >= 23 || hour < 7;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export default function App() {
  // One signal per kind (each mascot is its own cron-derived agent).
  const [signalsByKind, setSignalsByKind] = useState<SignalsByKind>({});
  const [activityByKind, setActivityByKind] = useState<ActivityByKind>({});
  const [bounds, setBounds] = useState<WindowBounds | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentState[]>([]);
  const [night, setNight] = useState(isNightTime());
  const [bubbleX, setBubbleX] = useState<number | null>(null);
  const [panelAnchorX, setPanelAnchorX] = useState<number | null>(null);
  // The kind to foreground by default (highest-priority signal's mascot).
  const [signalKind, setSignalKind] = useState<SignalKind>('x-radar');
  // The mascot the user clicked (focused → enlarged + foregrounded). When set
  // it overrides the signal agent as "active". null = follow the signal.
  const [focusedKind, setFocusedKind] = useState<SignalKind | null>(null);
  const agentsRef = useRef<AgentState[]>([]);
  const bubbleFrameRef = useRef<number | null>(null);

  // Which agent the cursor is hovering. A ref (not state) so the walk loop
  // reads the latest value without re-subscribing. While an agent is hovered
  // it stops walking and stands still — makes it easy to click, and reads as
  // "she noticed you and stopped".
  const hoveredKindRef = useRef<SignalKind | null>(null);
  // While an agent is mid-walk (click- or timer-triggered), the random stroll
  // loop must not touch it — otherwise it can flip the agent to idle mid-slide,
  // pausing the legs while the body keeps gliding ("float"). Records the
  // wall-clock time each agent's current walk is expected to finish.
  const commandedUntilRef = useRef<Record<string, number>>({});
  // Per-agent reset-to-idle timers, so a new walk can cancel a stale one.
  const walkResetTimers = useRef<Record<string, number>>({});

  useEffect(() => {
    agentsRef.current = agents;
  }, [agents]);

  const stopBubbleFollow = useCallback(() => {
    if (bubbleFrameRef.current != null) {
      window.cancelAnimationFrame(bubbleFrameRef.current);
      bubbleFrameRef.current = null;
    }
  }, []);

  const startBubbleFollow = useCallback(
    (fromX: number, toX: number, durationMs: number) => {
      stopBubbleFollow();
      setBubbleX(fromX);
      const startedAt = performance.now();

      const step = (now: number) => {
        const t = clamp((now - startedAt) / durationMs, 0, 1);
        setBubbleX(fromX + (toX - fromX) * t);
        if (t < 1) {
          bubbleFrameRef.current = window.requestAnimationFrame(step);
        } else {
          bubbleFrameRef.current = null;
          setBubbleX(toX);
        }
      };

      bubbleFrameRef.current = window.requestAnimationFrame(step);
    },
    [stopBubbleFollow],
  );

  useEffect(() => stopBubbleFollow, [stopBubbleFollow]);

  /* ----- bounds + initial signal ----- */
  useEffect(() => {
    let alive = true;
    if (window.tinyHermes?.getBounds) {
      window.tinyHermes.getBounds().then((b) => {
        if (alive) setBounds(b);
      });
    } else {
      setBounds({
        stripWidth: window.innerWidth,
        stripHeight: window.innerHeight,
        workAreaHeight: window.innerHeight,
        dockHeight: 0,
      });
    }
    fetchSignalBundle()
      .then((b) => {
        if (alive) {
          setSignalsByKind(b.byKind);
          setActivityByKind(b.activityByKind);
          setSignalKind(b.primaryKind);
        }
      })
      .catch(() => {
        if (alive) setError('signal yüklenemedi');
      });
    return () => {
      alive = false;
    };
  }, []);

  /* ----- initialise agent slots once we know the strip width ----- */
  useEffect(() => {
    if (!bounds || agents.length > 0) return;
    const usableWidth = bounds.stripWidth - STRIP_PADDING * 2;
    const slotWidth = usableWidth / AGENT_KINDS.length;
    const next: AgentState[] = AGENT_KINDS.map((kind, i) => ({
      kind,
      x: STRIP_PADDING + slotWidth * (i + 0.5),
      // All face their native right-facing orientation at start.
      facing: 1,
      mode: 'idle',
      moveDurationMs: 400,
    }));
    setAgents(next);
  }, [bounds, agents.length]);

  // The "active" (enlarged, foregrounded) mascot is whichever the user last
  // clicked; with no click it's the primary (highest-priority) signal's agent.
  const activeKind: SignalKind = focusedKind ?? signalKind;
  // Each agent shows its OWN signal. `signal` = the active agent's own signal
  // (or null → placeholder). All bubble/panel rendering reads this, so it
  // automatically reflects whichever mascot is focused.
  const signal: Signal | null = signalsByKind[activeKind] ?? null;
  // The focused agent has a real signal of its own (vs. a placeholder).
  const isSignalAgent = signal != null;

  const activeAgent = useMemo(
    () => agents.find((a) => a.kind === activeKind) ?? agents[0] ?? null,
    [agents, activeKind],
  );

  useEffect(() => {
    if (!activeAgent) {
      setBubbleX(null);
      return;
    }
    if (bubbleFrameRef.current != null) return;
    if (activeAgent.mode !== 'walking' && activeAgent.mode !== 'running') {
      stopBubbleFollow();
      setBubbleX(activeAgent.x);
    }
  }, [activeAgent?.kind, activeAgent?.mode, activeAgent?.x, stopBubbleFollow]);

  /* ----- night-mode hourly poll ----- */
  useEffect(() => {
    const id = window.setInterval(() => setNight(isNightTime()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  /* ----- random walk scheduler per agent ----- */
  useEffect(() => {
    if (!bounds || agents.length === 0) return;
    let cancelled = false;

    const tick = (agentIndex: number) => {
      if (cancelled) return;
      const scheduleNext = () => {
        const delay =
          WALK_TICK_MIN_MS + Math.random() * (WALK_TICK_MAX_MS - WALK_TICK_MIN_MS);
        window.setTimeout(() => tick(agentIndex), delay);
      };
      const agent = agentsRef.current[agentIndex];
      if (!agent) {
        scheduleNext();
        return;
      }
      // Don't disturb an agent that's mid-walk (click- or timer-commanded) —
      // overriding it now would stop the legs while the slide continues.
      if (Date.now() < (commandedUntilRef.current[agent.kind] ?? 0)) {
        scheduleNext();
        return;
      }
      // Freeze agents that are hovered or currently open — they must not
      // drift, or they'd be hard to click and the anchored panel would
      // jitter as the agent slides under it.
      const frozen =
        hoveredKindRef.current === agent.kind || (expanded && agent.kind === activeKind);
      if (frozen) {
        if (agent.mode !== 'idle') {
          setAgents((prev) =>
            prev.map((a) => (a.kind === agent.kind ? { ...a, mode: 'idle' } : a)),
          );
        }
        scheduleNext();
        return;
      }

      const usableWidth = bounds.stripWidth - STRIP_PADDING * 2;
      const minX = STRIP_PADDING + MASCOT_HALF;
      const maxX = bounds.stripWidth - STRIP_PADDING - MASCOT_HALF;

      let nextX = agent.x;
      let nextMode: MascotMode = 'idle';

      if (night) {
        // At night she mostly stands and dozes.
        nextMode = 'sleepy';
      } else if (Math.random() < 0.4) {
        // Occasional stroll to a clearly different spot. Tiny drifts make
        // the shoes animate while the body barely translates, which reads as
        // walking in place, especially for dim background agents.
        const travel =
          MIN_AUTONOMOUS_TRAVEL_PX + Math.random() * Math.min(usableWidth * 0.22, 280);
        const direction = Math.random() < 0.5 ? -1 : 1;
        const primary = clamp(agent.x + direction * travel, minX, maxX);
        const fallback = clamp(agent.x - direction * travel, minX, maxX);
        nextX =
          Math.abs(primary - agent.x) >= MIN_AUTONOMOUS_TRAVEL_PX ? primary : fallback;
        if (Math.abs(nextX - agent.x) >= MIN_AUTONOMOUS_TRAVEL_PX) {
          nextMode = 'walking';
        } else {
          nextX = agent.x;
        }
      }

      const dist = Math.abs(nextX - agent.x);
      const moveDurationMs =
        nextMode === 'walking'
          ? clamp((dist / STROLL_SPEED_PX_S) * 1000, 700, 6000)
          : 400;
      // Face travel direction. The video's native stride reads as the
      // OPPOSITE of scaleX(1), so rightward travel flips (-1) and leftward
      // is native (1) — keeps gaze and travel aligned.
      const nextFacing: 1 | -1 = dist > 1 ? (nextX > agent.x ? -1 : 1) : agent.facing;

      setAgents((prev) =>
        prev.map((a) =>
          a.kind === agent.kind
            ? {
                ...a,
                x: nextX,
                facing: nextFacing,
                mode: nextMode,
                moveDurationMs,
              }
            : a,
        ),
      );

      // After the stroll finishes, drop back to idle. Lock the agent for the
      // whole slide so the next tick can't interrupt it.
      if (nextMode === 'walking') {
        const kind = agent.kind;
        if (kind === activeKind && !expanded && !dismissed) {
          startBubbleFollow(agent.x, nextX, moveDurationMs);
        }
        commandedUntilRef.current[kind] = Date.now() + moveDurationMs;
        const prevReset = walkResetTimers.current[kind];
        if (prevReset) window.clearTimeout(prevReset);
        walkResetTimers.current[kind] = window.setTimeout(() => {
          if (cancelled) return;
          // If a newer walk command is still in flight, let IT own the reset —
          // otherwise this stale timer pauses the legs mid-slide (float).
          if (Date.now() < (commandedUntilRef.current[kind] ?? 0) - 100) return;
          setAgents((p) => {
            const cur = p[agentIndex];
            if (!cur || cur.kind !== kind || cur.mode !== nextMode) return p;
            const u = [...p];
            u[agentIndex] = { ...cur, mode: 'idle' };
            return u;
          });
        }, moveDurationMs + 120);
      }

      scheduleNext();
    };

    const timers = AGENT_KINDS.map((_, i) =>
      window.setTimeout(() => tick(i), 800 + Math.random() * 1500),
    );

    return () => {
      cancelled = true;
      for (const t of timers) window.clearTimeout(t);
    };
  }, [
    bounds,
    agents.length,
    activeKind,
    dismissed,
    expanded,
    night,
    signal?.priority,
    startBubbleFollow,
  ]);

  /* ----- thinking state during refresh ----- */
  useEffect(() => {
    if (!refreshing) return;
    setAgents((prev) =>
      prev.map((a) => (a.kind === activeKind ? { ...a, mode: 'thinking' } : a)),
    );
  }, [refreshing, activeKind]);

  /* ----- actions ----- */
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      let bundle: SignalBundle | null = null;
      if (window.tinyHermes?.refreshSignal) {
        bundle = parseBundle(await window.tinyHermes.refreshSignal());
      } else {
        bundle = await fetchSignalBundle();
      }
      if (bundle) {
        setSignalsByKind(bundle.byKind);
        setActivityByKind(bundle.activityByKind);
        setSignalKind(bundle.primaryKind);
        setDismissed(false);
      } else {
        setError('signal şekli geçersiz');
      }
    } catch {
      setError('refresh başarısız');
    } finally {
      setRefreshing(false);
    }
  }, []);

  const handleOpenSource = useCallback(async () => {
    if (!signal?.url) return;
    if (window.tinyHermes?.openExternal) {
      await window.tinyHermes.openExternal(signal.url);
    } else {
      window.open(signal.url, '_blank', 'noopener,noreferrer');
    }
  }, [signal]);

  const handleQuit = useCallback(async () => {
    if (window.tinyHermes?.quit) {
      await window.tinyHermes.quit();
    }
  }, []);

  const closePanel = useCallback(() => {
    setExpanded(false);
    setPanelAnchorX(null);
  }, []);

  // Clicking a mascot makes her immediately walk to a new spot — a
  // deterministic trigger so the walk animation can be tested on demand
  // instead of waiting for the random stroll timer.
  const handleAgentWalk = useCallback(
    (kind: SignalKind, visualX?: number) => {
      if (!bounds) return;
      const agent = agentsRef.current.find((a) => a.kind === kind);
      if (!agent) return;
      const minX = STRIP_PADDING + MASCOT_HALF;
      const maxX = bounds.stripWidth - STRIP_PADDING - MASCOT_HALF;
      const startX = clamp(visualX ?? agent.x, minX, maxX);
      // Head toward whichever side has more room, a clearly visible
      // distance so the stride reads well.
      const goRight = startX < bounds.stripWidth / 2;
      const want = Math.min((bounds.stripWidth - STRIP_PADDING * 2) * 0.42, 440);
      let target = clamp(startX + (goRight ? want : -want), minX, maxX);
      if (Math.abs(target - startX) < MIN_WALK_TRAVEL_PX) {
        target = clamp(startX + (goRight ? -want : want), minX, maxX);
      }
      const dist = Math.abs(target - startX);
      if (dist < MIN_WALK_TRAVEL_PX) return;
      const dur = clamp((dist / STROLL_SPEED_PX_S) * 1000, 800, 7000);
      // The clicked mascot becomes the active (enlarged, foregrounded) one.
      setFocusedKind(kind);
      setExpanded(false);
      setDismissed(false);
      setPanelAnchorX(null);
      startBubbleFollow(startX, target, dur);
      // Release any hover hold so the stroll loop doesn't re-freeze her.
      hoveredKindRef.current = null;
      setAgents((prev) =>
        prev.map((a) => {
          if (a.kind !== kind) return a;
          // Inverted flip: rightward travel uses scaleX(-1), leftward native.
          return {
            ...a,
            x: startX,
            facing: goRight ? -1 : 1,
            mode: 'idle',
            moveDurationMs: 0,
          };
        }),
      );
      window.requestAnimationFrame(() => {
        setAgents((prev) =>
          prev.map((a) =>
            a.kind === kind
              ? {
                  ...a,
                  x: target,
                  facing: goRight ? -1 : 1,
                  mode: 'walking',
                  moveDurationMs: dur,
                }
              : a,
          ),
        );
      });
      // Lock the agent for the whole slide (+ the reset window) so the random
      // stroll loop can't flip it to idle mid-walk (which would freeze the legs
      // while it keeps sliding).
      commandedUntilRef.current[kind] = Date.now() + dur + 200;
      const prev = walkResetTimers.current[kind];
      if (prev) window.clearTimeout(prev);
      walkResetTimers.current[kind] = window.setTimeout(() => {
        // Skip if a newer walk command is still in flight (prevents a stale
        // reset from pausing the legs mid-slide → float).
        if (Date.now() < (commandedUntilRef.current[kind] ?? 0) - 100) return;
        setAgents((p) =>
          p.map((a) => (a.kind === kind && a.mode === 'walking' ? { ...a, mode: 'idle' } : a)),
        );
      }, dur + 120);
    },
    [bounds, startBubbleFollow],
  );

  // The speech bubble opens the signal panel (click the mascot now walks).
  const handleOpenPanel = useCallback(
    (kind: SignalKind, visualX?: number) => {
      const minX = STRIP_PADDING + MASCOT_HALF;
      const width = bounds?.stripWidth ?? window.innerWidth;
      const maxX = width - STRIP_PADDING - MASCOT_HALF;
      const agent = agentsRef.current.find((a) => a.kind === kind);
      const anchorX = clamp(visualX ?? bubbleX ?? agent?.x ?? width / 2, minX, maxX);

      stopBubbleFollow();
      setBubbleX(anchorX);
      setPanelAnchorX(anchorX);
      setFocusedKind(kind);
      setExpanded(true);
      setDismissed(false);
      hoveredKindRef.current = null;
      commandedUntilRef.current[kind] = Date.now() + 300;
      const prev = walkResetTimers.current[kind];
      if (prev) window.clearTimeout(prev);
      setAgents((prevAgents) =>
        prevAgents.map((a) =>
          a.kind === kind ? { ...a, x: anchorX, mode: 'idle', moveDurationMs: 0 } : a,
        ),
      );
    },
    [bounds?.stripWidth, bubbleX, stopBubbleFollow],
  );

  /* ----- derived ----- */
  const activeActivity = activityByKind[activeKind] ?? null;

  const bubbleText = useMemo(
    () =>
      signal
        ? bubbleLine(signal)
        : quietBubbleLine(activeKind, activeActivity),
    [signal, activeKind, activeActivity],
  );
  const priority: SignalPriority = signal?.priority ?? 'low';
  const showBubble = !dismissed && !expanded && activeAgent;
  const theme = KIND_THEMES[activeKind] ?? KIND_THEMES.generic;

  const stripWidth = bounds?.stripWidth ?? window.innerWidth;
  const dockTopInset = bounds?.bottomDockInset ?? 0;
  const baseline =
    dockTopInset > 0
      ? Math.max(0, Math.round(dockTopInset - DOCK_SURFACE_DROP_PX))
      : MASCOT_BASELINE_FALLBACK;
  // The image is 2:3 portrait so the mascot's visual height is ~1.5× width.
  const mascotVisualHeight = Math.round(MASCOT_SIZE * MASCOT_ASPECT);
  const panelWidth = 400;
  const bubbleWidth = 320;
  const overheadGap = mascotVisualHeight + 16;
  const bubbleHeadX = bubbleX ?? activeAgent?.x ?? stripWidth / 2;
  const bubbleLeft = clamp(bubbleHeadX, bubbleWidth / 2 + 12, stripWidth - bubbleWidth / 2 - 12);
  const bubbleTailLeft = clamp(bubbleHeadX - bubbleLeft + bubbleWidth / 2, 24, bubbleWidth - 24);
  const rawBubbleBottom = baseline + mascotVisualHeight + 14;
  const bubbleHeightEstimate = 76;
  const maxBubbleBottom = Math.max(12, (bounds?.stripHeight ?? window.innerHeight) - bubbleHeightEstimate - 8);
  const bubbleBottom = clamp(rawBubbleBottom, 12, maxBubbleBottom);
  const panelBottom = baseline + overheadGap;
  const panelMaxHeight = Math.max(
    190,
    (bounds?.stripHeight ?? window.innerHeight) - panelBottom - 12,
  );
  const panelExcerptMaxHeight = clamp(panelMaxHeight - 228, 56, 120);

  // The panel (shown only when expanded, while the agent is frozen) anchors
  // above the active agent but clamps inside the viewport.
  const panelAnchor = panelAnchorX ?? activeAgent?.x ?? null;
  const panelLeft = panelAnchor != null
    ? clamp(panelAnchor - panelWidth / 2, 12, stripWidth - panelWidth - 12)
    : stripWidth / 2 - panelWidth / 2;

  return (
    <div
      className={[
        'stage',
        `stage--priority-${priority}`,
        `stage--kind-${activeKind}`,
        expanded ? 'stage--expanded' : '',
        night ? 'stage--night' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={
        {
          '--strip-width': `${stripWidth}px`,
        } as React.CSSProperties
      }
    >
      {/* the imaginary dock surface line — purely visual reference for the
          mascot to "stand" on; kept invisible to avoid drawing over the Dock. */}
      <div className="dock-floor" aria-hidden="true" style={{ bottom: baseline - 6 }} />

      {agents.map((agent) => {
        const isActive = agent.kind === activeKind;
        const themeForAgent = KIND_THEMES[agent.kind];
        return (
          <div
            key={agent.kind}
            className={[
              'agent-slot',
              isActive ? 'agent-slot--active' : 'agent-slot--bg',
              `agent-slot--mode-${agent.mode}`,
              `agent-slot--kind-${agent.kind}`,
            ].join(' ')}
            style={{
              left: agent.x,
              bottom: baseline,
              // Constant-speed slide: duration scales with travel distance.
              transitionDuration: `${agent.moveDurationMs}ms`,
            }}
          >
            <button
              type="button"
              className="agent-slot__button"
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                handleAgentWalk(agent.kind, rect.left + rect.width / 2);
              }}
              onMouseEnter={(e) => {
                if (Date.now() < (commandedUntilRef.current[agent.kind] ?? 0)) return;
                hoveredKindRef.current = agent.kind;
                // Snap to the agent's *current visual* x and kill the slide so
                // an in-flight CSS transition can't glide her out from under
                // the cursor. rect center ≈ agent.x because the stage spans the
                // full window from x=0.
                const rect = e.currentTarget.getBoundingClientRect();
                const cx = rect.left + rect.width / 2;
                setAgents((prev) =>
                  prev.map((a) =>
                    a.kind === agent.kind
                      ? { ...a, mode: 'idle', x: cx, moveDurationMs: 0 }
                      : a,
                  ),
                );
              }}
              onMouseLeave={() => {
                if (hoveredKindRef.current === agent.kind) hoveredKindRef.current = null;
              }}
              aria-label={`${themeForAgent.label} agent`}
              tabIndex={0}
            >
              <Mascot
                videoSrc={VIDEO_FOR_KIND[agent.kind]}
                idleSrc={IDLE_FOR_KIND[agent.kind]}
                kind={agent.kind}
                mode={agent.mode}
                facing={agent.facing}
                active={isActive}
                size={isActive ? MASCOT_SIZE : MASCOT_SIZE * 0.62}
              />
            </button>

          </div>
        );
      })}

      {showBubble && (
        <div
          className="bubble bubble--anchored bubble--clickable"
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            handleOpenPanel(activeKind, bubbleHeadX);
          }}
          style={{
            left: bubbleLeft,
            width: bubbleWidth,
            transform: 'translateX(-50%)',
            bottom: bubbleBottom,
          }}
        >
          <span
            className="bubble__tag"
            style={{ color: theme.accent, borderColor: theme.glowSoft }}
          >
            {theme.label}
          </span>
          <span className="bubble__text">{bubbleText}</span>
          <button
            className="bubble__close"
            type="button"
            aria-label="Balonu kapat"
            title="Kapat"
            onClick={(e) => {
              e.stopPropagation();
              setDismissed(true);
            }}
          >
            ×
          </button>
          <span className="bubble__tail" style={{ left: bubbleTailLeft }} />
        </div>
      )}

      {expanded && activeAgent && (
        <div
          className="panel"
          role="dialog"
          aria-label="hermes signal"
          style={{
            left: panelLeft,
            width: panelWidth,
            bottom: panelBottom,
            maxHeight: panelMaxHeight,
            '--panel-excerpt-max-height': `${panelExcerptMaxHeight}px`,
          } as React.CSSProperties}
        >
          <header className="panel__header">
            <div className="panel__heading">
              <span
                className={`panel__kind panel__kind--${activeKind}`}
                style={{ color: theme.accent, borderColor: theme.glowSoft }}
              >
                {theme.label}
              </span>
              {isSignalAgent && signal ? (
                <span className={`panel__priority panel__priority--${priority}`}>
                  {PRIORITY_LABEL[priority]}
                </span>
              ) : (
                <span className="panel__priority panel__priority--low">SAKİN</span>
              )}
            </div>
            <button
              className="panel__close"
              type="button"
              aria-label="Close"
              onClick={closePanel}
            >
              ×
            </button>
          </header>

          {isSignalAgent && signal ? (
            <>
              <h1 className="panel__title">{signal.title}</h1>
              <p className="panel__summary">{signal.summary}</p>
              <dl className="panel__meta">
                <div className="panel__meta-row">
                  <dt>Kaynak</dt>
                  <dd>{signal.source || '—'}</dd>
                </div>
                {signal.sourcePath && (
                  <div className="panel__meta-row">
                    <dt>Yol</dt>
                    <dd className="panel__mono">{signal.sourcePath}</dd>
                  </div>
                )}
                <div className="panel__meta-row">
                  <dt>Zaman</dt>
                  <dd>{formatTimestamp(signal.timestamp)}</dd>
                </div>
              </dl>
              {signal.rawExcerpt && (
                <pre className="panel__excerpt">
                  {signal.rawExcerpt.length > 600
                    ? signal.rawExcerpt.slice(0, 600) + '…'
                    : signal.rawExcerpt}
                </pre>
              )}
            </>
          ) : (
            <>
              <h1 className="panel__title">{missingSignalTitle(activeKind)}</h1>
              <p className="panel__summary">{activityLine(activeKind, activeActivity)}</p>
            </>
          )}

          {error && <div className="panel__error">{error}</div>}

          <footer className="panel__actions">
            <button
              className="btn btn--ghost"
              type="button"
              onClick={handleRefresh}
              disabled={refreshing}
            >
              {refreshing ? 'Yenileniyor…' : 'Yenile'}
            </button>
            {isSignalAgent && signal?.url && (
              <button className="btn btn--accent" type="button" onClick={handleOpenSource}>
                Kaynağı Aç
              </button>
            )}
            <button className="btn btn--ghost btn--quit" type="button" onClick={handleQuit}>
              Kapat
            </button>
          </footer>
          <span
            className="panel__tail"
            style={{
              left: clamp((panelAnchor ?? activeAgent.x ?? 0) - panelLeft, 24, panelWidth - 24),
            }}
          />
        </div>
      )}
    </div>
  );
}
