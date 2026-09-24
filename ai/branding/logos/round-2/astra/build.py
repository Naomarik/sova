"""Build the standalone comparison from the four SVG sources; no dependencies."""
from pathlib import Path
import base64, re, xml.etree.ElementTree as ET

root = Path(__file__).resolve().parent
repo = root.parents[4]
skill = repo / '.claude/skills/fold-ai-dev-design'
tokens = (skill / 'tokens.css').read_text()
def embed_font(m):
    path = skill / m.group(1)
    return 'url(data:font/woff2;base64,' + base64.b64encode(path.read_bytes()).decode() + ')'
tokens = re.sub(r'url\([\"\']?(fonts/[^\"\')]+)[\"\']?\)', embed_font, tokens)
base = (skill / 'fold-ai-dev.css').read_text()
concepts = [
 ('sova-loop', 'sova', 'Loop', 'S + O · linked bowls',
  'The S’s upper terminal flows into the O’s crown; its lower bowl meets the O’s left wall. Two letters share one compact, rounded body rather than sitting beside each other.',
  'The softest direction. At 16px, the lower join becomes a dense knot; the O remains open, but S is the slower read.'),
 ('sova-fold', 'sova', 'Fold', 'V + A · shared diagonal',
  'The V’s rising arm is also the A’s left leg. One continuous zigzag carries both letters; a single crossbar resolves the right-hand peak into A.',
  'The most economical SOVA direction. Without the wordmark it can read as WA; no owl or watch metaphor is intended.'),
 ('tavi-span', 'tavi', 'Span', 'T + V · shared cap',
  'A full-width T cap binds a vertical stem to a descending V. The V begins at the T’s shoulder and returns to the far end of the same cap, enclosing one triangular counter.',
  'The most architectural direction. The joining principle survives from the favorite, but the hooked T–I and detached dot do not.'),
 ('tavi-countertype', 'tavi', 'Countertype', 'A + T · negative-space letter',
  'A broad, flat-topped A holds a T-shaped counter. The two letters occupy the same body: A is ink, T is the surface beneath it. The lower notch supplies the A’s separate feet.',
  'The strongest silhouette. The T is a discovery rather than the first read; its 4-unit stem stays 2px wide at 16px.')
]
css = '''
.sample[data-theme="dark"]{--color-bg:#1E1E26;--color-ink:#F2F2F6;--color-ink-2:#B8B8C6;--color-ink-muted:#9A9AA8}
*{box-sizing:border-box}body{margin:0;padding:32px;background:var(--color-bg);color:var(--color-ink);font:400 14.5px/1.55 var(--font-body)}main{max-width:1216px;margin:auto}h1{font-size:40px;line-height:1.05;letter-spacing:-.03em;font-weight:640;margin:8px 0 16px}h2{font-size:20px;line-height:1.25;font-weight:600;margin:0}.eyebrow{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--color-ink-muted)}.intro{max-width:78ch;margin:0 0 24px;color:var(--color-ink-2)}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px}.card{padding:24px;background:var(--color-surface);border:1px solid var(--color-border);border-radius:12px;min-width:0}.heading{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:16px}.letters{font-size:12.5px;color:var(--color-ink-2)}.panels{display:grid;grid-template-columns:1fr 1fr;gap:8px}.sample{background:var(--color-bg);color:var(--color-ink);padding:20px 16px;border-radius:8px}.hero{display:flex;align-items:center;gap:12px;height:120px;justify-content:center}.hero svg{width:72px;height:72px;flex:none}.word{font-size:32px;font-weight:640;letter-spacing:-.03em}.sizes{display:flex;align-items:end;justify-content:center;gap:24px}figure{margin:0;display:flex;align-items:center;flex-direction:column;gap:8px}figcaption{font-size:11px;color:var(--color-ink-muted)}svg{display:block;flex:none}.description{margin:16px 0 8px}.tradeoff{font-size:12.5px;color:var(--color-ink-2);margin:0}.file{font:400 11px/1.3 var(--font-mono);color:var(--color-ink-muted);margin-top:16px}footer{margin-top:24px;color:var(--color-ink-2);font-size:12.5px}.wrap{container-type:inline-size;container-name:board}@container board (max-width:850px){.grid{grid-template-columns:1fr}}@container board (max-width:450px){.panels{grid-template-columns:1fr}.heading{display:block}.letters{margin-top:4px}.card{padding:16px}} 
'''
cards=[]
for i, (slug, word, name, letters, rationale, tradeoff) in enumerate(concepts, 1):
    svg=(root / (slug+'.svg')).read_text().strip()
    tree=ET.fromstring(svg)
    assert tree.attrib['viewBox']=='0 0 32 32'
    assert not any('id' in e.attrib for e in tree.iter())
    assert not any(e.tag.rsplit('}',1)[-1] in ['mask','clipPath','use'] for e in tree.iter())
    panels=[]
    for theme in ['light','dark']:
        sizes=''.join('<figure>'+svg.replace('width="32" height="32"', f'width="{s}" height="{s}"')+f'<figcaption>{s}px</figcaption></figure>' for s in [16,24,32])
        panels.append(f'<div class="sample" data-theme="{theme}"><div class="eyebrow">{theme}</div><div class="hero">{svg}<span class="word">{word}</span></div><div class="sizes">{sizes}</div></div>')
    cards.append(f'<section class="card"><div class="heading"><h2>{i:02} / {name}</h2><span class="letters">{letters}</span></div><div class="panels">'+''.join(panels)+f'</div><p class="description">{rationale}</p><p class="tradeoff">{tradeoff}</p><div class="file">{slug}.svg</div></section>')
html='''<!doctype html><html lang="en" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sova · Astra · Round 2 ligatures</title><style>'''+tokens+'</style><style>'+base+'</style><style>'+css+'''</style></head><body><main><div class="eyebrow">Sova / round 2 / Astra · medium</div><h1>Letters, joined.</h1><p class="intro">4 independent monograms for 2 provisional names. Following the favorite’s letter-first approach—not its outline. One color, a 32-unit grid, and no pictorial shorthand.</p><div class="wrap"><div class="grid">'''+''.join(cards)+'''</div></div><footer>Exploration, not a naming decision or trademark clearance. Wordmarks: Inter 640, −0.03em. All previews inline the source geometry; no masks, IDs, external assets, or network requests. The 16 / 24 / 32px rows are actual CSS sizes.</footer></main></body></html>'''
(root/'comparison.html').write_text(html)
print('Validated 4 XML sources; generated self-contained comparison.html')
