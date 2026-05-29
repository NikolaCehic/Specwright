declare class Buffer extends Uint8Array {
  static alloc(size: number): Buffer;
  subarray(start?: number, end?: number): Buffer;
  toString(encoding?: string): string;
}

declare module "node:crypto" {
  export function randomUUID(): string;
  export function createHash(algorithm: string): {
    update(data: string): {
      digest(encoding: "hex"): string;
    };
    digest(encoding: "hex"): string;
  };
}

declare module "node:fs/promises" {
  export interface Dirent {
    name: string;
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }

  export interface FileHandle {
    close(): Promise<void>;
    read(
      buffer: Buffer,
      offset: number,
      length: number,
      position: number
    ): Promise<{ bytesRead: number; buffer: Buffer }>;
  }

  export interface Stats {
    size: number;
    isDirectory(): boolean;
    isFile(): boolean;
  }

  export function open(path: string, flags: string): Promise<FileHandle>;
  export function readdir(
    path: string,
    options: { withFileTypes: true }
  ): Promise<Dirent[]>;
  export function realpath(path: string): Promise<string>;
  export function stat(path: string): Promise<Stats>;
}

declare module "node:path" {
  export function isAbsolute(path: string): boolean;
  export function relative(from: string, to: string): string;
  export function resolve(...paths: string[]): string;
  export const sep: string;
}
