import { exporterPortContract } from '../exporter-port.contract.js';

import { createMemoryExporterPort } from './exporter-port.js';

exporterPortContract(() => createMemoryExporterPort());
