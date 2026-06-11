declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  exitCode?: number;
  stdout: {
    write(chunk: string): void;
  };
  stderr: {
    write(chunk: string): void;
  };
};

declare function setTimeout(
  callback: () => void,
  milliseconds: number
): unknown;

declare function clearTimeout(timeout: unknown): void;

declare module "node:path" {
  export function resolve(...paths: string[]): string;
}
