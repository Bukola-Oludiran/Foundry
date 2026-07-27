// Stub "LLM outputs" for the string-utils spec, keyed by node id. Feeds the pi-pool's
// StubLlm so the whole build runs with zero spend. Raw code (no fences) — the doer's
// extractCode handles either. At M5 a real provider replaces this entirely.
export default {
  lowercase: `def lower(s):
    return s.lower()
`,
  trim: `def trim(s):
    return s.strip()
`,
  hyphenate: `import re

def hyphenate(s):
    s = re.sub(r"\\s+", "-", s.strip())
    s = re.sub(r"[^a-z0-9-]", "", s)
    s = re.sub(r"-+", "-", s).strip("-")
    return s
`,
  "string-utils": `from lowercase import lower
from trim import trim
from hyphenate import hyphenate

def slugify(s):
    return hyphenate(trim(lower(s)))
`,
};
