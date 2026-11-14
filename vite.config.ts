import fs from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

function syncDualTargetsPlugin(): Plugin {
  const rootDir = import.meta.dirname;
  return {
    name: "sync-dual-singlefile-targets",
    apply: "build",
    closeBundle() {
      const builtHtmlPath = path.resolve(rootDir, "dist/index.html");
      if (!fs.existsSync(builtHtmlPath)) {
        throw new Error(`Expected built HTML at ${builtHtmlPath}`);
      }
      const html = fs.readFileSync(builtHtmlPath, "utf8");
      const targets = [
        path.resolve(rootDir, "public/index.html"),
        path.resolve(rootDir, "apps-script/Index.html")
      ];
      for (const dest of targets) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, html, "utf8");
      }
    }
  };
}

export default defineConfig({
  root: "src",
  publicDir: false,
  plugins: [viteSingleFile(), syncDualTargetsPlugin()],
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    minify: false,
    cssCodeSplit: false,
    modulePreload: false,
    assetsInlineLimit: 100000000
  }
});
