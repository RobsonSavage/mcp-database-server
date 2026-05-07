import { encode as toonEncode } from '@toon-format/toon';

/**
 * Coerce values that aren't part of the JSON data model into something the
 * TOON encoder (and JSON, by extension) can serialise. Walks objects/arrays
 * recursively; primitives pass through unchanged.
 *
 * Driver-specific types we expect to see:
 *   - Date            -> ISO 8601 string
 *   - Buffer / typed array -> base64 string (varbinary, RowVersion, etc.)
 *   - bigint          -> string (avoid precision loss vs Number)
 *   - undefined       -> null (TOON has no undefined)
 */
function normalizeForToon(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === undefined) return null;
  if (value === null) return null;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return value;
  if (t === 'bigint') return (value as bigint).toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return value.toString('base64');
  if (Array.isArray(value)) return value.map(v => normalizeForToon(v, seen));
  if (t === 'object') {
    if (seen.has(value as object)) return null;
    seen.add(value as object);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as object)) {
      out[k] = normalizeForToon(v, seen);
    }
    return out;
  }
  // Functions, symbols — drop to null.
  return null;
}

/**
 * Convert data to TOON (Token-Oriented Object Notation) format.
 * Uniform arrays of objects encode as a tabular block, which yields significantly
 * fewer LLM tokens than JSON for typical query result sets.
 */
export function convertToToon(data: unknown): string {
  return toonEncode(normalizeForToon(data));
}

/**
 * Convert data to CSV format
 * @param data Array of objects to convert to CSV
 * @returns CSV formatted string
 */
export function convertToCSV(data: any[]): string {
  if (data.length === 0) return '';
  if (!data[0] || typeof data[0] !== 'object') return '';

  // Get headers
  const headers = Object.keys(data[0]);
  
  // Create CSV header row
  let csv = headers.join(',') + '\n';
  
  // Add data rows
  data.forEach(row => {
    const values = headers.map(header => {
      const val = row[header];
      // Handle strings with commas, quotes, etc.
      if (typeof val === 'string') {
        return `"${val.replace(/"/g, '""')}"`;
      }
      // Use empty string for null/undefined
      return val === null || val === undefined ? '' : val;
    });
    csv += values.join(',') + '\n';
  });
  
  return csv;
}

/**
 * Format error response
 * @param error Error object or message
 * @returns Formatted error response object
 */
export function formatErrorResponse(error: Error | string): { content: Array<{type: string, text: string}>, isError: boolean } {
  const message = error instanceof Error ? error.message : error;
  return {
    content: [{ 
      type: "text", 
      text: JSON.stringify({ error: message }, null, 2) 
    }],
    isError: true
  };
}

/**
 * Format success response
 * @param data Data to format
 * @returns Formatted success response object
 */
export function formatSuccessResponse(data: any): { content: Array<{type: string, text: string}>, isError: boolean } {
  return {
    content: [{
      type: "text",
      text: JSON.stringify(data, null, 2)
    }],
    isError: false
  };
}

/**
 * Format success response using TOON encoding instead of JSON.
 * Use for large/uniform result sets where token efficiency matters.
 */
export function formatToonResponse(data: unknown): { content: Array<{type: string, text: string}>, isError: boolean } {
  return {
    content: [{
      type: "text",
      text: convertToToon(data),
    }],
    isError: false,
  };
}
