'use client';

import { useState, useTransition } from 'react';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { runTool, type RunToolResult } from '@/app/actions';

// Plain controlled state + useTransition, not useActionState/<form>: fields
// are built dynamically from arbitrary JSON Schema (number, boolean, ...),
// and FormData values are always strings, which would force a schema-driven
// coercion layer on top of useActionState. This keeps native types and
// calls the server action like a normal async function.
export function ToolCard({ tool }: { tool: Tool }) {
  const props = (tool.inputSchema?.properties ?? {}) as Record<string, { type?: string }>;
  const fieldNames = Object.keys(props);

  const [values, setValues] = useState<Record<string, string>>({});
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<RunToolResult | null>(null);

  function handleRun() {
    const args: Record<string, unknown> = {};
    for (const name of fieldNames) {
      const raw = values[name] ?? '';
      args[name] = props[name].type === 'number' ? Number(raw) : raw;
    }

    startTransition(async () => {
      const res = await runTool(tool.name, args);
      setResult(res);
    });
  }

  return (
    <div className="tool">
      <h2>{tool.name}</h2>
      <p>{tool.description}</p>
      {fieldNames.map((name) => (
        <label key={name}>
          {name}
          <input
            type={props[name].type === 'number' ? 'number' : 'text'}
            value={values[name] ?? ''}
            onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))}
          />
        </label>
      ))}
      <button type="button" onClick={handleRun} disabled={isPending}>
        {isPending ? 'Running…' : 'Run'}
      </button>
      {result && (
        <pre className={result.isError ? 'result error' : 'result'}>
          {JSON.stringify(result.content, null, 2)}
        </pre>
      )}
    </div>
  );
}
