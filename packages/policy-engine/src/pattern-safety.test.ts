import { describe, expect, test } from "bun:test";
import { isReDoSUnsafe, loadPolicyBundles } from "./index";

describe("policy pattern safety analyzer", () => {
  test("admits valid fixture-style patterns", () => {
    expect(isReDoSUnsafe("\\bgit\\s+reset\\s+--hard\\b")).toBe(false);
    expect(isReDoSUnsafe("^src/.+\\.ts$")).toBe(false);
  });

  test("rejects nested unbounded quantifiers", () => {
    expect(isReDoSUnsafe("(a+)+$")).toBe(true);
    expect(isReDoSUnsafe("(.*)*")).toBe(true);
  });

  test("rejects adjacent overlapping unbounded quantifiers", () => {
    expect(isReDoSUnsafe("a+a+")).toBe(true);
    expect(isReDoSUnsafe(".+a+")).toBe(true);
  });

  test("rejects unbounded alternation under a quantifier", () => {
    expect(isReDoSUnsafe("(a|aa)+$")).toBe(true);
    expect(isReDoSUnsafe("(a+|b)+$")).toBe(true);
  });

  test("classifies malformed pattern syntax as unsafe_pattern at load", () => {
    const result = loadPolicyBundles({
      id: "fixture.malformed-pattern",
      rules: [
        {
          id: "workspace.malformed_pattern",
          layer: "workspace",
          effect: "deny",
          reason: "malformed regex pattern",
          match: {
            args: [
              {
                path: "command",
                pattern: "("
              }
            ]
          }
        }
      ]
    });

    expect(result).toEqual({
      ok: false,
      failures: [
        {
          code: "unsafe_pattern",
          reason: "Pattern is not valid regular expression syntax",
          bundleId: "fixture.malformed-pattern",
          ruleId: "workspace.malformed_pattern",
          path: "bundles.0.rules.0.match.args.0.pattern"
        }
      ]
    });
  });
});
