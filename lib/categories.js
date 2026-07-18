/**
 * Agent categories for UI grouping.
 * Stored optionally as frontmatter `category`.
 * Pi runtime ignores unknown frontmatter keys, so this is safe.
 */

const CATEGORIES = [
  { id: 'dev', label: '开发', order: 1, color: '#5aa2ff' },
  { id: 'research', label: '研究', order: 2, color: '#3fb950' },
  { id: 'debug', label: '调试', order: 3, color: '#ffb454' },
  { id: 'consultant', label: '顾问', order: 4, color: '#c084fc' },
  { id: 'other', label: '其他', order: 9, color: '#8b98a9' },
];

const CATEGORY_IDS = new Set(CATEGORIES.map((c) => c.id));

/**
 * Infer category from agent name when frontmatter has no category.
 * @param {string} name
 * @returns {string}
 */
function inferCategory(name) {
  const n = String(name || '').toLowerCase();
  if (n.startsWith('research-') || n.includes('research')) return 'research';
  if (n.startsWith('debug-') || n.includes('debug') || n.includes('investigat')) return 'debug';
  if (n === 'consultant' || n.startsWith('consult')) return 'consultant';
  if (
    n.startsWith('dev-') ||
    n.endsWith('-planner') ||
    n.endsWith('-worker') ||
    n.endsWith('-reviewer') ||
    n.includes('glm-planner')
  ) {
    // research-planner already caught above
    if (n.startsWith('research-')) return 'research';
    return 'dev';
  }
  return 'other';
}

/**
 * Resolve category: explicit frontmatter > inference.
 * @param {string} name
 * @param {string} [explicit]
 */
function resolveCategory(name, explicit) {
  const e = (explicit || '').trim().toLowerCase();
  if (e && CATEGORY_IDS.has(e)) return e;
  // allow Chinese labels written by hand
  const byLabel = CATEGORIES.find((c) => c.label === (explicit || '').trim());
  if (byLabel) return byLabel.id;
  return inferCategory(name);
}

function getCategoryMeta(id) {
  return CATEGORIES.find((c) => c.id === id) || CATEGORIES.find((c) => c.id === 'other');
}

module.exports = {
  CATEGORIES,
  CATEGORY_IDS,
  inferCategory,
  resolveCategory,
  getCategoryMeta,
};
