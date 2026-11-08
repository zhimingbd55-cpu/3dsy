"""Build public, non-personal sharing artwork from the existing brand vectors/font."""
from pathlib import Path
import re
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen

folder=Path(__file__).resolve().parents[1]/'public'/'brand'
logo=re.search(r'<svg[^>]*>(.*)</svg>',(folder/'logo.svg').read_text(encoding='utf-8')).group(1)
font=TTFont(folder/'poster-display.woff');glyphs=font.getGlyphSet();cmap=font.getBestCmap();units=font['head'].unitsPerEm
def text_paths(text,x,y,size):
    scale=size/units;paths=[]
    for char in text:
        glyph=glyphs[cmap[ord(char)]];pen=SVGPathPen(glyphs);glyph.draw(pen)
        paths.append(f'<path transform="translate({x:g} {y:g}) scale({scale:g} {-scale:g})" d="{pen.getCommands()}"/>');x+=glyph.width*scale
    return ''.join(paths)
thumb=f'<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512" role="img" aria-label="1➕衣品牌标志"><rect width="512" height="512" fill="#fff"/><g transform="translate(19 152) scale(1.48)">{logo}</g><path fill="#ff641f" d="M0 432h512v80H0z"/></svg>'
card=f'<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="1➕衣：今天，换个样"><rect width="1200" height="630" fill="#fff"/><g transform="translate(48 36) scale(1.08)">{logo}</g><path fill="#ff641f" d="M1036 42h32v38h38v32h-38v38h-32v-38h-38V80h38z"/><g fill="#151515">{text_paths("今天，换个样",54,366,132)}</g><path fill="#ff641f" d="M54 464h870v-53l222 97-222 97v-53H54z"/></svg>'
(folder/'share-thumb.svg').write_text(thumb,encoding='utf-8');(folder/'share-card.svg').write_text(card,encoding='utf-8')
print('Built public vector sharing previews')
