import { schedulePortContract } from '../schedule-port.contract.js';

import { createMemorySchedulePort } from './schedule-port.js';
schedulePortContract(createMemorySchedulePort);
