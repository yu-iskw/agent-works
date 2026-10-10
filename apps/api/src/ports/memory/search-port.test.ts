import { searchFixture, searchPortContract } from '../search-port.contract.js';

import { createMemorySearchPort } from './search-port.js';

searchPortContract(() => createMemorySearchPort(searchFixture));
