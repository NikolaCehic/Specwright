export const GATE_CONTRACT_VERSION = "1.0.0" as const;
export const GATE_ENGINE_EVALUATOR_VERSION = "1.0.0" as const;

export const VERDICT_SEMANTICS_VERSION_RULE =
  "Verdict-semantic changes must bump GATE_ENGINE_EVALUATOR_VERSION." as const;

export const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export type SemverString = `${number}.${number}.${number}`;

type SemverParts = {
  major: number;
  minor: number;
  patch: number;
};

export function isSemverString(value: string): value is SemverString {
  return SEMVER_PATTERN.test(value);
}

export function parseSemverString(value: string): SemverParts | undefined {
  const match = SEMVER_PATTERN.exec(value);

  if (match === null) {
    return undefined;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3])
  };
}

export function compareSemverStrings(left: string, right: string): number {
  const parsedLeft = parseSemverString(left);
  const parsedRight = parseSemverString(right);

  if (parsedLeft === undefined || parsedRight === undefined) {
    throw new Error(`Cannot compare non-semver versions: ${left} vs ${right}`);
  }

  if (parsedLeft.major !== parsedRight.major) {
    return parsedLeft.major - parsedRight.major;
  }

  if (parsedLeft.minor !== parsedRight.minor) {
    return parsedLeft.minor - parsedRight.minor;
  }

  return parsedLeft.patch - parsedRight.patch;
}

export function assertVerdictSemanticsVersionBump(input: {
  previousVersion?: string;
  nextVersion: string;
  verdictSemanticsChanged: boolean;
}): { ok: true } | { ok: false; reason: string } {
  if (!input.verdictSemanticsChanged || input.previousVersion === undefined) {
    return { ok: true };
  }

  return compareSemverStrings(input.nextVersion, input.previousVersion) > 0
    ? { ok: true }
    : {
        ok: false,
        reason: `${VERDICT_SEMANTICS_VERSION_RULE} Previous ${input.previousVersion}, next ${input.nextVersion}.`
      };
}
