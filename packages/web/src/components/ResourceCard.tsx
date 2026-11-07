'use client';

import { useState, useTransition } from 'react';
import { readResource, type ReadResult } from '@/app/actions';

// Resources are read-only: pick a URI, press Read, see what a client gets.
export function ResourceCard({ uri, name, description }: { uri: string; name?: string; description?: string }) {
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<ReadResult | null>(null);

  return (
    <div className="tool">
      <h2>{name ?? uri}</h2>
      <p>
        <code>{uri}</code>
        {description ? ` — ${description}` : ''}
      </p>
      <button
        type="button"
        disabled={isPending}
        onClick={() => startTransition(async () => setResult(await readResource(uri)))}
      >
        {isPending ? 'Reading…' : 'Read'}
      </button>
      {result && <pre className={result.ok ? 'result' : 'result error'}>{result.ok ? result.text : result.message}</pre>}
    </div>
  );
}
