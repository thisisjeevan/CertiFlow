export type Role = 'TRAINING_CENTRE' | 'DISTRICT_OFFICER' | 'QUALITY_REVIEWER' | 'STATE_OFFICER';

export interface User {
  id: string;
  email: string;
  displayName: string;
  role: Role;
}

export interface Centre {
  id: string;
  name: string;
  code: string;
  district: { id: string; name: string };
}

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export async function apiRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', ...options });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new ApiError(response.status, body?.error?.message ?? 'CertiFlow could not complete the request.');
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
