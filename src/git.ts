// Thin git shell wrapper used by remote `--repo` resolution.
//
// Stdlib only — no runtime deps. We use execFile to avoid shell-quoting
// surprises and to surface stderr in error messages.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = (() => {
  const env = process.env["AGENT_SETUP_GIT_TIMEOUT_MS"];
  if (env !== undefined) {
    const n = Number(env);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 60_000;
})();

export type CloneOptions = {
  timeoutMs?: number;
};

export async function isGitOnPath(): Promise<boolean> {
  try {
    await execFileAsync("git", ["--version"], { timeout: DEFAULT_TIMEOUT_MS });
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return false;
    // If git is on PATH but failed for any other reason, treat as available
    // (we'd rather fail later with a more specific clone error than report
    // "git not found" misleadingly).
    return false;
  }
}

export async function shallowClone(
  url: string,
  dest: string,
  opts: CloneOptions = {},
): Promise<void> {
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    await execFileAsync(
      "git",
      ["clone", "--depth=1", "--single-branch", url, dest],
      { timeout },
    );
  } catch (e) {
    const err = e as NodeJS.ErrnoException & {
      stderr?: string | Buffer;
      stdout?: string | Buffer;
    };
    const stderr =
      typeof err.stderr === "string"
        ? err.stderr
        : err.stderr !== undefined
          ? err.stderr.toString("utf8")
          : "";
    const trimmed = stderr.trim();
    const reason = trimmed.length > 0 ? trimmed : err.message;
    throw new Error(`git clone failed for ${url}: ${reason}`);
  }
}
