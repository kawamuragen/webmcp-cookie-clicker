/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    // WebMCP は SecureContext 限定。localhost は secure 扱いなのでそのままでOK。
    host: 'localhost',
    port: 5173,
  },
  test: {
    environment: 'node',
  },
});
