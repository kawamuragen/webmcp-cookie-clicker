/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

export default defineConfig({
  // GitHub Pages（/webmcp-cookie-clicker/）でもどこでも動くよう相対パスで出力する
  base: './',
  server: {
    // WebMCP は SecureContext 限定。localhost は secure 扱いなのでそのままでOK。
    host: 'localhost',
    port: 5173,
  },
  test: {
    environment: 'node',
  },
});
