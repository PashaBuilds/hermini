export type SignalKind = 'x-radar' | 'ai-radar' | 'wiki' | 'system' | 'generic';
export type SignalPriority = 'low' | 'medium' | 'high';

export interface Signal {
  id: string;
  title: string;
  summary: string;
  bubble?: string;
  source: string;
  sourcePath: string;
  url: string | null;
  kind: SignalKind;
  priority: SignalPriority;
  timestamp: string;
  rawExcerpt: string;
  status?: string;
  detail?: string;
  recommendedAction?: string | null;
  sourceHandle?: string | null;
  score?: number | null;
  draft?: string | null;
}

export interface CronActivity {
  jobName: string;
  source: string;
  sourcePath: string;
  kind: SignalKind;
  timestamp: string;
}

export interface WindowBounds {
  stripWidth: number;
  stripHeight: number;
  workAreaHeight: number;
  dockHeight: number;
  bottomDockInset?: number;
}

export interface TinyHermesBridge {
  getSignal: () => Promise<Signal>;
  refreshSignal: () => Promise<Signal>;
  quit: () => Promise<void>;
  openExternal: (url: string) => Promise<boolean>;
  setInteractive: (interactive: boolean) => Promise<void>;
  getBounds: () => Promise<WindowBounds>;
}

export function isSignal(value: unknown): value is Signal {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.title === 'string' &&
    typeof v.summary === 'string' &&
    typeof v.source === 'string' &&
    typeof v.kind === 'string' &&
    typeof v.priority === 'string' &&
    typeof v.timestamp === 'string'
  );
}

export const FALLBACK_SIGNAL: Signal = {
  id: 'fallback-renderer',
  title: 'All quiet, Pasha',
  summary: 'No strong signal right now.',
  source: 'Tiny Hermes',
  sourcePath: '',
  url: null,
  kind: 'generic',
  priority: 'low',
  timestamp: new Date().toISOString(),
  rawExcerpt: '',
};

export const AGENT_KINDS: SignalKind[] = ['x-radar', 'ai-radar', 'wiki', 'system'];

// Visual identity per kind. Glow color drives the cyan/amber/etc tint behind
// the mascot. `tag` is the short label shown in bubbles/panels.
export const KIND_THEMES: Record<
  SignalKind,
  {
    label: string;
    glow: string;
    glowSoft: string;
    accent: string;
  }
> = {
  'x-radar': {
    label: 'X Radar',
    glow: 'rgba(255, 193, 100, 0.85)',
    glowSoft: 'rgba(255, 193, 100, 0.4)',
    accent: '#ffd486',
  },
  'ai-radar': {
    label: 'AI Radar',
    glow: 'rgba(78, 216, 255, 0.85)',
    glowSoft: 'rgba(78, 216, 255, 0.4)',
    accent: '#aef6ff',
  },
  wiki: {
    label: 'Pashapedia',
    glow: 'rgba(180, 160, 255, 0.85)',
    glowSoft: 'rgba(180, 160, 255, 0.4)',
    accent: '#cabbff',
  },
  system: {
    label: 'System',
    glow: 'rgba(255, 122, 162, 0.85)',
    glowSoft: 'rgba(255, 122, 162, 0.4)',
    accent: '#ffb6c1',
  },
  generic: {
    label: 'Hermes',
    glow: 'rgba(174, 246, 255, 0.7)',
    glowSoft: 'rgba(78, 216, 255, 0.35)',
    accent: '#aef6ff',
  },
};
