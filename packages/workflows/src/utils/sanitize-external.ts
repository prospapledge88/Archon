/**
 * Sanitize untrusted external content before injection into workflow prompts.
 *
 * Two-layer defense:
 * 1. Deterministic pattern stripping — remove known injection patterns
 * 2. XML trust boundary wrapping — mark content as untrusted data
 *
 * Applied to $CONTEXT, $ISSUE_CONTEXT, and $EXTERNAL_CONTEXT only.
 * Not applied to $ARGUMENTS (user-typed) or $nodeId.output (internally generated).
 */
// ─── Types ──────────────────────────────────────────────────────────────────

export interface StrippedPattern {
  category: 'role_marker' | 'turn_delimiter' | 'instruction_override' | 'boundary_breaker';
  matched: string;
  position: number;
}

export interface SanitizeResult {
  sanitized: string;
  strippedPatterns: StrippedPattern[];
}

// ─── Pattern Definitions ────────────────────────────────────────────────────

interface PatternDef {
  category: StrippedPattern['category'];
  pattern: RegExp;
}

const INJECTION_PATTERNS: PatternDef[] = [
  // LLM role markers
  { category: 'role_marker', pattern: /<\|(?:system|assistant|user|im_start|im_end)\|>/gi },
  { category: 'role_marker', pattern: /\[INST\]/gi },
  { category: 'role_marker', pattern: /\[\/INST\]/gi },
  { category: 'role_marker', pattern: /<<SYS>>/gi },
  { category: 'role_marker', pattern: /<< *\/SYS *>>/gi },

  // Anthropic turn delimiters
  { category: 'turn_delimiter', pattern: /\n\n(?:Human|Assistant):/g },
  { category: 'turn_delimiter', pattern: /<\/(?:Human|Assistant)>/gi },

  // Instruction overrides (word-boundary-aware phrase match)
  { category: 'instruction_override', pattern: /\bignore previous instructions\b/gi },
  { category: 'instruction_override', pattern: /\bignore all instructions\b/gi },
  { category: 'instruction_override', pattern: /\bignore all prior instructions\b/gi },
  { category: 'instruction_override', pattern: /\bdisregard the above\b/gi },
  { category: 'instruction_override', pattern: /\bdisregard all previous\b/gi },
  { category: 'instruction_override', pattern: /\bforget everything above\b/gi },
  { category: 'instruction_override', pattern: /\bforget all previous\b/gi },
  { category: 'instruction_override', pattern: /\byou are now\b/gi },
  { category: 'instruction_override', pattern: /\bnew instructions:/gi },
  { category: 'instruction_override', pattern: /\bsystem prompt:/gi },
  { category: 'instruction_override', pattern: /\boverride:/gi },

  // Trust boundary breakers — closing tags that match our Layer 2 wrapper
  { category: 'boundary_breaker', pattern: /<\/external_context>/gi },
];

// ─── Layer 1: Pattern Stripping ─────────────────────────────────────────────

/**
 * Strip known injection patterns from untrusted content.
 * Returns the sanitized string and details of what was stripped.
 */
export function stripInjectionPatterns(content: string): SanitizeResult {
  const strippedPatterns: StrippedPattern[] = [];
  let sanitized = content;

  // Phase 1: Scan original content for all matches (positions relative to original input)
  for (const def of INJECTION_PATTERNS) {
    const regex = new RegExp(def.pattern.source, def.pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      strippedPatterns.push({
        category: def.category,
        matched: match[0],
        position: match.index,
      });
    }
  }

  // Phase 2: Strip patterns from the working copy (fresh regex per pattern)
  for (const def of INJECTION_PATTERNS) {
    sanitized = sanitized.replace(new RegExp(def.pattern.source, def.pattern.flags), '');
  }

  return { sanitized, strippedPatterns };
}
