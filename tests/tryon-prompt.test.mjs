import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BUILTIN_GARMENT_DETAILS,
  COMMON_TRYON_RULES,
  PROMPT_VERSION,
  REPLACE_OUTFIT_RULE,
  composeBuiltinOutfitPrompt,
  composeCatalogGarmentPrompt,
  composeUploadedGarmentPrompt,
  composeTryonPrompt
} from '../server/tryon-prompt.mjs';

// The fixture contains catalog metadata only, so tests run without the original models.
const manifest = JSON.parse(readFileSync(new URL('./fixtures/builtin-garment-manifest.json', import.meta.url), 'utf8'));
const expectedPromptLengths = {
  'maid-lolita': 684,
  'fantasy-outfit-07': 650,
  'hanfu-guofeng': 634,
  'hanfu-ink': 670,
  'hanfu-flower': 649,
  'hanfu-phoenix': 625,
  'hanfu-gufeng1': 633,
  'hanfu-gufeng3': 657,
  'kimono-003': 649,
  'kimono-001': 688,
  'kimono-base': 632,
  hakama: 644,
  'hanfu-asian': 663,
  'hanfu-gufeng4': 670,
  'hanfu-yusheng': 635
};

test('all 15 existing GLB IDs map to clothing-only descriptions and the reviewed single-composition prompts', () => {
  assert.equal(PROMPT_VERSION, 5);
  assert.equal(manifest.length, 20);
  const existingGlb=manifest.filter(item=>item.assetType!=='2d');
  assert.equal(existingGlb.length,15);
  assert.deepEqual(new Set(existingGlb.map(item => item.id)), new Set(Object.keys(BUILTIN_GARMENT_DETAILS)));
  assert.equal(new Set(Object.values(BUILTIN_GARMENT_DETAILS)).size, 15);
  for (const item of existingGlb) {
    assert.equal(item.category, 'outfit');
    assert.equal(item.details, BUILTIN_GARMENT_DETAILS[item.id]);
    assert.ok(item.details.length <= 350, `${item.id} details exceed field limit`);
    const prompt = composeTryonPrompt({garmentId:item.id,category:'outfit',categoryKnown:true,details:item.details});
    assert.equal(prompt.length, expectedPromptLengths[item.id], `${item.id} prompt length changed`);
    assert.equal(prompt.split(COMMON_TRYON_RULES).length - 1, 1, `${item.id} duplicated common rule`);
    assert.equal(prompt.split(REPLACE_OUTFIT_RULE).length - 1, 1, `${item.id} duplicated replacement rule`);
    assert.equal(prompt.split('Substitute the outfit with').length - 1, 1, `${item.id} duplicated action`);
    assert.doesNotMatch(prompt, /Garment details:/);
  }
});

test('five image-only catalog garments use trusted top replacement plus their own visual details',()=>{
  const items=manifest.filter(item=>item.assetType==='2d');assert.equal(items.length,5);
  for(const item of items){
    assert.equal(item.category,'top');assert.ok(item.details.length<=350);
    const prompt=composeTryonPrompt({garmentId:item.id,category:item.category,categoryKnown:true,details:item.details});
    assert.match(prompt,/^Substitute the upper body garment/);assert.ok(prompt.includes(`Specific reference garment details: ${item.details}`));assert.equal(prompt.split(COMMON_TRYON_RULES).length-1,1);assert.ok(prompt.length<=700,`${item.id} prompt exceeds limit`);
  }
});

test('uploaded clothing uses separate trusted-category templates and an explicit unknown fallback', () => {
  const top = composeUploadedGarmentPrompt('top');
  assert.match(top, /^Substitute the upper body garment/);
  assert.match(top, /retain the existing innerwear/);
  assert.match(top, /Keep lower body clothing unchanged/);
  const bottom = composeUploadedGarmentPrompt('bottom');
  assert.match(bottom, /^Substitute the lower body garment/);
  assert.match(bottom, /Keep the upper body clothing unchanged/);
  const outfit = composeUploadedGarmentPrompt('outfit');
  assert.match(outfit, /^Substitute the outfit/);
  assert.match(outfit, /Replace the shown inner and outer layers together/);
  const accessory = composeUploadedGarmentPrompt('accessory');
  assert.match(accessory, /^Add the single accessory/);
  assert.match(accessory, /Keep the existing clothing unchanged/);
  const unknown = composeUploadedGarmentPrompt(undefined);
  assert.match(unknown, /^Substitute only the clothing region represented by the reference/);
  assert.match(unknown, /Leave other clothing unchanged/);
  assert.equal(unknown.length, 642);
  for (const prompt of [top,bottom,outfit,accessory,unknown]) {
    assert.ok(prompt.length <= 700);
    assert.equal(prompt.split(COMMON_TRYON_RULES).length - 1, 1);
  }
});

