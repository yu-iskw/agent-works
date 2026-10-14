import { beforeEach } from 'vitest';

import { userMemoryContract } from '../user-memory.contract.js';

import { createInMemoryUserMemoryStore } from './user-memory.js';
let store = createInMemoryUserMemoryStore();
beforeEach(() => {
  store = createInMemoryUserMemoryStore();
});
userMemoryContract(() => store);
