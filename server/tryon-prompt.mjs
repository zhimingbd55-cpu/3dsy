export const PROMPT_VERSION = 5;
// Prompt composition can evolve without reapplying the one-time catalog data migration.
export const BUILTIN_DETAILS_MIGRATION_VERSION = 3;

export const BUILTIN_GARMENT_DETAILS = Object.freeze({
  'maid-lolita': 'a black maid Lolita dress with puffed shoulders, fitted long sleeves, a white pointed collar and ruffled buttoned bib with red piping, burgundy neck bow, white cuffs and ruffled apron, and a full skirt with white frills and red-edged white bands.',
  'fantasy-outfit-07': 'a light-gray long robe with short outer sleeves, a white crossed inner collar, full white gathered sleeves, gray tied cuffs, a broad wrapped gray sash and split long front panels over a pleated white lower layer.',
  'hanfu-guofeng': 'a coral-pink top with a white-edged crossed neckline and very wide flared sleeves, paired with a pale sage-green chest-high long skirt, a pale floral chest band and two long dark-green front ties.',
  'hanfu-ink': 'an ivory open-front robe with wide hanging sleeves and thin dark edging, a gray square-neck cropped inner top with a small central opening, and an ivory high-waisted skirt with fine gray swirling wave patterns and gray hanging ties.',
  'hanfu-flower': 'a pale-pink Hanfu dress with wide flared sleeves, coral crossed collar and cuff bands bearing white flowers and thin gold edging, a matching floral waist band, a coral front bow and a softly gathered pink skirt.',
  'hanfu-phoenix': 'a pink open-front long robe with very long hanging sleeves bearing large pale-gold phoenix motifs, pale-gold floral edging, a pink waist bow and a matching pink straight-neck inner dress.',
  'hanfu-gufeng1': 'a pale lavender-white open-front robe with layered wide sleeves and thin gray-purple edging, a plain gray straight-neck inner top, and a plain ivory high-waisted long skirt with a pale waist tie.',
  'hanfu-gufeng3': 'an ivory open outer robe with blue floral and butterfly motifs, wide hanging sleeves and pink sleeve ties, over a pale-pink crossed-collar inner robe with a white collar, a broad blue-gray waist band and slim pink ties.',
  'kimono-003': 'a muted gray-green wrap kimono with a pale inner collar, broad sleeves and ivory flowering-branch motifs, held closed by a wide taupe floral obi and a thin pale front cord; preserve the uneven pattern placement.',
  'kimono-001': 'a charcoal open robe with broad asymmetric sleeves, one muted-rose sleeve panel, black-and-white wave-patterned edging and lower panels with small red accents, over a charcoal rose-trimmed crossed-collar inner top and matching patterned lower layers.',
  'kimono-base': 'a plain white wrap kimono with layered crossed collars, very wide hanging sleeves, a broad white wrapped waist sash and long white hanging ties; keep the fabric unpatterned and the front closed.',
  hakama: 'a coral-pink crossed-collar kimono top with large hanging sleeves and white floral and bird motifs, a pale inner collar, a peach front-bow sash, and high-waisted gray-green hakama with deep vertical pleats.',
  'hanfu-asian': 'a plain white crossed-collar top with broad rounded hanging sleeves and pale-gray collar edging, a wide light-gray wrapped sash with a front tie, and a light-gray pleated lower layer with white edging over a white underlayer.',
  'hanfu-gufeng4': 'a mint-blue round-neck top with a small central floral motif and coral sleeve bands, white fitted inner sleeves with coral cuffs, a blue-green sash with long ties, a coral-and-cream vertically paneled skirt and a sheer floral drape.',
  'hanfu-yusheng': 'an ivory crossed-collar top with loose gathered sleeves and a central bird-and-flower motif, paired with a muted teal pleated skirt bearing horizontal floral bands and two long ivory front ribbons.'
});

export const COMMON_TRYON_RULES = 'Edit only the specified clothing or accessory. Preserve input identity, face, expression, hairstyle, skin tone, build and existing accessories. Do not add glasses or reshape the face or hair. Follow input motion; keep hands, background and lighting. Keep hidden faces hidden; invent no person in dark or empty input.';
// Runtime rules change independently of saved garment descriptions. Reject an old
// full rule too, rather than accepting it as garment detail and appending v5.
const LEGACY_COMMON_TRYON_RULES = Object.freeze([
  'Keep the input person\'s identity, face, expression, hair, glasses, skin tone and build consistent through turns. Follow input motion with natural folds and occlusion. Preserve hands, background and lighting. Keep hidden faces hidden; invent no person in dark or empty input. Use the reference for clothing only.'
]);
export const REPLACE_OUTFIT_RULE = 'Replace the original inner layers and collar too; retain only logos visible in the reference.';

