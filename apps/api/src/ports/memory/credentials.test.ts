import { credentialsPortContract } from '../credentials.contract.js';

import { createMemoryCredentialsPort } from './credentials.js';

credentialsPortContract(() => createMemoryCredentialsPort());
