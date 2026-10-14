import { suspensionLedgerContract } from '../suspension-ledger.contract.js';

import { createMemorySuspensionLedger } from './suspension-ledger.js';

suspensionLedgerContract(createMemorySuspensionLedger);
