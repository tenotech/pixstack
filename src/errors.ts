export type PixstackErrorCode =
  | "EMPTY"
  | "TOO_LARGE"
  | "TOO_MANY_PIXELS"
  | "TOO_WIDE"
  | "UNSUPPORTED_FORMAT"
  | "SVG_NOT_ALLOWED"
  | "ANIMATED_NOT_ALLOWED"
  | "DECODE_FAILED"
  | "NO_ORIGINAL"
  | "INVALID_KEY";

/** Suggested HTTP status per error code, for upload routes. */
export const ERROR_STATUS: Record<PixstackErrorCode, number> = {
  EMPTY: 400,
  TOO_LARGE: 413,
  TOO_MANY_PIXELS: 413,
  TOO_WIDE: 413,
  UNSUPPORTED_FORMAT: 415,
  SVG_NOT_ALLOWED: 415,
  ANIMATED_NOT_ALLOWED: 415,
  DECODE_FAILED: 400,
  NO_ORIGINAL: 409,
  INVALID_KEY: 400,
};

export class PixstackError extends Error {
  readonly code: PixstackErrorCode;
  readonly status: number;

  constructor(code: PixstackErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PixstackError";
    this.code = code;
    this.status = ERROR_STATUS[code];
  }
}

export function isPixstackError(err: unknown): err is PixstackError {
  return err instanceof PixstackError;
}
