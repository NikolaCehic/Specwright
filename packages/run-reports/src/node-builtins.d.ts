declare module "node:crypto" {
  export function createHash(algorithm: "sha256"): {
    update(data: string): {
      digest(encoding: "hex"): string;
    };
  };
  export function randomUUID(): string;
}

declare module "node:fs/promises" {
  export interface Dirent {
    name: string;
    isDirectory(): boolean;
    isFile(): boolean;
  }

  export interface FileHandle {
    appendFile(data: string): Promise<void>;
    close(): Promise<void>;
    sync(): Promise<void>;
  }
  export interface Stats {
    isDirectory(): boolean;
    isFile(): boolean;
  }

  export function copyFile(source: string, destination: string): Promise<void>;
  export function lstat(path: string): Promise<Stats>;
  export function mkdir(
    path: string,
    options?: { recursive?: boolean }
  ): Promise<string | undefined>;
  export function open(path: string, flags: string): Promise<FileHandle>;
  export function readdir(
    path: string,
    options?: { withFileTypes?: false }
  ): Promise<string[]>;
  export function readdir(
    path: string,
    options: { withFileTypes: true }
  ): Promise<Dirent[]>;
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
  export function rename(oldPath: string, newPath: string): Promise<void>;
  export function rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean }
  ): Promise<void>;
  export function writeFile(
    path: string,
    data: string,
    options?: { flag?: string }
  ): Promise<void>;
}

declare module "node:path" {
  export function dirname(path: string): string;
  export function join(...paths: string[]): string;
  export function relative(from: string, to: string): string;
  export function resolve(...paths: string[]): string;
}
