import { describe, expect, it } from "bun:test";
import {
  profileConfigSchema,
  projectConfigSchema,
} from "../../../src/config/schema.ts";

describe("profileConfigSchema", () => {
  it("parses minimal valid profile", () => {
    const result = profileConfigSchema.safeParse({
      name: "test",
      config: { source: "local", path: "/tmp/config" },
    });
    expect(result.success).toBe(true);
  });

  it("applies defaults", () => {
    const result = profileConfigSchema.parse({
      name: "test",
      config: { source: "local" },
    });
    expect(result.state).toBe("ephemeral");
    expect(result.ssh.agentForward).toBe(true);
    expect(result.network.policy).toBe("full");
    expect(result.ports.autoDetectMcp).toBe(true);
  });

  it("rejects unknown source", () => {
    const result = profileConfigSchema.safeParse({
      name: "test",
      config: { source: "ftp" },
    });
    expect(result.success).toBe(false);
  });
});

describe("projectConfigSchema", () => {
  it("parses empty project config", () => {
    const result = projectConfigSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("defaults merge to deep", () => {
    const result = projectConfigSchema.parse({});
    expect(result.merge).toBe("deep");
  });
});
