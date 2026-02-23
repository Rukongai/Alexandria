import { ErrorCodes } from '@alexandria/shared';

export class AppError extends Error {
  constructor(
    public code: string,
    public statusCode: number,
    message: string,
    public field?: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function notFound(message: string): AppError {
  return new AppError(ErrorCodes.NOT_FOUND, 404, message);
}

export function unauthorized(message: string): AppError {
  return new AppError(ErrorCodes.UNAUTHORIZED, 401, message);
}

export function forbidden(message: string): AppError {
  return new AppError(ErrorCodes.FORBIDDEN, 403, message);
}

export function conflict(message: string): AppError {
  return new AppError(ErrorCodes.CONFLICT, 409, message);
}

export function validationError(message: string, field?: string): AppError {
  return new AppError(ErrorCodes.VALIDATION_ERROR, 400, message, field);
}

export function storageError(message: string): AppError {
  return new AppError(ErrorCodes.STORAGE_ERROR, 500, message);
}

export function internalError(message: string): AppError {
  return new AppError(ErrorCodes.INTERNAL_ERROR, 500, message);
}
