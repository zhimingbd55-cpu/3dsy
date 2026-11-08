"""Build original 1+衣 lockup and a licensed, small deterministic poster font.
Usage: python scripts/build-brand.py ../work/brand-source/NotoSansSC.ttf
Source font: https://github.com/google/fonts/tree/main/ofl/notosanssc (SIL OFL).
"""
from pathlib import Path
import sys
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools import subset

out=Path(__file__).resolve().parents[1]/'public'/'brand'
out.mkdir(parents=True,exist_ok=True)
font=instantiateVariableFont(TTFont(sys.argv[1]),{'wght':900},inplace=True)
glyphs=font.getGlyphSet(); pen=SVGPathPen(glyphs)
glyphs[font.getBestCmap()[ord('衣')]].draw(pen)
clothing=f'<path transform="translate(210 101) scale(.095 -.095)" d="{pen.getCommands()}"/>'
one='<path d="M18 30 47 14h20v87H42V42L28 49z"/>'
plus='<path d="M116 23h22v26h26v22h-26v26h-22V71H90V49h26z"/>'
for name,ink,color in [('logo','#151515','#ff641f'),('logo-mono','#151515','#151515'),('logo-white','#ffffff','#ffffff')]:
    (out/f'{name}.svg').write_text(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 120" role="img" aria-label="1➕衣"><g fill="{ink}">{one}{clothing}</g><g fill="{color}">{plus}</g></svg>',encoding='utf-8')
icon='<path d="m42 38 22 14 22-14 28 23-14 21-12-8v43H40V74l-12 8-14-21z" fill="none" stroke="currentColor" stroke-width="9" stroke-linejoin="round"/><path d="m48 73 12-9h12v39H59V79l-7 4z" fill="currentColor"/><path d="M101 10h10v11h11v10h-11v11h-10V31H90V21h11z" fill="ACCENT"/>'
for name,ink,accent in [('icon','#151515','#ff641f'),('icon-mono','#151515','#151515'),('icon-white','#ffffff','#ffffff')]:
    (out/f'{name}.svg').write_text(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 136 136" role="img" aria-label="1➕衣" color="{ink}">'+icon.replace('ACCENT',accent)+'</svg>',encoding='utf-8')
options=subset.Options();options.flavor='woff';options.desubroutinize=True
subsetter=subset.Subsetter(options=options)
subsetter.populate(text='今天，换个样原视频试穿成片扫码看试穿封面暂不可用待续传正在保存尚未完成处理中未能完整保存1＋衣')
subsetter.subset(font);font.flavor='woff';font.save(out/'poster-display.woff')
ui=instantiateVariableFont(TTFont(sys.argv[1]),{'wght':700},inplace=True)
uiSubset=subset.Subsetter(options=options)
uiSubset.populate(text='原视频试穿成片正在准备视频播放对比暂停等待重新播放成片我也来试衣')
uiSubset.subset(ui);ui.flavor='woff';ui.save(out/'ui-display.woff')
print('Built logo/icon SVGs and poster-display.woff')
