const TRAIT_DEFINITIONS = [
  {
    id: "gender:female",
    category: "gender",
    label: "女性",
    aliases: ["女", "女性", "女生", "女孩", "女博主", "女达人", "女网红", "女coser", "女cos", "美女", "female", "woman", "women", "girl", "girls"],
    positiveTerms: ["female", "woman", "women", "girl", "girls", "女性"],
    negativeTerms: ["male", "men", "boy", "boys", "guy", "guys", "男", "男性", "男生", "帅哥", "male coser", "male cosplay"],
    requireProfileEvidence: false,
    includePatterns: [
      /(?:^|[^a-z])(?:female|women|woman|girl|girls|she\/her|her\/she)(?:[^a-z]|$)/i,
      /#(?:female|women|woman|girl|girls)[a-z0-9_]*(?:cos|coser|cosplay|cosplayer)?/i,
      /(?:女性|女生|女孩|女士|美女|小姐姐|女博主|女达人|女网红|女主播)/,
      /女.{0,6}(?:cos|coser|cosplay|博主|达人|网红|主播)/i,
      /(?:cos|coser|cosplay|博主|达人|网红|主播).{0,6}女/i
    ],
    excludePatterns: [
      /(?:^|[^a-z])(?:male|men|boy|boys|guy|guys|he\/him|him\/he)(?:[^a-z]|$)/i,
      /#(?:male|men|boy|boys|guy|guys)[a-z0-9_]*(?:cos|coser|cosplay|cosplayer)?/i,
      /(?:男性|男生|男孩|男士|帅哥|小哥哥|男博主|男达人|男网红|男主播)/,
      /男.{0,6}(?:cos|coser|cosplay|博主|达人|网红|主播)/i,
      /(?:cos|coser|cosplay|博主|达人|网红|主播).{0,6}男/i
    ]
  },
  {
    id: "gender:male",
    category: "gender",
    label: "男性",
    aliases: ["男", "男性", "男生", "男孩", "男博主", "男达人", "男网红", "男coser", "男cos", "帅哥", "male", "man", "men", "boy", "boys", "guy", "guys"],
    positiveTerms: ["male", "man", "men", "boy", "boys", "男性"],
    negativeTerms: ["female", "women", "girl", "girls", "女", "女性", "女生", "美女", "female coser", "female cosplay"],
    requireProfileEvidence: false,
    includePatterns: [
      /(?:^|[^a-z])(?:male|men|boy|boys|guy|guys|he\/him|him\/he)(?:[^a-z]|$)/i,
      /#(?:male|men|boy|boys|guy|guys)[a-z0-9_]*(?:cos|coser|cosplay|cosplayer)?/i,
      /(?:男性|男生|男孩|男士|帅哥|小哥哥|男博主|男达人|男网红|男主播)/,
      /男.{0,6}(?:cos|coser|cosplay|博主|达人|网红|主播)/i,
      /(?:cos|coser|cosplay|博主|达人|网红|主播).{0,6}男/i
    ],
    excludePatterns: [
      /(?:^|[^a-z])(?:female|women|woman|girl|girls|she\/her|her\/she)(?:[^a-z]|$)/i,
      /#(?:female|women|woman|girl|girls)[a-z0-9_]*(?:cos|coser|cosplay|cosplayer)?/i,
      /(?:女性|女生|女孩|女士|美女|小姐姐|女博主|女达人|女网红|女主播)/,
      /女.{0,6}(?:cos|coser|cosplay|博主|达人|网红|主播)/i,
      /(?:cos|coser|cosplay|博主|达人|网红|主播).{0,6}女/i
    ]
  },
  {
    id: "region:asian",
    category: "region",
    label: "亚洲/亚裔",
    aliases: ["亚洲", "亚裔", "东亚", "东南亚", "日韩", "asian", "asia", "east asian", "southeast asian", "japanese", "korean", "chinese"],
    positiveTerms: ["asian", "asia", "east asian", "asian creator", "亚洲", "亚裔"],
    negativeTerms: ["european", "caucasian", "slavic", "russian", "ukrainian", "blonde", "white girl", "white woman", "欧洲", "欧美", "白人", "金发"],
    requireProfileEvidence: true,
    includePatterns: [
      /\b(?:asian|asia|east asian|southeast asian|japanese|korean|chinese|thai|vietnamese|filipina|filipino|malaysian|singaporean|indonesian)\b/i,
      /(?:亚洲|亚裔|东亚|东南亚|日韩|日系|韩系|中国|日本|韩国|泰国|越南|菲律宾|马来西亚|新加坡|印尼)/
    ],
    excludePatterns: [
      /\b(?:european|caucasian|slavic)\b/i,
      /\b(?:russian|ukrainian|french|german|italian|spanish|polish|swedish)\s+(?:girl|woman|female|coser|cosplay|cosplayer|creator|model)\b/i,
      /\b(?:girl|woman|female|coser|cosplay|cosplayer|creator|model)\s+(?:from\s+)?(?:europe|russia|ukraine|france|germany|italy|spain|poland|sweden)\b/i,
      /(?:欧洲|欧美|白人|金发|金髮|俄罗斯|乌克兰).{0,8}(?:女生|女孩|女性|美女|cos|coser|cosplay|博主|达人|网红|模特)/i,
      /(?:女生|女孩|女性|美女|cos|coser|cosplay|博主|达人|网红|模特).{0,8}(?:欧洲|欧美|白人|金发|金髮|俄罗斯|乌克兰)/i
    ]
  }
];

