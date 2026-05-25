// Auto-update check: periodically `git fetch` the repo this service is running
// from and compare HEAD against the tracked upstream branch. Results are kept
// in memory and surfaced via /health; the wa CLI uses them to show a banner and
// to drive `wa update`. The actual `git pull && npm install` runs from the
// caller (the wa CLI shells out locally), not from inside the server — running
// pull in-process while the service is live would race with node's module
// cache and surprise the user.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 6h between background checks. Keeps GitHub happy and is plenty for a tool
// that's updated maybe weekly.
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
// `git fetch` over a flaky network shouldn't hang the checker forever.
const FETCH_TIMEOUT_MS = 30000;

let state = {
  available: null,        // null = never checked successfully
  commitsBehind: 0,
  current: null,
  upstream: null,
  upstreamRef: null,      // e.g. "origin/master"
  lastCheckedAt: null,
  error: null,
  repoPath: repoRoot,
};

async function git(args, opts = {}) {
  const { stdout } = await execFileP('git', args, { cwd: repoRoot, ...opts });
  return stdout.trim();
}

// Prefer the branch's configured upstream (handles users on non-master). Fall
// back to origin/<current branch>; detached HEAD ends up at origin/HEAD which
// is the remote default branch — still a sensible reference.
async function detectUpstream() {
  try {
    return await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  } catch {
    try {
      const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
      return branch && branch !== 'HEAD' ? `origin/${branch}` : 'origin/HEAD';
    } catch {
      return 'origin/HEAD';
    }
  }
}

export async function checkForUpdates({ fetch = true } = {}) {
  try {
    if (fetch) {
      await execFileP('git', ['fetch', '--quiet', '--no-tags'], { cwd: repoRoot, timeout: FETCH_TIMEOUT_MS });
    }
    const upstreamRef = await detectUpstream();
    const current = await git(['rev-parse', 'HEAD']);
    const upstream = await git(['rev-parse', upstreamRef]);
    const behind = current === upstream ? 0 : Number(await git(['rev-list', '--count', `HEAD..${upstreamRef}`]));

    state = {
      available: behind > 0,
      commitsBehind: behind,
      current,
      upstream,
      upstreamRef,
      lastCheckedAt: Date.now(),
      error: null,
      repoPath: repoRoot,
    };
  } catch (e) {
    state = {
      ...state,
      lastCheckedAt: Date.now(),
      error: String(e.message ?? e).split('\n')[0].slice(0, 200),
      repoPath: repoRoot,
    };
  }
  return state;
}

export function getUpdateStatus() {
  return state;
}

// Commit list between HEAD and the upstream — used by `wa update` to show what
// you'd be pulling. \x1f (unit separator) keeps subjects with spaces intact.
export async function getPendingCommits({ limit = 20 } = {}) {
  if (!state.upstreamRef) return [];
  try {
    const out = await git([
      'log',
      `--max-count=${Math.max(1, Math.min(Number(limit) || 20, 200))}`,
      '--pretty=format:%H%x1f%s%x1f%an%x1f%aI',
      `HEAD..${state.upstreamRef}`,
    ]);
    if (!out) return [];
    return out.split('\n').map((line) => {
      const [hash, subject, author, date] = line.split('\x1f');
      return { hash, subject, author, date };
    });
  } catch {
    return [];
  }
}

export function startUpdateChecker() {
  checkForUpdates().then((s) => {
    if (s.available) {
      console.log(`  update:      ${s.commitsBehind} new commit(s) on ${s.upstreamRef} — run "wa update" to apply`);
    } else if (s.error) {
      console.log(`  update:      check failed (${s.error})`);
    } else if (s.available === false) {
      console.log(`  update:      up to date with ${s.upstreamRef}`);
    }
  }).catch(() => {});
  const t = setInterval(() => { checkForUpdates().catch(() => {}); }, CHECK_INTERVAL_MS);
  t.unref?.();
  return t;
}
