import { describe, it, expect } from "bun:test";
import { mergeClaudes } from "../../../src/config/merger.ts";

describe("mergeClaudes", () => {
  it("appends project content below profile content", () => {
    const result = mergeClaudes("# Profile\nDo X", "# Project\nDo Y", "append");
    expect(result).toContain("# Profile");
    expect(result).toContain("# Project");
    const profileIdx = result.indexOf("# Profile");
    const projectIdx = result.indexOf("# Project");
    expect(profileIdx).toBeLessThan(projectIdx);
  });

  it("overrides profile content with project content", () => {
    const result = mergeClaudes("# Profile\nDo X", "# Project\nDo Y", "override");
    expect(result).toBe("# Project\nDo Y");
    expect(result).not.toContain("# Profile");
  });
});
