declare module "node:crypto" {
  export interface Hash {
    update(data: string | Uint8Array): Hash;
    digest(encoding: "hex"): string;
  }

  export function randomUUID(): string;

  export function createHash(algorithm: string): Hash;
}

declare module "node:fs/promises" {
  export interface Dirent {
    name: string;
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }

  export interface FileHandle {
    appendFile(data: string): Promise<void>;
    close(): Promise<void>;
    read(
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number
    ): Promise<{ bytesRead: number; buffer: Uint8Array }>;
    sync(): Promise<void>;
  }

  export interface Stats {
    size: number;
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }

  export function copyFile(source: string, destination: string): Promise<void>;
  export function cp(
    source: string,
    destination: string,
    options?: { recursive?: boolean }
  ): Promise<void>;
  export function lstat(path: string): Promise<Stats>;
  export function mkdir(
    path: string,
    options?: { recursive?: boolean }
  ): Promise<string | undefined>;
  export function mkdtemp(prefix: string): Promise<string>;
  export function open(path: string, flags: string): Promise<FileHandle>;
  export function readdir(path: string): Promise<string[]>;
  export function readdir(
    path: string,
    options?: { withFileTypes?: false }
  ): Promise<string[]>;
  export function readdir(
    path: string,
    options: { withFileTypes: true }
  ): Promise<Dirent[]>;
  export function readFile(path: string): Promise<Uint8Array>;
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
  export function realpath(path: string): Promise<string>;
  export function rename(oldPath: string, newPath: string): Promise<void>;
  export function rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean }
  ): Promise<void>;
  export function stat(path: string): Promise<Stats>;
  export function symlink(target: string, path: string): Promise<void>;
  export function writeFile(
    path: string,
    data: string | Uint8Array,
    options?: { flag?: string } | "utf8"
  ): Promise<void>;
}

declare module "node:path" {
  export function basename(path: string, suffix?: string): string;
  export function dirname(path: string): string;
  export function extname(path: string): string;
  export function isAbsolute(path: string): boolean;
  export function join(...paths: string[]): string;
  export function relative(from: string, to: string): string;
  export function resolve(...paths: string[]): string;
  export const sep: string;
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
  export function pathToFileURL(path: string): URL;
}

interface ImportMeta {
  url: string;
}

declare const process: {
  argv: string[];
  exitCode?: number;
};

declare const console: {
  error(message?: unknown, ...optionalParams: unknown[]): void;
  log(message?: unknown, ...optionalParams: unknown[]): void;
};
