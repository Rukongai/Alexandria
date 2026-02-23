import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { ErrorCodes } from '@alexandria/shared';
import { AppError } from '../utils/errors.js';

export function errorHandler(
  error: FastifyError | AppError | ZodError | Error,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  if (error instanceof AppError) {
    reply.status(error.statusCode).send({
      data: null,
      meta: null,
      errors: [
        {
          code: error.code,
          field: error.field ?? null,
          message: error.message,
        },
      ],
    });
    return;
  }

  if (error instanceof ZodError) {
    const firstIssue = error.issues[0];
    reply.status(400).send({
      data: null,
      meta: null,
      errors: [
        {
          code: ErrorCodes.VALIDATION_ERROR,
          field: firstIssue?.path.join('.') ?? null,
          message: firstIssue?.message ?? 'Validation failed',
        },
      ],
    });
    return;
  }

  // Fastify's built-in validation errors expose a statusCode
  const fastifyError = error as FastifyError;
  if (fastifyError.statusCode === 400) {
    reply.status(400).send({
      data: null,
      meta: null,
      errors: [
        {
          code: ErrorCodes.VALIDATION_ERROR,
          field: null,
          message: fastifyError.message ?? 'Validation failed',
        },
      ],
    });
    return;
  }

  // Unexpected error — log full detail, send generic message to client
  request.log.error(
    {
      service: 'ErrorHandler',
      err: error,
      requestId: request.id,
      url: request.url,
      method: request.method,
    },
    'Unhandled error',
  );

  reply.status(500).send({
    data: null,
    meta: null,
    errors: [
      {
        code: ErrorCodes.INTERNAL_ERROR,
        field: null,
        message: 'An unexpected error occurred',
      },
    ],
  });
}
