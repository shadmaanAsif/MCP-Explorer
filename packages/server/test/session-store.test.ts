// Stage 11.1: the in-memory store meets the SessionStore contract.
import { MemorySessionStore } from '../src/session-store.js';
import { storeContract } from './helpers/store-contract.js';

storeContract('memory', () => new MemorySessionStore());
