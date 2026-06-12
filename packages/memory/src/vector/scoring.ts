import type { DistanceMetric } from "../dense-contracts";
import { MemoryError } from "../errors";

export function scoreVectorSimilarity(
  left: Float32Array,
  right: Float32Array,
  metric: DistanceMetric
): number {
  if (left.length !== right.length) {
    throw new MemoryError({
      code: "dimension_mismatch",
      field: "vector",
      condition: `${left.length}!=${right.length}`,
      message: `Cannot compare vectors with dimensions ${left.length} and ${right.length}`
    });
  }

  switch (metric) {
    case "cosine":
      return cosineSimilarity(left, right);
    case "inner_product":
      return dot(left, right);
    case "l2":
      return -l2Distance(left, right);
  }
}

export function vectorHashInput(vector: Float32Array): number[] {
  return Array.from(vector, (value) => Number(value.toFixed(8)));
}

function cosineSimilarity(left: Float32Array, right: Float32Array): number {
  const denominator = magnitude(left) * magnitude(right);
  return denominator === 0 ? 0 : dot(left, right) / denominator;
}

function dot(left: Float32Array, right: Float32Array): number {
  let total = 0;
  for (let index = 0; index < left.length; index += 1) {
    total += readVectorValue(left, index) * readVectorValue(right, index);
  }
  return total;
}

function l2Distance(left: Float32Array, right: Float32Array): number {
  let total = 0;
  for (let index = 0; index < left.length; index += 1) {
    const delta = readVectorValue(left, index) - readVectorValue(right, index);
    total += delta * delta;
  }
  return Math.sqrt(total);
}

function magnitude(vector: Float32Array): number {
  let total = 0;
  for (const value of vector) {
    total += value * value;
  }
  return Math.sqrt(total);
}

function readVectorValue(vector: Float32Array, index: number): number {
  const value = vector[index];
  return value === undefined ? 0 : value;
}
