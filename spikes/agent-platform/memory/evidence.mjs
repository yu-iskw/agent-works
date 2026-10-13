import { createEvidence } from '../shared/evidence.mjs';
import { feature, requestShape, responseShape, expectedResponse } from './probe.mjs';

export const { validateEvidence, makeEvidence, recordedBackend, runProbe } = createEvidence({
  feature,
  requestShape,
  responseShape,
  expectedResponse,
});
