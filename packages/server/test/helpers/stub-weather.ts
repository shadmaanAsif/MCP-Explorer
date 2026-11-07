import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type StubMode = 'ok' | '500' | '404' | 'badjson' | 'badshape' | 'hang';

const GOOD_BODY = {
  current: { temperature_2m: 12.3, wind_speed_10m: 4.5 },
  current_units: { temperature_2m: '°C', wind_speed_10m: 'km/h' }
};

// A fake Open-Meteo. `mode` decides how it answers; `hits` counts requests that
// reached it and `closed` counts connections dropped before it answered, so a
// test can prove that a cancel really stopped an upstream call.
export type WeatherStub = {
  url: string;
  mode: StubMode;
  hits: number;
  closed: number;
  requests: IncomingMessage[];
  close: () => Promise<void>;
};

export async function startWeatherStub(initial: StubMode = 'ok'): Promise<WeatherStub> {
  const stub: WeatherStub = { url: '', mode: initial, hits: 0, closed: 0, requests: [], close: async () => {} };
  const server: Server = createServer((req, res) => {
    stub.hits++;
    stub.requests.push(req);
    res.on('close', () => {
      if (!res.writableEnded) stub.closed++;
    });
    switch (stub.mode) {
      case 'ok':
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(GOOD_BODY));
        return;
      case '500':
        res.writeHead(500).end();
        return;
      case '404':
        res.writeHead(404).end();
        return;
      case 'badjson':
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('<html>not json</html>');
        return;
      case 'badshape':
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ hello: 'world' }));
        return;
      case 'hang':
        return; // never answer
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  stub.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stub.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return stub;
}
