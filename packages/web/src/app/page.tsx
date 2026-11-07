import { withClient } from '@/lib/mcp-client';
import { ToolCard } from '@/components/ToolCard';
import { ResourceCard } from '@/components/ResourceCard';
import { PromptCard } from '@/components/PromptCard';

// Without this, `next build` would statically prerender this route — which
// means it would actually execute the component (spawning the MCP server
// subprocess) at build time and bake a stale tool list into static HTML.
export const dynamic = 'force-dynamic';

export default async function Page() {
  // One round trip per list, inside one withClient so a restarted server is
  // retried as a whole. A server only supports a list if it declared that
  // capability when connecting, so check before asking.
  const { tools, resources, templates, prompts } = await withClient(async (client) => {
    const caps = client.getServerCapabilities() ?? {};
    const [tools, resources, templates, prompts] = await Promise.all([
      client.listTools(),
      caps.resources ? client.listResources() : { resources: [] },
      caps.resources ? client.listResourceTemplates() : { resourceTemplates: [] },
      caps.prompts ? client.listPrompts() : { prompts: [] }
    ]);
    return {
      tools: tools.tools,
      resources: resources.resources,
      templates: templates.resourceTemplates,
      prompts: prompts.prompts
    };
  });

  return (
    <main>
      <h1>MCP Explorer — Dashboard</h1>
      <p>
        A GUI over the MCP server, driven by <code>@mcp-explorer/client</code>. Fills in a form
        per tool from its live schema.
      </p>

      <h2>Tools</h2>
      <p>Actions the model decides to run.</p>
      {tools.map((tool) => (
        <ToolCard key={tool.name} tool={tool} />
      ))}

      <h2>Resources</h2>
      <p>Read-only data a client attaches as context. Reading never changes anything.</p>
      {resources.map((r) => (
        <ResourceCard key={r.uri} uri={r.uri} name={r.name} description={r.description} />
      ))}
      {templates.length > 0 && (
        <p>
          Templates (the <code>{'{name}'}</code> part is filled in by the client):{' '}
          {templates.map((t) => t.uriTemplate).join(', ')}
        </p>
      )}

      <h2>Prompts</h2>
      <p>Ready-made requests the user picks. Shown here as text; no model reads them.</p>
      {prompts.map((p) => (
        <PromptCard key={p.name} prompt={p} />
      ))}
    </main>
  );
}
