import { nanoid } from 'nanoid';
export function createCsrfToken(): string { return nanoid(32); }
