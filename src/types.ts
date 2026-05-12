// Shared cross-module types. Schema-derived types live in src/schema.ts.

import type { Skill, Server } from "./schema.js";

export type Scope = "project" | "global";

export type DesiredChange =
  | {
      kind: "json-entry";
      path: string;
      pointer: string;
      value: unknown;
      ownerKey: string;
    }
  | {
      kind: "toml-entry";
      path: string;
      pointer: string;
      value: unknown;
      ownerKey: string;
    }
  | {
      kind: "text-file";
      path: string;
      content: string;
      marker: string;
    }
  | {
      kind: "symlink";
      link: string;
      target: string;
    };

export type EmitInput = {
  servers: Server[];
  skills: Skill[];
  agentsMd: string | null;
  scope: Scope;
  root: string;
};

export type Emitter = {
  name: string;
  detect?(input: { root: string; scope: Scope }): Promise<{ installed: boolean }>;
  emit(input: EmitInput): DesiredChange[];
};
