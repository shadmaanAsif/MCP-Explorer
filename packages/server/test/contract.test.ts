import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectInMemory } from './helpers/connect.js';

// Contract snapshot: the server's public surface (names, descriptions, input
// schemas). A change here is a change clients can see, so it should fail until
// someone updates the snapshot on purpose (vitest -u).
describe('public contract', () => {
  let h: Awaited<ReturnType<typeof connectInMemory>>;
  beforeAll(async () => {
    h = await connectInMemory();
  });
  afterAll(async () => {
    await h.close();
  });

  it('tools', async () => {
    const { tools } = await h.client.listTools();
    const sorted = tools
      .map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema }))
      .sort((a, b) => a.name.localeCompare(b.name));
    expect(sorted).toMatchSnapshot();
  });

  it('resources and templates', async () => {
    const { resources } = await h.client.listResources();
    const { resourceTemplates } = await h.client.listResourceTemplates();
    expect({
      resources: resources.map(({ uri, name, mimeType }) => ({ uri, name, mimeType })).sort((a, b) => a.uri.localeCompare(b.uri)),
      resourceTemplates: resourceTemplates.map(({ uriTemplate, name, mimeType }) => ({ uriTemplate, name, mimeType }))
    }).toMatchSnapshot();
  });

  it('prompts', async () => {
    const { prompts } = await h.client.listPrompts();
    const sorted = prompts
      .map(({ name, description, arguments: args }) => ({ name, description, arguments: args }))
      .sort((a, b) => a.name.localeCompare(b.name));
    expect(sorted).toMatchSnapshot();
  });
});
