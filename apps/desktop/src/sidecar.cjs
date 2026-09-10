// @ts-check
'use strict';

/**
 * Sidecar management, shell-agnostic on purpose: the collector IS the product
 * (proxy + store + API in one process); Electron is only a window. A future
 * Tauri swap replaces main.cjs and nothing else.
 *
 * Two modes:
 *  - packaged: spawn the compiled collector (built with `bun build --compile`
 *    for the target platform) from resources — the installed app needs neither
 *    the repo nor a bun install.
 *  - dev: spawn bun against the workspace source.
 */
const { spawn } = require('node:child_process');
const path = require('node:path');

/**
 * @param {{ command: string, args?: string[], cwd?: string, env?: Record<string, string> }} opts
 * @returns {{ child: import('node:child_process').ChildProcess, stop: () => void }}
 */
function startSidecar(opts) {
  const child = spawn(opts.command, opts.args ?? [], {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    // No console window flashing up behind the GUI on Windows.
    windowsHide: true,
  });
  child.stdout?.on('data', (d) => process.stdout.write(`[sidecar] ${d}`));
  child.stderr?.on('data', (d) => process.stderr.write(`[sidecar] ${d}`));
  return {
    child,
    stop() {
      if (!child.killed) child.kill('SIGTERM');
    },
  };
}

/**
 * Sidecar spawn plan for the current mode.
 * @param {{ packaged: boolean, resourcesPath: string, repoRoot: string, userDataDir: string }} opts
 * @returns {{ command: string, args: string[], cwd: string | undefined, env: Record<string, string> }}
 */
function sidecarPlan(opts) {
  if (opts.packaged) {
    const exe = process.platform === 'win32' ? 'saga-collector.exe' : 'saga-collector';
    return {
      command: path.join(opts.resourcesPath, exe),
      args: [],
      cwd: opts.userDataDir,
      env: {
        SAGA_UI_DIR: path.join(opts.resourcesPath, 'ui'),
        SAGA_DB: path.join(opts.userDataDir, 'saga.db'),
      },
    };
  }
  return {
    command: process.platform === 'win32' ? 'bun.exe' : 'bun',
    args: [path.join(opts.repoRoot, 'apps', 'collector', 'src', 'main.ts')],
    cwd: opts.repoRoot,
    env: {
      SAGA_UI_DIR: path.join(opts.repoRoot, 'apps', 'web', 'dist'),
    },
  };
}

/**
 * Poll until the collector answers /api/health (or time out).
 * @param {string} baseUrl
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
async function waitForHealth(baseUrl, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

module.exports = { startSidecar, sidecarPlan, waitForHealth };
