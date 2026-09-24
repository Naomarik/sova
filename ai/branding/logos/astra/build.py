from pathlib import Path
import base64
import xml.etree.ElementTree as ET

OUT = Path(__file__).resolve().parent
ROOT = OUT.parents[3]
SKILL = ROOT / '.claude/skills/fold-ai-dev-design'
concepts = [
 ('sova-vigil', 'SOVA', 'Vigil', 'A single watchful silhouette. Two cut-out glances and a descending center suggest an owl without drawing a mascot.', '<path fill="currentColor" fill-rule="evenodd" d="M4 5 16 10 28 5V17C28 23 23 27 16 29 9 27 4 23 4 17ZM8 12V17H13V14ZM24 12 19 14V17H24Z"/>'),
 ('sova-duet', 'SOVA', 'Duet', 'Two open eye chambers share a quiet center. The opposing cuts suggest independent sessions held in one field of attention.', '<path fill="currentColor" d="M15 8C12 5 7 5 4 8 0 12 2 20 8 23L15 27V20L10 18C6 16 6 12 9 11 11 10 13 11 15 13ZM17 8C20 5 25 5 28 8 32 12 30 20 24 23L17 27V20L22 18C26 16 26 12 23 11 21 10 19 11 17 13Z"/>'),
 ('tavi-fork', 'TAVI', 'Fork', 'A broad T divides into two working stems. Its open V-shaped counter turns a familiar initial into a compact parallel-agent monogram.', '<path fill="currentColor" d="M3 5H29V11H24V27H18V16L16 13 14 16V27H8V11H3Z"/>'),
 ('tavi-channel', 'TAVI', 'Channel', 'A tapered A-like body carries a T-shaped channel in negative space. One shared header feeds a single clear path through the mark.', '<path fill="currentColor" d="M10 4H22L30 28H19V13H24L22 8H10L8 13H13V28H2Z"/>'),
]
for slug, brand, name, rationale, shape in concepts:
    svg = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="{brand} — {name}">\n  {shape}\n</svg>\n'
    (OUT / f'{slug}.svg').write_text(svg)
    ET.fromstring(svg)

def mark(shape, size):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="{size}" height="{size}" aria-hidden="true">{shape}</svg>'

def panel(shape, brand, theme):
    sizes = ''.join(f'<div class="size">{mark(shape,n)}<span>{n}px</span></div>' for n in [16,24,32])
    return f'<div class="sample {theme}" data-theme="{theme}"><span class="theme-label">{theme.capitalize()} / monochrome</span><div class="lockup">{mark(shape,64)}<span class="wordmark">{brand}</span></div><div class="small"><div class="sizes">{sizes}</div><div class="accent" aria-label="Indigo version">{mark(shape,32)}</div></div></div>'

font = base64.b64encode((SKILL / 'fonts/Inter-Variable.woff2').read_bytes()).decode()
tokens = (SKILL / 'tokens.css').read_text()
# Embed the design-system styles and its Inter face; remove file-dependent font declarations.
import re
tokens = re.sub(r'@font-face\s*\{.*?\}', '', tokens, flags=re.S)
base = (SKILL / 'fold-ai-dev.css').read_text()
cards = ''.join(f'<article><div class="heading"><span class="index">0{i}</span><h2>{brand} <span>/ {name}</span></h2></div><div class="samples">{panel(shape,brand,"light")}{panel(shape,brand,"dark")}</div><p>{rationale}</p><div class="filename">{slug}.svg</div></article>' for i,(slug,brand,name,rationale,shape) in enumerate(concepts,1))
html = '''<!doctype html><html lang="en" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>SOVA / TAVI — Astra logo explorations</title><style>'''+tokens+'''</style><style>'''+base+'''</style><style>
@font-face{font-family:Inter;src:url(data:font/woff2;base64,'''+font+''') format('woff2');font-weight:100 900;font-display:swap}
*{box-sizing:border-box}body{margin:0;background:var(--color-bg);color:var(--color-ink);font-family:Inter,sans-serif}main{max-width:1280px;margin:auto;padding:40px 40px 28px}header{display:flex;align-items:flex-end;justify-content:space-between;gap:32px;margin-bottom:28px}.eyebrow{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--color-ink-muted);margin:0 0 12px}h1{font-size:40px;font-weight:640;letter-spacing:-.045em;line-height:1.05;margin:0}header p{font-size:12.5px;max-width:310px;line-height:1.5;color:var(--color-ink-2);margin:0}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:28px 24px}article{min-width:0}.heading{display:flex;gap:12px;align-items:center;margin-bottom:12px}.index{font-size:11px;color:var(--color-ink-muted)}h2{font-size:16px;font-weight:600;margin:0}h2 span{font-weight:400;color:var(--color-ink-2)}.samples{display:grid;grid-template-columns:1fr 1fr;border-radius:12px;overflow:hidden}.sample{background:var(--color-surface);color:var(--color-ink);padding:20px;min-width:0}.sample.dark{--color-bg:#1E1E26;--color-ink:#F2F2F6;--color-ink-muted:#9A9AA8;--color-border:#3B3B49;--color-accent:#8E88FF;background:var(--color-bg)}.theme-label{font-size:11px;color:var(--color-ink-muted)}.lockup{display:flex;align-items:center;justify-content:center;gap:12px;height:136px}.wordmark{font-size:32px;font-weight:640;letter-spacing:-.03em}.small{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;padding-top:16px;border-top:1px solid var(--color-border)}.sizes{display:flex;gap:20px;align-items:flex-start}.size{display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:54px;gap:8px}.size span{font-size:11px;line-height:14px;color:var(--color-ink-muted)}svg{flex-shrink:0;display:block}.accent{color:var(--color-accent);padding-top:0}article>p{font-size:12.5px;line-height:1.5;margin:12px 0 6px;max-width:65ch;color:var(--color-ink-2)}.filename{font-size:11px;color:var(--color-ink-muted)}footer{border-top:1px solid var(--color-border);margin-top:28px;padding-top:16px;display:flex;justify-content:space-between;gap:24px;font-size:11px;color:var(--color-ink-muted)}.grid{container-type:inline-size;container-name:sheet}@media(max-width:900px){main{padding:24px}.grid{grid-template-columns:1fr}header{align-items:flex-start;flex-direction:column;gap:16px}}@media(max-width:460px){.sample{padding:12px}.wordmark{font-size:24px}.lockup{gap:8px}.lockup svg{width:48px;height:48px}.sizes{gap:12px}.accent{display:none}footer{flex-direction:column;gap:8px}}
</style></head><body><main><header><div><p class="eyebrow">Sova · Astra / exploration set</p><h1>Quiet presence.<br>Parallel thinking.</h1></div><p>4 original marks for your personal companion to coding sessions, live watching, chat, and parallel agents.</p></header><section class="grid" aria-label="Four logo candidates">'''+cards+'''</section><footer><span>Provisional names and concepts. No trademark or uniqueness claim.</span><span>32-unit masters · currentColor · Inter 640 · actual-size previews</span></footer></main></body></html>'''
(OUT / 'comparison.html').write_text(html)
print('Generated four XML-valid SVG masters and self-contained comparison.html')
