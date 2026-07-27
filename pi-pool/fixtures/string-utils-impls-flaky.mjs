// Like string-utils-impls.mjs, but `hyphenate` ships a BUGGY first draft (attempt 1)
// and a correct fix on attempt 2+. Exercises the host's node-level retry-with-feedback:
// the tester rejects the first draft, the doer "uses the feedback", and it converges.
export default {
  lowercase: `def lower(s):\n    return s.lower()\n`,
  trim: `def trim(s):\n    return s.strip()\n`,
  hyphenate: [
    // attempt 1 — BUG: does not collapse internal whitespace runs.
    `import re\n\ndef hyphenate(s):\n    s = re.sub(r"[^a-z0-9\\s-]", "", s.strip())\n    return s.replace(" ", "-")\n`,
    // attempt 2+ — correct.
    `import re\n\ndef hyphenate(s):\n    s = re.sub(r"\\s+", "-", s.strip())\n    s = re.sub(r"[^a-z0-9-]", "", s)\n    s = re.sub(r"-+", "-", s).strip("-")\n    return s\n`,
  ],
  "string-utils": `from lowercase import lower\nfrom trim import trim\nfrom hyphenate import hyphenate\n\ndef slugify(s):\n    return hyphenate(trim(lower(s)))\n`,
};
