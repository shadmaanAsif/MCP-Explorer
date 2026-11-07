'use client';

import { useId, useState, useTransition } from 'react';
import type { Prompt } from '@modelcontextprotocol/sdk/types.js';
import { completeArgument, getPrompt, type ReadResult } from '@/app/actions';

// A prompt returns message text. Nothing here sends it to a model: this page
// only shows what a client would receive. Each argument asks the server for
// completions as you type, shown through a <datalist>.
export function PromptCard({ prompt }: { prompt: Prompt }) {
  const baseId = useId();
  const args = prompt.arguments ?? [];
  const [values, setValues] = useState<Record<string, string>>({});
  const [suggestions, setSuggestions] = useState<Record<string, string[]>>({});
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<ReadResult | null>(null);

  async function handleChange(name: string, value: string) {
    setValues((v) => ({ ...v, [name]: value }));
    const found = await completeArgument({ type: 'ref/prompt', name: prompt.name }, name, value);
    setSuggestions((s) => ({ ...s, [name]: found }));
  }

  return (
    <div className="tool">
      <h2>{prompt.name}</h2>
      <p>{prompt.description}</p>
      {args.map((arg) => {
        const listId = `${baseId}-${arg.name}`;
        return (
          <label key={arg.name}>
            {arg.name}
            {arg.description ? ` (${arg.description})` : ''}
            <input
              list={listId}
              value={values[arg.name] ?? ''}
              onChange={(e) => void handleChange(arg.name, e.target.value)}
            />
            <datalist id={listId}>
              {(suggestions[arg.name] ?? []).map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </label>
        );
      })}
      <button
        type="button"
        disabled={isPending}
        onClick={() => startTransition(async () => setResult(await getPrompt(prompt.name, values)))}
      >
        {isPending ? 'Getting…' : 'Get prompt'}
      </button>
      {result && <pre className={result.ok ? 'result' : 'result error'}>{result.ok ? result.text : result.message}</pre>}
    </div>
  );
}
