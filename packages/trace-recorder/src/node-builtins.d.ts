declare module "node:crypto" {
  export function randomUUID(): string;
}

declare module "node:fs/promises" {
  export interface FileHandle {
    appendFile(data: string): Promise<void>;
    close(): Promise<void>;
    sync(): Promise<void>;
  }

  export function mkdir(
    path: string,
    options?: { recursive?: boolean }
  ): Promise<string | undefined>;
  export function open(path: string, flags: string): Promise<FileHandle>;
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
  export function rename(oldPath: string, newPath: string): Promise<void>;
  export function writeFile(
    path: string,
    data: string,
    options?: { flag?: string }
  ): Promise<void>;
}

declare module "node:path" {
  export function dirname(path: string): string;
  export function join(...paths: string[]): string;
  export function resolve(...paths: string[]): string;
}
