import { describe, it, expect } from 'vitest';
import {
  AppError,
  notFound,
  unauthorized,
  forbidden,
  conflict,
  validationError,
  storageError,
  internalError,
} from './errors.js';

describe('AppError', () => {
  it('should set all properties when constructed with required args', () => {
    const err = new AppError('TEST_CODE', 418, 'teapot error');
    expect(err.code).toBe('TEST_CODE');
    expect(err.statusCode).toBe(418);
    expect(err.message).toBe('teapot error');
    expect(err.field).toBeUndefined();
    expect(err.name).toBe('AppError');
  });

  it('should set field when provided', () => {
    const err = new AppError('VALIDATION_ERROR', 400, 'invalid value', 'email');
    expect(err.field).toBe('email');
  });

  it('should be an instance of Error', () => {
    const err = new AppError('TEST_CODE', 500, 'message');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AppError);
  });
});

describe('notFound', () => {
  it('should create an AppError with NOT_FOUND code and 404 status', () => {
    const err = notFound('Model 123 not found');
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('NOT_FOUND');
    expect(err.statusCode).toBe(404);
    expect(err.message).toBe('Model 123 not found');
  });

  it('should preserve the message passed to it', () => {
    const message = 'Collection abc not found';
    const err = notFound(message);
    expect(err.message).toBe(message);
  });
});

describe('unauthorized', () => {
  it('should create an AppError with UNAUTHORIZED code and 401 status', () => {
    const err = unauthorized('Authentication required');
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('UNAUTHORIZED');
    expect(err.statusCode).toBe(401);
    expect(err.message).toBe('Authentication required');
  });
});

describe('forbidden', () => {
  it('should create an AppError with FORBIDDEN code and 403 status', () => {
    const err = forbidden('Insufficient permissions');
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('FORBIDDEN');
    expect(err.statusCode).toBe(403);
    expect(err.message).toBe('Insufficient permissions');
  });
});

describe('conflict', () => {
  it('should create an AppError with CONFLICT code and 409 status', () => {
    const err = conflict('Email already in use');
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('CONFLICT');
    expect(err.statusCode).toBe(409);
    expect(err.message).toBe('Email already in use');
  });
});

describe('validationError', () => {
  it('should create an AppError with VALIDATION_ERROR code and 400 status', () => {
    const err = validationError('Invalid email format');
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.statusCode).toBe(400);
    expect(err.message).toBe('Invalid email format');
  });

  it('should set field when provided', () => {
    const err = validationError('Invalid email format', 'email');
    expect(err.field).toBe('email');
  });

  it('should leave field undefined when not provided', () => {
    const err = validationError('Request body is malformed');
    expect(err.field).toBeUndefined();
  });
});

describe('storageError', () => {
  it('should create an AppError with STORAGE_ERROR code and 500 status', () => {
    const err = storageError('Failed to write file');
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('STORAGE_ERROR');
    expect(err.statusCode).toBe(500);
    expect(err.message).toBe('Failed to write file');
  });
});

describe('internalError', () => {
  it('should create an AppError with INTERNAL_ERROR code and 500 status', () => {
    const err = internalError('Unexpected failure');
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('INTERNAL_ERROR');
    expect(err.statusCode).toBe(500);
    expect(err.message).toBe('Unexpected failure');
  });
});
