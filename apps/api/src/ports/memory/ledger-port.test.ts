import { ledgerPortContract } from '../ledger-port.contract.js';

import { createMemoryLedgerPort } from './ledger-port.js';

const at = new Date('2026-10-10T10:00:00.000Z');

ledgerPortContract(() => createMemoryLedgerPort(() => at));
