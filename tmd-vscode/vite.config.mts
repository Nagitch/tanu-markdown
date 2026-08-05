import adapter from "@sveltejs/adapter-static";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const output = fileURLToPath(new URL("./dist/webview", import.meta.url));

export default defineConfig({
  plugins: [
    sveltekit({
      adapter: adapter({
        pages: output,
        assets: output,
        strict: true,
      }),
      files: {
        appTemplate: "webview/src/app.html",
        lib: "webview/src/lib",
        routes: "webview/src/routes",
      },
      output: {
        bundleStrategy: "single",
      },
      paths: {
        relative: true,
      },
      serviceWorker: {
        register: false,
      },
    }),
  ],
});
