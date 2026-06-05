declare module "node:fs" {
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function readdirSync(path: string): string[];
  export function writeFileSync(
    path: string,
    data: string,
    encoding: "utf8"
  ): void;
}

declare module "node:path" {
  export function dirname(path: string): string;
  export function join(...paths: string[]): string;
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
  export function pathToFileURL(path: string): URL;
}
