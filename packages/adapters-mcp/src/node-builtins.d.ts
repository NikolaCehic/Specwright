interface URL {
  readonly protocol: string;
  readonly username: string;
  readonly password: string;
  readonly hostname: string;
  readonly port: string;
}

declare class TextDecoder {
  decode(input?: Uint8Array, options?: { stream?: boolean }): string;
}

declare module "node:path" {
  export function resolve(...paths: string[]): string;
}

declare module "node:readline" {
  export type Interface = AsyncIterable<string> & {
    close(): void;
  };

  export function createInterface(options: {
    input: unknown;
    crlfDelay?: number;
  }): Interface;
}
