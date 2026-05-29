declare class URL {
  constructor(input: string, base?: string | URL);
}

interface ImportMeta {
  url: string;
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
}
