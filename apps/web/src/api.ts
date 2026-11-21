export type Role = 'TRAINING_CENTRE' | 'DISTRICT_OFFICER' | 'QUALITY_REVIEWER' | 'STATE_OFFICER';

export interface User {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  centreId: string | null;
}

export interface Centre {
  id: string;
  name: string;
  code: string;
  district: { id: string; name: string };
}

export interface FieldIssue {
  row: number;
  field: string;
  message: string;
}

export class ApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly issues: FieldIssue[] = []) {
    super(message);
  }
}

export async function apiRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', ...options });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const fallback = response.status === 413 ? 'The upload is too large.' : 'CertiFlow could not complete the request.';
    throw new ApiError(response.status, body?.error?.message ?? fallback, body?.error?.issues);
  }
  if (response.status === 204) return undefined as T;
  return response.json();
}

export function postJson<T>(path: string, body: object) {
  return apiRequest<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function errorMessage(error: unknown) {
  return error instanceof ApiError ? error.message : 'Could not connect to CertiFlow. Try again.';
}
