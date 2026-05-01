import { z } from "zod";

const portsConfigSchema = z
  .object({
    list: z.array(z.string()).default([]),
    autoDetectMcp: z.boolean().default(true),
  })
  .default({ list: [], autoDetectMcp: true });

const serviceConfigSchema = z.object({
  image: z.string(),
  env: z.record(z.string(), z.string()).optional(),
  volumes: z.array(z.string()).optional(),
  ports: z.array(z.string()).optional(),
});

export const profileConfigSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  config: z.object({
    source: z.enum(["local", "git"]),
    path: z.string().optional(),
    repo: z.string().optional(),
    sync: z.enum(["always", "daily", "pin"]).default("daily"),
    ref: z.string().optional(),
  }),
  image: z
    .object({
      use: z.string().default("ghcr.io/ccpod/base:latest"),
      dockerfile: z.string().optional(),
    })
    .default({ use: "ghcr.io/ccpod/base:latest" }),
  auth: z
    .object({
      type: z.enum(["api-key", "oauth"]).default("api-key"),
      keyEnv: z.string().default("ANTHROPIC_API_KEY"),
      keyFile: z.string().optional(),
    })
    .default({ type: "api-key", keyEnv: "ANTHROPIC_API_KEY" }),
  state: z.enum(["ephemeral", "persistent"]).default("ephemeral"),
  ssh: z
    .object({
      agentForward: z.boolean().default(true),
      mountSshDir: z.boolean().default(false),
    })
    .default({ agentForward: true, mountSshDir: false }),
  network: z
    .object({
      policy: z.enum(["full", "restricted"]).default("full"),
      allow: z.array(z.string()).default([]),
    })
    .default({ policy: "full", allow: [] }),
  ports: portsConfigSchema,
  services: z.record(z.string(), serviceConfigSchema).default({}),
  env: z.array(z.string()).default([]),
});

export const projectConfigSchema = z.object({
  profile: z.string().optional(),
  merge: z.enum(["deep", "override"]).default("deep"),
  config: z
    .object({
      claudeMd: z.enum(["append", "override"]).default("append"),
    })
    .optional(),
  network: z
    .object({
      policy: z.enum(["full", "restricted"]).optional(),
      allow: z.array(z.string()).optional(),
    })
    .optional(),
  ports: z
    .object({
      list: z.array(z.string()).optional(),
      autoDetectMcp: z.boolean().optional(),
    })
    .optional(),
  services: z.record(z.string(), serviceConfigSchema).optional(),
  env: z.array(z.string()).optional(),
});

export type ProfileConfigInput = z.input<typeof profileConfigSchema>;
export type ProjectConfigInput = z.input<typeof projectConfigSchema>;
