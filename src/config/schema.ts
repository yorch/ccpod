import { z } from "zod";

const portsConfigSchema = z
  .object({
    autoDetectMcp: z.boolean().default(true),
    list: z.array(z.string()).default([]),
  })
  .default({ autoDetectMcp: true, list: [] });

const serviceConfigSchema = z.object({
  env: z.record(z.string(), z.string()).optional(),
  image: z.string(),
  ports: z.array(z.string()).optional(),
  volumes: z.array(z.string()).optional(),
});

export const profileConfigSchema = z.object({
  auth: z
    .object({
      keyEnv: z.string().default("ANTHROPIC_API_KEY"),
      keyFile: z.string().optional(),
      type: z.enum(["api-key", "oauth"]).default("api-key"),
    })
    .default({ keyEnv: "ANTHROPIC_API_KEY", type: "api-key" }),
  config: z.object({
    path: z.string().optional(),
    ref: z.string().optional(),
    repo: z.string().optional(),
    source: z.enum(["local", "git"]),
    sync: z.enum(["always", "daily", "pin"]).default("daily"),
  }),
  description: z.string().optional(),
  env: z.array(z.string()).default([]),
  image: z
    .object({
      dockerfile: z.string().optional(),
      use: z.string().default("ghcr.io/yorch/ccpod:latest"),
    })
    .default({ use: "ghcr.io/yorch/ccpod:latest" }),
  name: z
    .string()
    .regex(
      /^[a-zA-Z0-9_-]{1,64}$/,
      "Profile name may only contain letters, digits, hyphens, and underscores (max 64 chars)",
    ),
  network: z
    .object({
      allow: z.array(z.string()).default([]),
      policy: z.enum(["full", "restricted"]).default("full"),
    })
    .default({ allow: [], policy: "full" }),
  plugins: z.array(z.string()).default([]),
  ports: portsConfigSchema,
  services: z.record(z.string(), serviceConfigSchema).default({}),
  ssh: z
    .object({
      agentForward: z.boolean().default(true),
      mountSshDir: z.boolean().default(false),
    })
    .default({ agentForward: true, mountSshDir: false }),
  state: z.enum(["ephemeral", "persistent"]).default("ephemeral"),
});

export const projectConfigSchema = z.object({
  config: z
    .object({
      claudeMd: z.enum(["append", "override"]).default("append"),
    })
    .optional(),
  env: z.array(z.string()).optional(),
  merge: z.enum(["deep", "override"]).default("deep"),
  network: z
    .object({
      allow: z.array(z.string()).optional(),
      policy: z.enum(["full", "restricted"]).optional(),
    })
    .optional(),
  ports: z
    .object({
      autoDetectMcp: z.boolean().optional(),
      list: z.array(z.string()).optional(),
    })
    .optional(),
  profile: z
    .string()
    .regex(
      /^[a-zA-Z0-9_-]{1,64}$/,
      "Profile name may only contain letters, digits, hyphens, and underscores (max 64 chars)",
    )
    .optional(),
  services: z.record(z.string(), serviceConfigSchema).optional(),
});

export type ProfileConfigInput = z.input<typeof profileConfigSchema>;
export type ProjectConfigInput = z.input<typeof projectConfigSchema>;
