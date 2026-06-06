declare module "node:crypto" {
  export type KeyObject = {
    export(options: { type: "spki"; format: "pem" }): string;
  };

  export function createHash(
    algorithm: string
  ): {
    update(data: string | Uint8Array): {
      digest(encoding: "hex"): string;
    };
  };

  export function randomUUID(): string;

  export function createPublicKey(
    key:
      | string
      | {
          key: Uint8Array;
          format: "der";
          type: "spki";
        }
  ): KeyObject;

  export function generateKeyPairSync(algorithm: "ed25519"): {
    publicKey: KeyObject;
    privateKey: KeyObject;
  };

  export function sign(
    algorithm: string | null,
    data: string | Uint8Array,
    key: KeyObject
  ): import("node:buffer").Buffer;

  export function verify(
    algorithm: string | null,
    data: string | Uint8Array,
    key: KeyObject,
    signature: Uint8Array
  ): boolean;
}

declare module "node:buffer" {
  export class Buffer extends Uint8Array {
    static from(data: string, encoding: "base64" | "utf8"): Buffer;
    toString(encoding?: "base64" | "utf8"): string;
  }
}

declare module "node:fs/promises" {
  export interface Dirent {
    name: string;
    isFile(): boolean;
    isDirectory(): boolean;
  }

  export function readFile(path: string, encoding: "utf8"): Promise<string>;
  export function writeFile(path: string, data: string): Promise<void>;
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
  export function dirname(path: string): string;
  export function extname(path: string): string;
  export function join(...paths: string[]): string;
  export function relative(from: string, to: string): string;
  export function resolve(...paths: string[]): string;
}

declare module "node:url" {
  export function fileURLToPath(url: string): string;
}
