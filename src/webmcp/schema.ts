import type { JsonSchema } from './types.ts';

/**
 * このゲームで使う JSON Schema のサブセットだけを検証する小さなバリデータ。
 *
 * ブラウザ（エージェント側）が inputSchema を守ってくれる保証はないので、
 * ツール側でも必ず検証して「何が悪かったか」をエージェントが読める形で返す。
 */
export function validateInput(schema: JsonSchema | undefined, input: unknown): string[] {
  if (!schema) return [];
  return validate(schema, input, 'input');
}

function validate(schema: JsonSchema, value: unknown, path: string): string[] {
  const errors: string[] = [];
  if (schema.enum && !schema.enum.includes(value as string | number)) {
    errors.push(`${path} は ${schema.enum.map((v) => JSON.stringify(v)).join(' / ')} のいずれか（受け取った値: ${JSON.stringify(value)}）`);
    return errors;
  }
  switch (schema.type) {
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return [`${path} はオブジェクトである必要があります`];
      }
      const obj = value as Record<string, unknown>;
      for (const key of schema.required ?? []) {
        if (obj[key] === undefined) errors.push(`${path}.${key} は必須です`);
      }
      for (const [key, v] of Object.entries(obj)) {
        const sub = schema.properties?.[key];
        if (!sub) {
          if (schema.additionalProperties === false) {
            const known = Object.keys(schema.properties ?? {});
            errors.push(`${path}.${key} は未知のパラメータです（使えるのは: ${known.join(', ') || 'なし'}）`);
          }
          continue;
        }
        if (v === undefined) continue;
        errors.push(...validate(sub, v, `${path}.${key}`));
      }
      return errors;
    }
    case 'integer':
    case 'number': {
      if (typeof value !== 'number' || Number.isNaN(value)) return [`${path} は数値である必要があります`];
      if (schema.type === 'integer' && !Number.isInteger(value)) errors.push(`${path} は整数である必要があります`);
      if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path} は ${schema.minimum} 以上`);
      if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path} は ${schema.maximum} 以下`);
      return errors;
    }
    case 'string': {
      if (typeof value !== 'string') return [`${path} は文字列である必要があります`];
      if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path} は ${schema.minLength} 文字以上`);
      if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path} は ${schema.maxLength} 文字以下`);
      return errors;
    }
    case 'boolean':
      return typeof value === 'boolean' ? [] : [`${path} は true / false である必要があります`];
    default:
      return errors;
  }
}

/** デバッグパネル用：スキーマから入力例を作る */
export function exampleFor(schema: JsonSchema | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, sub] of Object.entries(schema?.properties ?? {})) {
    if (!schema?.required?.includes(key) && sub.default === undefined) continue;
    if (sub.default !== undefined) out[key] = sub.default;
    else if (sub.enum?.length) out[key] = sub.enum[0];
    else if (sub.type === 'integer' || sub.type === 'number') out[key] = sub.minimum ?? 1;
    else if (sub.type === 'boolean') out[key] = false;
    else out[key] = '';
  }
  return out;
}
