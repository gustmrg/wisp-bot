/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FEATURE_CIRCLES?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