const UPLOADED_GARMENT_ACTIONS = Object.freeze({
  top: 'Substitute the upper body garment with the clothing in the reference. Match its visible colors, cut, neckline, sleeves and patterns. Replace all upper layers shown; for a single open outer garment, retain the existing innerwear. Keep lower body clothing unchanged.',
  bottom: 'Substitute the lower body garment with the clothing in the reference. Match its visible color, waistband, cut, length, pleats and pattern. Keep the upper body clothing unchanged.',
  outfit: 'Substitute the outfit with the clothing in the reference. Match its visible colors, cut, collars, sleeves, layers, waist details and patterns. Replace the shown inner and outer layers together; retain only logos visible in the reference.',
  accessory: 'Add the single accessory shown in the reference at its proper worn position. Match its visible color, shape and details. Keep the existing clothing unchanged.'
});
const CATALOG_GARMENT_ACTIONS = Object.freeze({
  top: 'Substitute the upper body garment using the reference. Match the details below; replace the visible original collar and graphics, and keep lower-body clothing unchanged.',
  bottom: 'Substitute the lower body garment using the reference. Match the details below and keep upper-body clothing unchanged.',
  accessory: 'Add the accessory shown in the reference at its proper worn position. Match the details below and keep clothing unchanged.'
});
const UPLOAD_UNKNOWN_CATEGORY_ACTION = 'Substitute only the clothing region represented by the reference. Match its visible colors, cut, neckline, sleeves, fastenings and patterns. For a complete outfit, replace its shown inner and outer layers; for a single open outer garment, replace only that layer and retain existing innerwear. Leave other clothing unchanged.';

function checkedDetails(details) {
  const description = String(details ?? '').trim();
  if (!description) throw new Error('该内置服装尚未配置专属描述。');
  if (/^(?:Substitute|Completely replace|Add the accessory)\b/i.test(description)
    || description.includes(COMMON_TRYON_RULES)
    || LEGACY_COMMON_TRYON_RULES.some(rule => description.includes(rule))
    || description.includes(REPLACE_OUTFIT_RULE)) {
    throw new Error('服装细节字段只能保存服装描述，不能包含完整提示词或公共规则。');
  }
  if (description.length > 350) throw new RangeError('服装细节描述不能超过 350 个字符。');
  return description;
}

export function composeBuiltinOutfitPrompt(details) {
  const description = checkedDetails(details);
  const prompt = [`Substitute the outfit with ${description}`, REPLACE_OUTFIT_RULE, COMMON_TRYON_RULES].join(' ');
  if (prompt.length > 700) throw new RangeError('完整试衣提示词超过 700 个字符，请缩短服装描述。');
  return prompt;
}

export function composeUploadedGarmentPrompt(trustedCategory) {
  const action = Object.hasOwn(UPLOADED_GARMENT_ACTIONS, trustedCategory)
    ? UPLOADED_GARMENT_ACTIONS[trustedCategory]
    : UPLOAD_UNKNOWN_CATEGORY_ACTION;
  const prompt = `${action} ${COMMON_TRYON_RULES}`;
  if (prompt.length > 700) throw new RangeError('完整试衣提示词超过 700 个字符。');
  return prompt;
}

export function composeCatalogGarmentPrompt(trustedCategory, details) {
  const action = Object.hasOwn(CATALOG_GARMENT_ACTIONS, trustedCategory)
    ? CATALOG_GARMENT_ACTIONS[trustedCategory]
    : UPLOAD_UNKNOWN_CATEGORY_ACTION;
  const description = checkedDetails(details);
  const prompt = `${action} Specific reference garment details: ${description} ${COMMON_TRYON_RULES}`;
  if (prompt.length > 700) throw new RangeError('完整试衣提示词超过 700 个字符，请缩短服装描述。');
  return prompt;
}

export function composeTryonPrompt({ garmentId, ownerId = null, category, categoryKnown = false, details = '' } = {}) {
  if (ownerId == null && Object.hasOwn(BUILTIN_GARMENT_DETAILS, garmentId)) {
    return composeBuiltinOutfitPrompt(String(details || '').trim() || BUILTIN_GARMENT_DETAILS[garmentId]);
  }
  if (ownerId == null && categoryKnown === true && category !== 'outfit' && String(details || '').trim()) {
    return composeCatalogGarmentPrompt(category,String(details).trim());
  }
  return composeUploadedGarmentPrompt(categoryKnown === true ? category : null);
}
