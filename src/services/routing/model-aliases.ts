/**
 * Model Name Normalization
 *
 * Maps model names with date suffixes (e.g., claude-sonnet-4-5-20250929) to standard names
 * (e.g., claude-sonnet-4-5-thinking) for routing decisions.
 *
 * This enables Claude Code and other clients that send date-suffixed model names to work
 * correctly with anti-api's routing system.
 */

// Static alias mapping table (based on Antigravity-Manager's model_mapping.rs)
const MODEL_ALIASES: Record<string, string> = {
  // Claude 4.5 series with date suffixes
  'claude-sonnet-4-5-20250929': 'claude-sonnet-4-5-thinking',
  'claude-haiku-4-5-20251001': 'claude-haiku-4-5',
  'claude-opus-4-5-20251101': 'claude-opus-4-5-thinking',

  // Claude 3.5 series aliases
  'claude-3-5-sonnet-20241022': 'claude-sonnet-4-5',
  'claude-3-5-sonnet-20240620': 'claude-sonnet-4-5',
  'claude-3-haiku-20240307': 'claude-haiku-4-5',

  // Generic aliases
  'claude-opus-4': 'claude-opus-4-5-thinking',
  'claude-haiku-4': 'claude-haiku-4-5',
}

/**
 * Normalizes model names by mapping aliases to standard model names.
 *
 * This function:
 * 1. Checks for exact matches in the alias table
 * 2. Applies wildcard pattern matching for date-suffixed models
 * 3. Returns the original name if no match is found (backward compatible)
 *
 * @param modelName - The model name to normalize (e.g., "claude-sonnet-4-5-20250929")
 * @returns The normalized model name (e.g., "claude-sonnet-4-5-thinking")
 */
export function normalizeModelName(modelName: string): string {
  // 1. Check exact match in alias table
  const alias = MODEL_ALIASES[modelName]
  if (alias) {
    return alias
  }

  // 2. Wildcard pattern matching: claude-*-YYYYMMDD -> remove date suffix
  // Matches patterns like: claude-sonnet-4-5-20250929, claude-haiku-4-5-20251001
  const datePattern = /^(claude-(?:sonnet|opus|haiku)-\d+-\d+)-\d{8}$/
  const match = modelName.match(datePattern)
  if (match) {
    return match[1] // Return the part without the date suffix
  }

  // 3. No match found - return original name (backward compatible)
  return modelName
}
