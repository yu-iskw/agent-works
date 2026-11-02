import { describe, expect, it } from 'vitest';

import { ApiFailure } from '../api.js';

import { errorText } from './composer-errors.js';

describe('errorText', () => {
  it("prefers the segment's own explanation, which names what is wrong", () => {
    const failure = new ApiFailure(
      400,
      'attachment_invalid_csv',
      'Row 3 has 4 columns; the header has 3.',
    );
    expect(errorText(failure, 'Your draft is kept.')).toBe(
      'Row 3 has 4 columns; the header has 3. Your draft is kept.',
    );
  });

  it('falls back to the known wording, then to the code', () => {
    expect(errorText(new ApiFailure(400, 'unsupported_media_type'), 'Kept.')).toBe(
      'That file type is not supported; use .txt, .md, .csv or .json. Kept.',
    );
    expect(errorText(new ApiFailure(409, 'something_new'), 'Kept.')).toBe(
      'Could not complete that (something_new). Kept.',
    );
  });
});
