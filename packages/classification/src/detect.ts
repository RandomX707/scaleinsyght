// Sensitivity detection for profiled columns (decision 41). Declared tags from the source (a column comment,
// an extended property, a workbook header note) are always kept. The detector can only ADD tags from the
// column name and the format of sampled values; it never removes a declared tag, so it can only increase
// what is withheld. The model boundary itself still enforces tags (contract 7). Rules are industry-neutral:
// identifier codes are recognised by their format, not by industry vocabulary.
export type SensitivityTag = 'personal' | 'regulated' | 'identifier';
export interface SensitivityEvidence { tag: string; detection: 'declared' | 'inferred'; reason: string }
export type SampleValue = string | number | boolean | Date | null;

const tokensOf = (text: string) => text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

const nameRules: Array<{ tag: SensitivityTag; reason: string; test: (joined: string, tokens: string[]) => boolean }> = [
  { tag: 'personal', reason: "the column name describes a person's name", test: (joined) => ['name', 'full_name', 'first_name', 'last_name', 'given_name', 'family_name', 'surname', 'middle_name', 'maiden_name'].includes(joined) },
  { tag: 'regulated', reason: 'the column name describes a date of birth', test: (joined, tokens) => /(^|_)(date_of_birth|birth_date|birthdate|birthday|dob)($|_)/.test(joined) || (tokens.includes('birth') && tokens.includes('date')) },
  { tag: 'personal', reason: 'the column name describes a phone number', test: (_joined, tokens) => tokens.some((token) => ['phone', 'telephone', 'mobile', 'fax'].includes(token)) },
  { tag: 'personal', reason: 'the column name describes an email address', test: (joined, tokens) => tokens.includes('email') || joined.includes('e_mail') },
  { tag: 'identifier', reason: 'the column name describes a government or account identifier', test: (joined) => /(^|_)(ssn|social_security|national_id|national_insurance|passport|tax_id|tin)($|_)/.test(joined) },
];

const phonePattern = /^\+?\d[\d\s().-]{5,18}\d$/;
const emailPattern = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const identifierCodePattern = /^[A-Za-z]{2,6}[-_]?\d{4,}$/;

function share(values: string[], test: (value: string) => boolean): number {
  return values.length ? values.filter(test).length / values.length : 0;
}

export function classifyColumn(input: { name: string; label?: string; declaredTags: string[]; sample?: SampleValue[] }): { tags: string[]; evidence: SensitivityEvidence[] } {
  const evidence: SensitivityEvidence[] = input.declaredTags.map((tag) => ({ tag, detection: 'declared', reason: 'declared by the source' }));
  const add = (tag: SensitivityTag, reason: string) => { if (!evidence.some((item) => item.tag === tag)) evidence.push({ tag, detection: 'inferred', reason }); };
  for (const text of [input.name, input.label ?? '']) {
    const tokens = tokensOf(text); if (!tokens.length) continue;
    const joined = tokens.join('_');
    for (const rule of nameRules) if (rule.test(joined, tokens)) add(rule.tag, rule.reason);
  }
  const values = (input.sample ?? []).filter((value): value is string => typeof value === 'string').map((value) => value.trim()).filter(Boolean);
  if (values.length >= 20) {
    const digits = (value: string) => value.replace(/\D/g, '').length;
    if (share(values, (value) => phonePattern.test(value) && /[\s().+-]/.test(value) && digits(value) >= 7 && digits(value) <= 15) >= 0.8) add('personal', 'the values are formatted like phone numbers');
    if (share(values, (value) => emailPattern.test(value)) >= 0.8) add('personal', 'the values are formatted like email addresses');
    if (share(values, (value) => identifierCodePattern.test(value)) >= 0.95 && new Set(values).size / values.length >= 0.9) add('identifier', 'the values are unique codes of letters followed by digits, the shape of a record identifier');
  }
  return { tags: [...new Set(evidence.map((item) => item.tag))], evidence };
}
