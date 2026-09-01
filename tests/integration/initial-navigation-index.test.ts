import { describe, expect, it } from 'vitest';
import { locateContext } from '../../src/context/locate.js';
import { validateContext } from '../../src/context/validate.js';
import { packagePath } from '../../src/utils/schema.js';

describe('ai-workflow navigation index', () => {
  it('validates the repository index and locates the context feature', async () => {
    const project = packagePath();

    await expect(validateContext(project)).resolves.toEqual({ valid: true, errors: [] });
    await expect(locateContext(project, { feature: 'context-navigation', verify: true })).resolves.toMatchObject({
      status: 'hit', feature: 'context-navigation', fallback_required: false
    });
  });
});
