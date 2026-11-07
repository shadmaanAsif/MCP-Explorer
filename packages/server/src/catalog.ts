import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { completable } from '@modelcontextprotocol/sdk/server/completable.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { SessionState } from './create-server.js';

// --- Resources, prompts and completions -------------------------------------
// Tools are things the model *does*. The two primitives below are different:
//   - a resource is read-only data the app or user attaches as context,
//     addressed by a URI. Reading one never changes anything.
//   - a prompt is a ready-made request the user picks; the server fills in a
//     template and hands back messages.
// Both read from the same small city table, so there is no new upstream API.

type City = { name: string; latitude: number; longitude: number };

// Keyed by the slug used in URIs (weather://city/dubai).
const CITIES: Record<string, City> = {
  dubai: { name: 'Dubai', latitude: 25.2048, longitude: 55.2708 },
  delhi: { name: 'Delhi', latitude: 28.6139, longitude: 77.209 },
  london: { name: 'London', latitude: 51.5072, longitude: -0.1276 },
  tokyo: { name: 'Tokyo', latitude: 35.6762, longitude: 139.6503 },
  'new-york': { name: 'New York', latitude: 40.7128, longitude: -74.006 }
};

const STYLES = ['brief', 'detailed'];
const JSON_MIME = 'application/json';

// Completion is a plain prefix lookup: the client sends what the user has
// typed so far and gets matching values back.
function startingWith(options: string[], typed: string): string[] {
  const prefix = typed.toLowerCase();
  return options.filter((option) => option.toLowerCase().startsWith(prefix));
}

const citySlugs = () => Object.keys(CITIES);

function findCity(value: string): City {
  const city = CITIES[value.toLowerCase().replace(/\s+/g, '-')];
  if (!city) {
    throw new McpError(ErrorCode.InvalidParams, `Unknown city "${value}". Known: ${citySlugs().join(', ')}`);
  }
  return city;
}

export function registerCatalog(server: McpServer, session: SessionState): void {
  // A fixed URI: one resource, always listed.
  server.registerResource(
    'cities',
    'weather://cities',
    {
      title: 'Known cities',
      description: 'Every city this server knows, with its coordinates.',
      mimeType: JSON_MIME
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: JSON_MIME, text: JSON.stringify(CITIES, null, 2) }]
    })
  );

  // A URI template: `{name}` is a variable the client fills in. `list` makes
  // each city show up in resources/list; `complete` powers autocomplete.
  server.registerResource(
    'city',
    new ResourceTemplate('weather://city/{name}', {
      list: async () => ({
        resources: Object.entries(CITIES).map(([slug, city]) => ({
          uri: `weather://city/${slug}`,
          name: city.name,
          mimeType: JSON_MIME
        }))
      }),
      complete: { name: (typed) => startingWith(citySlugs(), typed) }
    }),
    {
      title: 'One city',
      description: 'Name and coordinates for a single known city.',
      mimeType: JSON_MIME
    },
    async (uri, variables) => {
      const city = findCity(String(variables.name));
      return { contents: [{ uri: uri.href, mimeType: JSON_MIME, text: JSON.stringify(city, null, 2) }] };
    }
  );

  // Reads this connection's session state, so it only holds a value in
  // stateful HTTP (or stdio); stateless builds a fresh session per request.
  server.registerResource(
    'home',
    'session://home',
    {
      title: 'Home location',
      description: 'The location saved by set_home_location in this session, or null.',
      mimeType: JSON_MIME
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: JSON_MIME, text: JSON.stringify(session.home ?? null) }]
    })
  );

  server.registerPrompt(
    'compare_weather',
    {
      title: 'Compare weather in two cities',
      description: 'Asks the model to fetch and compare current weather for two known cities.',
      argsSchema: {
        cityA: completable(z.string().describe('First city'), (typed) => startingWith(citySlugs(), typed)),
        cityB: completable(z.string().describe('Second city'), (typed) => startingWith(citySlugs(), typed))
      }
    },
    ({ cityA, cityB }) => {
      const a = findCity(cityA);
      const b = findCity(cityB);
      const locations = JSON.stringify([a, b]);
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text:
                `Compare the current weather in ${a.name} and ${b.name}. ` +
                `Call get_weather_batch with locations ${locations}, then say which is warmer and which is windier.`
            }
          }
        ]
      };
    }
  );

  server.registerPrompt(
    'weather_report',
    {
      title: 'Weather report for one city',
      description: 'Asks the model for a short or detailed weather report for a known city.',
      argsSchema: {
        city: completable(z.string().describe('City to report on'), (typed) => startingWith(citySlugs(), typed)),
        style: completable(z.string().describe(`One of: ${STYLES.join(', ')}`), (typed) =>
          startingWith(STYLES, typed)
        )
      }
    },
    ({ city, style }) => {
      const found = findCity(city);
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text:
                `Write a ${style} weather report for ${found.name}. ` +
                `Call get_weather with latitude ${found.latitude} and longitude ${found.longitude} first.`
            }
          }
        ]
      };
    }
  );
}
