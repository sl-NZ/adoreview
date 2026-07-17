// Browser bundle entry: expose the vanilla @pierre/diffs API to app.js.
// Built by server.ts at startup (Bun.build → ui/dist/), loaded as a module
// script before app.js. app.js falls back to the legacy renderer if this
// failed to load, so a broken bundle degrades instead of breaking review.
import { CodeView, FileDiff, processPatch, processFile, preloadHighlighter } from "@pierre/diffs";
import { getOrCreateWorkerPoolSingleton } from "@pierre/diffs/worker";

const LANGS = [
  "csharp", "razor", "typescript", "tsx", "javascript", "jsx", "vue", "json", "jsonc",
  "yaml", "html", "css", "scss", "less", "markdown", "sql", "xml", "powershell",
  "shellscript", "hcl", "toml", "ini", "python", "go", "rust", "java", "kotlin",
  "ruby", "graphql", "docker",
];

(window as any).Pierre = {
  CodeView,
  FileDiff,
  processPatch,
  processFile,
  preloadHighlighter,
  // off-main-thread syntax highlighting; optional — callers must tolerate null
  createWorkerPool() {
    try {
      return getOrCreateWorkerPoolSingleton({
        poolOptions: { workerFactory: () => new Worker("/dist/pierre-worker.js", { type: "module" }) },
        highlighterOptions: {
          theme: { dark: "github-dark-default", light: "github-light-default" },
          langs: LANGS as any,
        },
      });
    } catch (e) {
      console.warn("worker pool unavailable — highlighting on main thread", e);
      return undefined;
    }
  },
};
