// Permanently red hyphenate fixture. Used to prove that an exhausted dyad becomes
// a real supervised abnormal exit and is parked for M4 re-architecture.
export default {
  lowercase: `def lower(s):\n    return s.lower()\n`,
  trim: `def trim(s):\n    return s.strip()\n`,
  hyphenate: `import re\n\ndef hyphenate(s):\n    s = re.sub(r"[^a-z0-9\\s-]", "", s.strip())\n    return s.replace(" ", "-")\n`,
  "string-utils": `from lowercase import lower\nfrom trim import trim\nfrom hyphenate import hyphenate\n\ndef slugify(s):\n    return hyphenate(trim(lower(s)))\n`,
};
