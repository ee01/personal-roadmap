/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<object, object, unknown>;
  export default component;
}

declare global {
  interface Window {
    __PAI_ROADMAP_BRIDGE__?: {
      importJql?: (
        jql: string,
        quarters: string[],
      ) => Promise<ImportItemPayload[]>;
      createJiraTasks?: (
        prompt: string,
        drafts: Array<{ subId: string; title: string; epicKey: string }>,
      ) => Promise<Array<{ subId: string; jiraKey: string }>>;
    };
  }
}

export interface ImportItemPayload {
  key: string;
  type: string;
  title: string;
  quarter?: string;
  estimate?: number;
  targetStart?: string;
  targetEnd?: string;
}

export {};
