import { getClient } from '@/lib/mcp-client';
import { ToolCard } from '@/components/ToolCard';

// Without this, `next build` would statically prerender this route — which
// means it would actually execute the component (spawning the MCP server
// subprocess) at build time and bake a stale tool list into static HTML.
export const dynamic = 'force-dynamic';

export default async function Page() {
  const client = await getClient();
  const { tools } = await client.listTools();

  return (
    <main>
      <h1>MCP Explorer — Dashboard</h1>
      <p>
        A GUI over the MCP server, driven by <code>@mcp-explorer/client</code>. Fills in a form
        per tool from its live schema.
      </p>
      {tools.map((tool) => (
        <ToolCard key={tool.name} tool={tool} />
      ))}
    </main>
  );
}
