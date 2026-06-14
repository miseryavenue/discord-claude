// Maps Claude Code hook events to the Discord activity payload.
import * as path from 'path';
import type { Config, Session } from './common';
import type { Activity } from './ipc';

/** "claude-fable-5" -> "Fable 5", "claude-opus-4-8" -> "Opus 4.8". */
export function prettyModel(id: string | undefined): string {
  if (!id) return '';
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(String(id));
  if (!m || !m[1] || !m[2]) return String(id);
  const name = m[1].charAt(0).toUpperCase() + m[1].slice(1);
  const minor = m[3] && m[3].length <= 2 ? `.${m[3]}` : '';
  return `${name} ${m[2]}${minor}`;
}

function baseName(p: unknown): string {
  try {
    return path.basename(String(p));
  } catch {
    return '';
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function describeToolUse(
  toolName: string | undefined,
  toolInput: Record<string, unknown> | undefined,
  cfg: Config
): string {
  const tool = String(toolName ?? '');
  const input = toolInput ?? {};

  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) {
    const file = input.file_path ?? input.notebook_path;
    return cfg.showFileNames && file ? `Editing ${baseName(file)}` : 'Editing files';
  }
  if (tool === 'Read') {
    return cfg.showFileNames && input.file_path ? `Reading ${baseName(input.file_path)}` : 'Reading files';
  }
  if (/^Bash/.test(tool)) {
    return cfg.showToolDetail && typeof input.description === 'string' && input.description
      ? truncate(`Running: ${input.description}`, 90)
      : 'Running commands';
  }
  if (/^(Grep|Glob|Explore)$/.test(tool)) return 'Searching the codebase';
  if (/^(WebFetch|WebSearch)$/.test(tool)) return 'Browsing the web';
  if (/^(Task|Agent|SendMessage)$/.test(tool)) return 'Running subagents';
  if (/^(TodoWrite|TaskCreate|TaskUpdate|EnterPlanMode|ExitPlanMode|Plan)$/.test(tool)) return 'Planning';
  if (tool === 'Skill') {
    return cfg.showToolDetail && typeof input.skill === 'string' && input.skill
      ? truncate(`Using /${input.skill}`, 90)
      : 'Running a skill';
  }
  if (tool === 'AskUserQuestion') return 'Asking a question';
  const mcp = /^mcp__(.+?)__/.exec(tool);
  if (mcp && mcp[1]) return truncate(`Using ${mcp[1].replace(/[_-]+/g, ' ')}`, 90);
  return 'Working';
}

/** Discord requires details/state to be 2-128 chars. */
function clamp(s: string): string {
  const out = s.slice(0, 128);
  return out.length < 2 ? out.padEnd(2) : out;
}

export function buildActivity(
  session: Session,
  cfg: Config,
  idle: boolean,
  typeSupported: boolean
): Activity {
  const details =
    cfg.showProjectName && session.project ? `In ${session.project}` : 'In a project';
  const state = idle ? 'Idle' : session.statusText || 'Working';

  const activity: Activity = {
    instance: true,
    details: clamp(details),
    state: clamp(state),
    timestamps: { start: session.startedAt },
  };
  if (typeSupported && Number.isInteger(cfg.activityType)) activity.type = cfg.activityType;

  const assets: NonNullable<Activity['assets']> = {};
  if (cfg.largeImage) {
    assets.large_image = cfg.largeImage;
    assets.large_text = clamp(
      (cfg.largeText || 'Claude Code') + (session.model ? ` · ${session.model}` : '')
    );
  }
  const small = idle ? cfg.smallImageIdle : cfg.smallImageWorking;
  if (small) {
    assets.small_image = small;
    assets.small_text = idle ? 'Idle' : 'Working';
  }
  if (assets.large_image || assets.small_image) activity.assets = assets;

  if (Array.isArray(cfg.buttons)) {
    const buttons = cfg.buttons
      .filter((b) => b && b.label && b.url)
      .slice(0, 2)
      .map((b) => ({ label: truncate(b.label, 32), url: String(b.url).slice(0, 512) }));
    if (buttons.length) activity.buttons = buttons;
  }
  return activity;
}
