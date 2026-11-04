'use client';

import { useState, useTransition } from 'react';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { runTool, type RunToolResult } from '@/app/actions';

// Plain controlled state + useTransition, not useActionState/<form>: fields
// are built dynamically from arbitrary JSON Schema (number, boolean, ...),
// and FormData values are always strings, which would force a schema-driven
// coercion layer on top of useActionState. This keeps native types and
// calls the server action like a normal async function.
const isStructured = (type?: string) => type === 'array' || type === 'object';

export function ToolCard({ tool }: { tool: Tool }) {
  const props = (tool.inputSchema?.properties ?? {}) as Record<string, { type?: string }>;
  const fieldNames = Object.keys(props);

  const [values, setValues] = useState<Record<string, string>>({});
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<RunToolResult | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);

  function handleRun() {
    const args: Record<string, unknown> = {};
    for (const name of fieldNames) {
      const raw = values[name] ?? '';
      const type = props[name].type;
      if (type === 'number') {
        args[name] = Number(raw);
      } else if (isStructured(type)) {
        // Arrays/objects are entered as JSON text and parsed here.
        try {
          args[name] = JSON.parse(raw);
        } catch {
          setInputError(`"${name}" is not valid JSON`);
          return;
        }
      } else {
        args[name] = raw;
      }
    }
    setInputError(null);

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
          {isStructured(props[name].type) ? (
            <textarea
              rows={6}
              placeholder={`JSON ${props[name].type}`}
              value={values[name] ?? ''}
              onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))}
            />
          ) : (
            <input
              type={props[name].type === 'number' ? 'number' : 'text'}
              value={values[name] ?? ''}
              onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))}
            />
          )}
        </label>
      ))}
      <button type="button" onClick={handleRun} disabled={isPending}>
        {isPending ? 'Running…' : 'Run'}
      </button>
      {inputError && <pre className="result error">{inputError}</pre>}
      {result && (
        <pre className={result.isError ? 'result error' : 'result'}>
          {JSON.stringify(result.content, null, 2)}
        </pre>
      )}
    </div>
  );
}
