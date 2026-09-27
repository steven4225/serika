import type { RendererApi } from "../../shared/ui-contract.js";

declare global {
  interface Window {
    runloom: RendererApi;
  }
}

export {};
