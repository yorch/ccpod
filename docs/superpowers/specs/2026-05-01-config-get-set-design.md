# ccpod config get/set — Design Spec

**Date:** 2026-05-01
**Status:** Approved

## Summary

Add `ccpod config get <key>` and `ccpod config set <key> <value>` subcommands to the existing `ccpod config` namespace for managing global ccpod settings (`~/.ccpod/config.yml`).

## Commands

### `ccpod config get <key>`

Print the current value of a global config key to stdout (raw, no decoration — scriptable).

```
$ ccpod config get autoCheckUpdates
true
```

- Exits 1 with error message if key is unknown.

### `ccpod config set <key> <value>`

Write a new value for a global config key and print confirmation.

```
$ ccpod config set autoCheckUpdates false
autoCheckUpdates = false
```

- Validates key is known; exits 1 with error listing known keys if not.
- Coerces string value to the correct type (e.g., `"true"`/`"1"` → `true` for booleans).
- Exits 1 with error if value cannot be coerced to the expected type.

### Error examples

```
$ ccpod config get foo
error: unknown config key 'foo'. Known keys: autoCheckUpdates

$ ccpod config set autoCheckUpdates notabool
error: invalid value for 'autoCheckUpdates': expected boolean (true/false)
```

## Architecture

### New files

| File | Purpose |
|------|---------|
| `src/cli/commands/config/get.ts` | `ccpod config get` command |
| `src/cli/commands/config/set.ts` | `ccpod config set` command |

### Updated files

| File | Change |
|------|--------|
| `src/cli/commands/config/index.ts` | Add `get` and `set` subcommands |

### No changes to `src/global/config.ts`

`loadGlobalConfig` and `saveGlobalConfig` already exist and are sufficient. The command files consume them directly.

### Known-keys + coercion

A `KNOWN_KEYS` map in `set.ts` maps each key to a coercion function:

```ts
const KNOWN_KEYS = {
  autoCheckUpdates: (v: string) => {
    if (v === 'true' || v === '1') return true;
    if (v === 'false' || v === '0') return false;
    throw new Error('expected boolean (true/false)');
  },
} satisfies Record<keyof GlobalConfig, (v: string) => unknown>;
```

`satisfies Record<keyof GlobalConfig, ...>` ensures the map stays in sync with `GlobalConfig` at compile time — adding a new field to `GlobalConfigSchema` produces a type error until the map is updated.

`get.ts` uses `Object.keys(KNOWN_KEYS)` to validate the key, then reads from the loaded config.

## Error handling

| Scenario | Exit code | Output |
|----------|-----------|--------|
| Unknown key | 1 | `error: unknown config key '<key>'. Known keys: <list>` |
| Invalid value type | 1 | `error: invalid value for '<key>': <coercion message>` |
| Happy path | 0 | Value (get) or `key = value` (set) |

## Testing

Two new test files using `CCPOD_TEST_DIR` for isolation (consistent with existing test patterns):

- `tests/unit/cli/config/get.test.ts` — happy path, unknown key
- `tests/unit/cli/config/set.test.ts` — happy path, unknown key, invalid value, file written correctly

## Scope

Only global config (`~/.ccpod/config.yml`). Does not touch profile or project config — those are managed via `ccpod profile update` and `.ccpod.yml` directly.
