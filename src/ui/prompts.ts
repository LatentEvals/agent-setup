// Thin typed wrappers over `@clack/prompts`.
//
// Every prompt returns a discriminated union:
//   { cancelled: false; ... }  — user submitted a value
//   { cancelled: true }         — user pressed Ctrl-C / ESC
//
// We never call `process.exit` from here; the caller decides what to do
// on cancel (typically: print outro + return exit code 130).

import {
  cancel,
  confirm,
  isCancel,
  multiselect,
  select,
} from "@clack/prompts";

import type { Scope } from "../types.js";

export type Cancelled = { cancelled: true };

export type AgentCandidate = { name: string; detected: boolean };

export type SkillEntry = { name: string; description: string };

export type McpEntry = { name: string; description: string };

function onCancel(): Cancelled {
  cancel("Operation cancelled.");
  return { cancelled: true };
}

export async function pickAgents(options: {
  candidates: AgentCandidate[];
}): Promise<{ cancelled: false; selected: string[] } | Cancelled> {
  if (options.candidates.length === 0) {
    return { cancelled: false, selected: [] };
  }
  const initial = options.candidates
    .filter((c) => c.detected)
    .map((c) => c.name);
  const result = await multiselect<string>({
    message: "Select agents to install into",
    options: options.candidates.map((c) => ({
      value: c.name,
      label: c.name,
      hint: c.detected ? "detected" : "not detected",
    })),
    initialValues: initial,
    required: false,
  });
  if (isCancel(result)) return onCancel();
  return { cancelled: false, selected: result as string[] };
}

export async function pickScope(): Promise<
  { cancelled: false; scope: Scope } | Cancelled
> {
  const result = await select<Scope>({
    message: "Install scope",
    options: [
      { value: "project", label: "project", hint: "writes to ./.<tool>" },
      { value: "global", label: "global", hint: "writes to $HOME/.<tool>" },
    ],
    initialValue: "project",
  });
  if (isCancel(result)) return onCancel();
  return { cancelled: false, scope: result as Scope };
}

export async function pickSkills(options: {
  skills: SkillEntry[];
}): Promise<
  { cancelled: false; selected: string[] } | Cancelled
> {
  if (options.skills.length === 0) {
    return { cancelled: false, selected: [] };
  }
  const all = options.skills.map((s) => s.name);
  const result = await multiselect<string>({
    message: "Select skills to install",
    options: options.skills.map((s) => ({
      value: s.name,
      label: s.name,
      hint: s.description,
    })),
    initialValues: all,
    required: false,
  });
  if (isCancel(result)) return onCancel();
  return { cancelled: false, selected: result as string[] };
}

export async function pickMcps(options: {
  mcps: McpEntry[];
}): Promise<
  { cancelled: false; selected: string[] } | Cancelled
> {
  if (options.mcps.length === 0) {
    return { cancelled: false, selected: [] };
  }
  const all = options.mcps.map((m) => m.name);
  const result = await multiselect<string>({
    message: "Select MCP servers to install",
    options: options.mcps.map((m) => ({
      value: m.name,
      label: m.name,
      hint: m.description,
    })),
    initialValues: all,
    required: false,
  });
  if (isCancel(result)) return onCancel();
  return { cancelled: false, selected: result as string[] };
}

export async function confirmProceed(): Promise<
  { cancelled: false; proceed: boolean } | Cancelled
> {
  const result = await confirm({
    message: "Proceed with installation?",
    initialValue: true,
  });
  if (isCancel(result)) return onCancel();
  return { cancelled: false, proceed: result as boolean };
}
