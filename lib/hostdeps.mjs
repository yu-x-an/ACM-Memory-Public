// Take defineTool from the host when it is resolvable; otherwise fall back to a
// local equivalent so the plugin always imports.
//
// A bare import of a host package makes the plugin unreachable on machines that
// do not have it, which is why the lookup is dynamic and the fallback exists.

export async function loadHostDeps() {
  const candidates = ['@deepseek-ai/dsh', 'dsh', '@deepseek-ai/dsh-sdk', '@deepseek-ai/sdk']
  for (const spec of candidates) {
    try {
      const m = await import(spec)
      if (typeof m.defineTool === 'function') {
        return { defineTool: m.defineTool, createUserMessage: m.createUserMessage ?? null, source: spec }
      }
    } catch {
      // try the next specifier
    }
  }
  // The host serializes a tool through the shape its defineTool() produces:
  // `output` with a schema and a renderer, plus `execute`. A bare
  // `{name, description, parameters, run}` registers but never reaches the model
  // tool list, which is what a real headless run showed.
  return {
    defineTool: (t) => ({
      ...t,
      output: t.output ?? { schema: null, render: () => '' },
      execute: t.execute ?? (async (args) => t.run(args)),
    }),
    createUserMessage: null,
    source: 'local-shim',
  }
}