const NEUTRAL_CONSTRAINT_PATTERN = /不限性别|性别不限|男女不限|不限男女|不限地区|地区不限|不限人种|人群不限|all genders|any gender|gender neutral|all regions|any region|any ethnicity|all ethnicities/i;

export function extractBasicTraitConstraints(briefInput = {}, filters = {}) {
  const explicit = normalizeExplicitTraits([
    ...(Array.isArray(filters.requiredTraits) ? filters.requiredTraits : String(filters.requiredTraits || "").split(/[,\s，、/|;；]+/)),
    ...(Array.isArray(filters.basicTraits) ? filters.basicTraits : String(filters.basicTraits || "").split(/[,\s，、/|;；]+/)),
    filters.requiredGender,
    filters.requiredRegion,
    filters.requiredRegionGroup
  ]);
  if (explicit.length) return dedupeConstraints(explicit);

  const rawText = [
    briefInput.rawText,
    ...(briefInput.creatorKeywords || [])
  ].filter(Boolean).join(" ");
  if (NEUTRAL_CONSTRAINT_PATTERN.test(rawText)) return [];

  return dedupeConstraints(TRAIT_DEFINITIONS.filter((definition) => matchesAnyAlias(rawText, definition.aliases)));
}

export function buildTraitSearchTerms(constraints = []) {
  return {
    positiveTerms: unique(constraints.flatMap((constraint) => constraint.positiveTerms || [])),
    negativeTerms: unique(constraints.flatMap((constraint) => constraint.negativeTerms || []))
  };
}

export function validateBasicTraitConstraints(creator = {}, constraints = []) {
  for (const constraint of constraints || []) {
    const broadText = buildBroadEvidenceText(creator);
    const profileText = buildProfileEvidenceText(creator);

    if (matchesAnyPattern(broadText, constraint.excludePatterns)) {
      return {
        reason: `基础特征不匹配：${constraint.label || "未知特征"}`,
        traitId: constraint.id,
        category: constraint.category
      };
    }

    if (constraint.requireProfileEvidence && !matchesAnyPattern(profileText, constraint.includePatterns)) {
      return {
        reason: `基础特征证据不足：${constraint.label || "未知特征"}`,
        traitId: constraint.id,
        category: constraint.category
      };
    }
  }

  return null;
}

export function serializeBasicTraitConstraints(constraints = []) {
  return (constraints || []).map((constraint) => ({
    id: constraint.id,
    category: constraint.category,
    label: constraint.label,
    requireProfileEvidence: Boolean(constraint.requireProfileEvidence)
  }));
}

function normalizeExplicitTraits(values) {
  const ids = Array.isArray(values) ? values : String(values || "").split(/[,\s，、/|;；]+/);
  return ids
    .map((id) => TRAIT_DEFINITIONS.find((definition) => definition.id === id || definition.aliases.includes(String(id || "").toLowerCase())))
    .filter(Boolean);
}

function matchesAnyAlias(text, aliases = []) {
  const value = String(text || "").toLowerCase();
  return aliases.some((alias) => hasTerm(value, alias));
}

function hasTerm(text, term) {
  const value = String(term || "").toLowerCase();
  if (!value) return false;
  if (/[\u4e00-\u9fff]/.test(value)) return text.includes(value);
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(value)}([^a-z0-9]|$)`, "i").test(text);
}

function matchesAnyPattern(text, patterns = []) {
  return patterns.some((pattern) => pattern.test(String(text || "")));
}

function buildBroadEvidenceText(creator = {}) {
  return [
    creator.name,
    creator.handle,
    creator.bio,
    creator.discovery?.summary,
    creator.discovery?.evidenceText,
    ...(creator.tags || [])
  ].join(" ");
}

function buildProfileEvidenceText(creator = {}) {
  const tags = creator.discovery?.kind === "web-search" ? [] : creator.tags || [];
  return [
    creator.name,
    creator.handle,
    creator.bio,
    ...tags
  ].join(" ");
}

function dedupeConstraints(constraints = []) {
  const byCategory = new Map();
  for (const constraint of constraints) {
    if (!constraint?.id || byCategory.has(constraint.category)) continue;
    byCategory.set(constraint.category, constraint);
  }
  return [...byCategory.values()];
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map((value) => String(value).toLowerCase()))];
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const __testing = {
  extractBasicTraitConstraints,
  validateBasicTraitConstraints
};