test('server uses catalog details for built-ins and does not treat a default upload category as known', () => {
  assert.match(composeTryonPrompt({garmentId:'fantasy-outfit-07'}), /light-gray long robe with short outer sleeves/);
  assert.match(composeTryonPrompt({garmentId:'upload-1',category:'outfit',categoryKnown:false}), /^Substitute only the clothing region/);
  assert.match(composeTryonPrompt({garmentId:'upload-1',category:'top',categoryKnown:true}), /^Substitute the upper body garment/);
  assert.match(composeTryonPrompt({garmentId:'upload-1',category:'forged',categoryKnown:true}), /^Substitute only the clothing region/);
  assert.match(composeTryonPrompt({garmentId:'upload-1',category:'bottom',categoryKnown:false}), /^Substitute only the clothing region/);
});

test('description and complete prompt limits fail explicitly instead of truncating or duplicating', () => {
  assert.throws(() => composeBuiltinOutfitPrompt('x'.repeat(351)), /350/);
  assert.throws(() => composeCatalogGarmentPrompt('top','x'.repeat(350)), /700/);
  assert.throws(() => composeBuiltinOutfitPrompt('x'.repeat(350)), /700/);
  assert.throws(() => composeBuiltinOutfitPrompt(`Substitute the outfit with ${BUILTIN_GARMENT_DETAILS['hanfu-ink']}`), /只能保存服装描述/);
  assert.throws(() => composeBuiltinOutfitPrompt(`${BUILTIN_GARMENT_DETAILS['hanfu-ink']} ${COMMON_TRYON_RULES}`), /只能保存服装描述/);
});

test('every catalog and uploaded prompt preserves input appearance without suggesting new eyewear', () => {
  const prompts = manifest.map(item => composeTryonPrompt({garmentId:item.id,category:item.category,categoryKnown:true,details:item.details}));
  prompts.push(...['top','bottom','outfit','accessory',null].map(composeUploadedGarmentPrompt));
  for (const prompt of prompts) {
    assert.match(prompt, /^(?:Substitute|Add) /, 'the garment action remains first');
    assert.equal(prompt.split(COMMON_TRYON_RULES).length - 1, 1);
    assert.match(prompt, /Edit only the specified clothing or accessory\./);
    assert.match(prompt, /Preserve input identity, face, expression, hairstyle, skin tone, build and existing accessories\./);
    assert.match(prompt, /Do not add glasses or reshape the face or hair\./);
    assert.match(prompt, /Follow input motion/);
    assert.match(prompt, /Keep hidden faces hidden; invent no person in dark or empty input\./);
    assert.doesNotMatch(prompt, /hair, glasses, skin tone/);
    assert.ok(prompt.length <= 700);
  }
  assert.equal(Math.max(...prompts.map(prompt => prompt.length)), 688);
});

test('legacy version 4 rules cannot be saved as garment details and combined with version 5', () => {
  const oldRule = "Keep the input person's identity, face, expression, hair, glasses, skin tone and build consistent through turns. Follow input motion with natural folds and occlusion. Preserve hands, background and lighting. Keep hidden faces hidden; invent no person in dark or empty input. Use the reference for clothing only.";
  for (const details of [oldRule, `a gray coat. ${oldRule}`, `Substitute the outfit with a gray coat. ${oldRule}`]) {
    assert.throws(() => composeBuiltinOutfitPrompt(details), /只能保存服装描述/);
    assert.throws(() => composeCatalogGarmentPrompt('top', details), /只能保存服装描述/);
  }
});
