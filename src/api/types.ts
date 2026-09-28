import type { User } from '../modules/auth/users.ts';
import type { components, operations } from './openapi/schema.d.ts';

export type AppEnv = { Variables: { user: User; ip: string } };
export type Schemas = components['schemas'];
export type Operations = operations;
export type OperationId = keyof operations;

type Clean<T> = [T] extends [never]
  ? Record<string, never>
  : [T] extends [undefined]
    ? Record<string, never>
    : NonNullable<T>;

export type PathParams<K extends OperationId> = Clean<operations[K]['parameters']['path']>;
export type QueryParams<K extends OperationId> = Clean<operations[K]['parameters']['query']>;
export type JsonBody<K extends OperationId> =
  NonNullable<operations[K]['requestBody']> extends { content: { 'application/json': infer B } }
    ? B
    : undefined;
