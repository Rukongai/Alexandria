import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ZodSchema } from 'zod';
import { validationError } from '../utils/errors.js';

export function validate(schema: ZodSchema) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const result = schema.safeParse(request.body);
    if (!result.success) {
      const firstIssue = result.error.issues[0];
      const field = firstIssue?.path.join('.') ?? undefined;
      const message = firstIssue?.message ?? 'Validation failed';
      throw validationError(message, field);
    }
    // Replace body with the parsed/coerced Zod output so handlers get clean data
    request.body = result.data;
  };
}
