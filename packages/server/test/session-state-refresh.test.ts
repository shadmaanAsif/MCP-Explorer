// Stage 11.4: a live session must pick up state another instance saved.
// Found by the kill test: the proxy sent a session's first requests to both
// instances, so each built a live copy, and after a state change on one the other
// kept answering from its old copy. No Redis needed here; test/redis-sessions.test.ts
// covers the same thing with two real servers.
import { describe, expect, it } from 'vitest';
import type { SessionState } from '../src/create-server.js';
import { adoptStoredState } from '../src/session-rebuild.js';

const DUBAI = { name: 'Dubai', latitude: 25.2, longitude: 55.27 };
const PARIS = { name: 'Paris', latitude: 48.85, longitude: 2.35 };

// A live session as http.ts holds it: the state object and the JSON last loaded or saved.
const live = (state: SessionState) => ({ state, savedState: JSON.stringify(state) });

describe('adoptStoredState (Stage 11.4)', () => {
  it('takes a newer stored state in, into the same object the tools hold', () => {
    const session = live({ home: DUBAI });
    const toolsHold = session.state;

    expect(adoptStoredState(session, { home: PARIS })).toBe(true);

    expect(session.state).toBe(toolsHold); // replaced in place, not swapped for a new object
    expect(toolsHold.home).toEqual(PARIS);
  });

  it('drops a key that the stored state no longer has', () => {
    const session = live({ home: DUBAI });

    expect(adoptStoredState(session, {})).toBe(true);

    expect(session.state).toEqual({});
  });

  it('does nothing when the store holds what this instance last loaded or saved', () => {
    const session = live({ home: DUBAI });

    expect(adoptStoredState(session, { home: { ...DUBAI } })).toBe(false);

    expect(session.state.home).toEqual(DUBAI);
  });

  it('does nothing a second time for the same stored state', () => {
    const session = live({ home: DUBAI });
    const stored = { home: PARIS };

    expect(adoptStoredState(session, stored)).toBe(true);
    expect(adoptStoredState(session, stored)).toBe(false);
  });

  it('keeps a change made here that is not written back yet', () => {
    const session = live({ home: DUBAI });
    session.state.home = { name: 'Cairo', latitude: 30.04, longitude: 31.24 }; // a tool ran, persistState has not

    expect(adoptStoredState(session, { home: PARIS })).toBe(false);

    expect(session.state.home?.name).toBe('Cairo');
  });

  it('leaves the state alone when the store hands back the same object (memory store)', () => {
    const session = live({ home: DUBAI });

    expect(adoptStoredState(session, session.state)).toBe(false);

    expect(session.state.home).toEqual(DUBAI);
  });

  it('copies the stored state, so changing the session later does not change the record', () => {
    const session = live({});
    const stored: SessionState = { home: { ...PARIS } };

    adoptStoredState(session, stored);
    session.state.home!.name = 'Changed';

    expect(stored.home?.name).toBe('Paris');
  });
});
