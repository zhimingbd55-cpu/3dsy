import sharp from 'sharp';
for(const name of ['logo','logo-mono','logo-white','icon','icon-mono','icon-white'])await sharp(`public/brand/${name}.svg`,{density:288}).png().toFile(`public/brand/${name}.png`);
for(const size of [180,192,512])await sharp('public/brand/icon.svg').resize(size-24,size-24).extend({top:12,bottom:12,left:12,right:12,background:'#ffffff'}).png().toFile(`public/brand/icon-${size}.png`);
await sharp('public/brand/icon.svg').resize(32,32).png().toFile('public/brand/favicon.png');
for(const name of ['share-thumb','share-card'])await sharp(`public/brand/${name}.svg`).png().toFile(`public/brand/${name}.png`);
