import { z } from 'zod';
import { OFFICIAL_IMAGE } from '../constants.ts';

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

// Reject refs that could be interpreted as flags or contain shell/path
// traversal metacharacters. Git refs honor `--upload-pack=…` as an option,
// which is a documented RCE vector when refs are user-controlled.
const gitRefSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((s) => !s.startsWith('-'), {
    message: 'git ref must not start with "-"',
  })
  .refine((s) => !s.includes('..'), {
    message: 'git ref must not contain ".."',
  })
  .refine((s) => !/[\s;&|`$<>'"\\]/.test(s), {
    message: 'git ref must not contain whitespace or shell metacharacters',
  });

// Allow https://, http://, ssh://, git://, or scp-style `git@host:path`.
// Reject anything starting with `-` (would be parsed as a git flag).
const gitRepoSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine((s) => !s.startsWith('-'), {
    message: 'git repo URL must not start with "-"',
  })
  .refine(
    (s) =>
      /^https?:\/\//.test(s) ||
      /^ssh:\/\//.test(s) ||
      /^git:\/\//.test(s) ||
      /^[a-zA-Z0-9_.-]+@[a-zA-Z0-9.-]+:/.test(s),
    {
      message:
        'git repo URL must use https://, http://, ssh://, git://, or user@host:path form',
    },
  );

// Limit keyFile to paths under ~/.ccpod (typically ~/.ccpod/credentials/<profile>/...).
// Anything else risks shipping arbitrary host file contents into the container.
const keyFileSchema = z
  .string()
  .min(1)
  .refine(
    (s) =>
      (s.startsWith('~/.ccpod/') || s.startsWith('~/.ccpod')) &&
      !s.includes('..'),
    {
      message:
        'auth.keyFile must be a path under ~/.ccpod (e.g. ~/.ccpod/credentials/<profile>/key); use keyEnv for keys elsewhere',
    },
  );

export const profileConfigSchema = z.object({
  allowProjectHostMounts: z.boolean().default(false),
  allowProjectInit: z.boolean().default(false),
  auth: z
    .object({
      keyEnv: z.string().default('ANTHROPIC_API_KEY'),
      keyFile: keyFileSchema.optional(),
      type: z.enum(['api-key', 'oauth']).default('api-key'),
    })
    .default({ keyEnv: 'ANTHROPIC_API_KEY', type: 'api-key' }),
  claudeArgs: z.array(z.string()).default([]),
  config: z.object({
    path: z.string().optional(),
    ref: gitRefSchema.optional(),
    repo: gitRepoSchema.optional(),
    source: z.enum(['local', 'git']),
    sync: z.enum(['always', 'daily', 'pin']).default('daily'),
  }),
  description: z.string().optional(),
  env: z.array(z.string()).default([]),
  image: z
    .object({
      dockerfile: z.string().optional(),
      use: z.string().default(OFFICIAL_IMAGE),
    })
    .default({ use: OFFICIAL_IMAGE }),
  init: z
    .array(
      z.string().refine((s) => !s.includes('\n'), {
        message: 'init commands must be single-line strings',
      }),
    )
    .default([]),
  isolation: z.boolean().default(false),
  name: z
    .string()
    .regex(
      /^[a-zA-Z0-9_-]{1,64}$/,
      'Profile name may only contain letters, digits, hyphens, and underscores (max 64 chars)',
    ),
  network: z
    .object({
      allow: z.array(z.string()).default([]),
      policy: z.enum(['full', 'restricted']).default('full'),
    })
    .default({ allow: [], policy: 'full' }),
  permissions: z.enum(['conservative', 'moderate', 'permissive']).optional(),
  plugins: z.array(z.string()).default([]),
  ports: portsConfigSchema,
  services: z.record(z.string(), serviceConfigSchema).default({}),
  ssh: z
    .object({
      agentForward: z.boolean().default(true),
      mountSshDir: z.boolean().default(false),
    })
    .default({ agentForward: true, mountSshDir: false }),
  state: z.enum(['ephemeral', 'persistent']).default('ephemeral'),
});

export const projectConfigSchema = z.object({
  claudeArgs: z.array(z.string()).optional(),
  config: z
    .object({
      claudeMd: z.enum(['append', 'override']).default('append'),
    })
    .optional(),
  env: z.array(z.string()).optional(),
  init: z
    .array(
      z.string().refine((s) => !s.includes('\n'), {
        message: 'init commands must be single-line strings',
      }),
    )
    .optional(),
  merge: z.enum(['deep', 'override']).default('deep'),
  network: z
    .object({
      allow: z.array(z.string()).optional(),
      policy: z.enum(['full', 'restricted']).optional(),
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
      'Profile name may only contain letters, digits, hyphens, and underscores (max 64 chars)',
    )
    .optional(),
  services: z.record(z.string(), serviceConfigSchema).optional(),
});

export type ProfileConfigInput = z.input<typeof profileConfigSchema>;
export type ProjectConfigInput = z.input<typeof projectConfigSchema>;
