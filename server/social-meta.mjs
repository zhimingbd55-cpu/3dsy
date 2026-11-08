// Link-preview hints are readable without JavaScript. They are not a WeChat
// JS-SDK configuration and cannot force a client's card or Moments layout.
const START='<!-- share-metadata:start -->',END='<!-- share-metadata:end -->';
const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export function socialMetadata(origin,pagePath='/'){
  const base=new URL(origin);
  if(!['https:','http:'].includes(base.protocol)||base.username||base.password)throw new Error('Invalid public origin');
  const valid=pagePath==='/'||/^\/a\/[A-Za-z0-9_-]{1,80}$/.test(pagePath)||/^\/s\/[A-Za-z0-9_-]{40,60}$/.test(pagePath);
  if(!valid)throw new Error('Invalid preview path');
  const shared=pagePath.startsWith('/s/');
  return {title:shared?'1➕衣｜我的试穿对比':'1➕衣｜今天，换个样',description:shared?'原视频与试穿成片，点开一起看。':'一键试穿不同穿搭，看看你的新样子。',url:new URL(pagePath,base.origin).href,image:new URL('/brand/share-thumb.png',base.origin).href,cardImage:new URL('/brand/share-card.png',base.origin).href};
}
export function renderSocialMetadata(html,origin,pagePath='/'){
  const data=socialMetadata(origin,pagePath);
  const meta=(key,value,attribute='property')=>`<meta ${attribute}="${key}" content="${escape(value)}" />`;
  const block=[START,`<title>${escape(data.title)}</title>`,meta('description',data.description,'name'),
    meta('og:site_name','1➕衣'),meta('og:locale','zh_CN'),meta('og:type','website'),meta('og:title',data.title),meta('og:description',data.description),meta('og:url',data.url),meta('og:image',data.image),meta('og:image:type','image/png'),meta('og:image:width','512'),meta('og:image:height','512'),meta('og:image:alt','1➕衣品牌标志'),
    meta('twitter:card','summary_large_image','name'),meta('twitter:title',data.title,'name'),meta('twitter:description',data.description,'name'),meta('twitter:image',data.cardImage,'name'),meta('twitter:image:alt','1➕衣，今天换个样','name'),
    meta('name',data.title,'itemprop'),meta('description',data.description,'itemprop'),meta('image',data.image,'itemprop'),`<link rel="image_src" href="${escape(data.image)}" />`,`<link rel="canonical" href="${escape(data.url)}" />`,END].join('\n  ');
  if(html.includes(START)&&html.includes(END))return html.replace(/<!-- share-metadata:start -->[\s\S]*?<!-- share-metadata:end -->/,()=>block);
  // Production HTML minifiers may remove comment markers. Remove only preview
  // fields and the title, preserving CSP, viewport, styles and module scripts.
  const cleaned=html.replace(/<title\b[^>]*>[\s\S]*?<\/title>/gi,'').replace(/<meta\b[^>]*>/gi,tag=>/\b(?:name|property)\s*=\s*["'](?:description|og:[^"']+|twitter:[^"']+)["']/i.test(tag)||/\bitemprop\s*=\s*["'](?:name|description|image)["']/i.test(tag)?'':tag).replace(/<link\b[^>]*>/gi,tag=>/\brel\s*=\s*["'](?:canonical|image_src)["']/i.test(tag)?'':tag);
  if(!/<\/head>/i.test(cleaned))throw new Error('Missing HTML head');
  return cleaned.replace(/<\/head>/i,()=>`${block}\n</head>`);
}
