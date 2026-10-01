<!-- owner: code member (free-form). kinds/frame: srcdoc.ts (CSP, tokens, base CSS, height, motion gate, script-failure flag), View.tsx; fuller examples in kinds/frame/examples/ (tested). Emphasis: not applicable. -->
# vis html / svg
Only when none of the kinds above fits — usually something the reader should play with (a Step button through an algorithm, a slider on a parameter), or a drawing no kind covers. `vis html` is a fragment (inline `<style>` and `<script>`, no `<html>`/`<head>`); `vis svg` is one `<svg>` with a `viewBox` and no `width`, drawn at its natural size and shrunk to fit. Start with `title:` / `caption:` lines. Aim under 8K characters (the document after `title:` / `caption:`); up to 16K draws marked large, beyond that only the source shows.
```vis html
title: Bubble sort, one comparison at a time
caption: Press Step: the larger of each pair moves right.
<style>#b{display:flex;gap:4px;align-items:end;height:80px}#b i{flex:1;border:1.5px solid var(--color-accent)}#b .c{border-color:var(--status-warn)}</style>
<div id="b"></div><button id="s">Step</button>
<script>
var v=[5,2,8,1,9,3],i=0,b=document.getElementById("b");
function draw(){b.innerHTML=v.map(function(x,k){return '<i class="'+(k==i||k==i+1?"c":"")+'" style="height:'+x*10+'%"></i>'}).join("")}
document.getElementById("s").onclick=function(){if(v[i]>v[i+1]){var t=v[i];v[i]=v[i+1];v[i+1]=t}i=(i+1)%(v.length-1);draw()};
draw();
</script>
```
- Colours only from the theme, so light and dark both work: `var(--color-ink)`, `--color-ink-2`, `--color-ink-muted`, `--color-surface`, `--color-sunken`, `--color-border`, `--color-border-strong`, `--color-accent`, `--color-accent-tint`, `--status-success|warn|error|info` and each with `-bg`. In prose name a colour by what it marks, never by hue. Buttons, inputs and selects are already styled.
- Fit a 360px-wide phone (flex-wrap, grid with `fr`); keep it under about 500px tall.
- Nothing moves until the reader clicks or presses a key in it: give motion a Play or Step button (in SVG, `begin="play.click"` on the animations, with a `<g id="play" role="button">`). No `setTimeout` loops.
- Check a large draft with the `vis_check` tool before you post it.
- It runs sandboxed: no network (no external scripts, fonts, images or fetches), no storage, no `alert`, no form submits. Handle clicks with `onclick`.
