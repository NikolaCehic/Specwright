declare module "node:crypto" {
  export function createHash(
    algorithm: string
  ): {
    update(data: string): {
      digest(encoding: "hex"): string;
    };
  };
}

declare module "node:fs/promises" {
  export interface Dirent {
    name: string;
    isFile(): boolean;
    isDirectory(): boolean;
  }

  export function readFile(path: string, encoding: "utf8"): Promise<string>;
  export function readdir(
    path: string,
    options?: { withFileTypes?: false }
  ): Promise<string[]>;
  export function readdir(
    path: string,
    options: { withFileTypes: true }
  ): Promise<Dirent[]>;
}

declare module "node:path" {
  export function basename(path: string, suffix?: string): string;
  export function extname(path: string): string;
  export function join(...paths: string[]): string;
  export function relative(from: string, to: string): string;
  export function resolve(...paths: string[]): string;
}

declare module "node:url" {
  export function fileURLToPath(url: string): string;
}
