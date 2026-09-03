/// <reference types="vite/client" />

declare const __APP_PACKAGE_NAME__: string;
declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  readonly VITE_FEATURE_CIRCLES?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
