/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_NODE1_URL?: string;
  readonly VITE_NODE2_URL?: string;
  readonly VITE_SOCKET_URL?: string;
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
