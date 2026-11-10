<!-- Parsed by design-guide.ts: every list line is `- Name: definition`. Under each `## <Family>` heading are that family's styles (20 in all, in 5 families: DESIGN_DIRECTIONS); under `## Layouts` are the 12 layouts (DESIGN_LAYOUTS). Returned alone by `vis_guide {kind:"lookbook-directions"}`. A design session receives its one style's definition, and its layout's when it has one, word for word. -->
# lookbook-directions: the styles and the layouts

A design is made in one style and, when it has one, one layout. The style decides how the page looks: colour, type, imagery, ornament and mood. The layout decides how it is arranged. `directions` takes style names; `layouts` takes layout names, and none are ticked unless the user names some ("try a compact and a bento version"). The families only group the styles; they count for nothing.

## Quiet

- Minimalist: Extreme restraint and typography-driven design. Negative space as a feature, stripped to absolute essentials. Think Apple circa 2010 - one hero element, vast whitespace, single clear CTA.
- Clean & Modern: Crisp edges with geometric precision. Ample whitespace and contemporary aesthetics. Sans-serif typography, subtle shadows, and clear visual hierarchy. Fresh and current without being trendy.
- Balanced: Harmonious proportions with visual equilibrium. Neither too busy nor too sparse. Neutral tones with measured accent colors. Even spacing rhythms creating calm, organized layouts.
- Light & Airy: Soft pastels with maximum whitespace. Floating elements with gentle shadows. Delicate typography and subtle color variations. Open, breathing layouts that feel spacious.
- Subtle & Refined: Understated colors with delicate typography. Minimal decoration and quiet confidence. Nuanced variations rather than bold statements. Sophisticated restraint throughout.
- Elegant: Refined typography with generous letter-spacing. Subtle gradients and luxurious spacing. Sophisticated muted palette with gold/silver accents. Premium feel through restraint.

## Bold

- Bold & Vibrant: High saturation colors with strong visual contrast. Dynamic typography with varied scales. Energetic layouts that command attention. Confident color blocking and dramatic visual hierarchy.
- High Contrast: Black and white as primary palette with bold color pops. Sharp edges and dramatic scale differences. Strong visual impact through stark oppositions.
- Dynamic & Energetic: Diagonal lines and gradient bursts. Motion suggestions through angled elements. Bold scale shifts and visual tension. Layouts that feel alive and in motion.
- Dark & Moody: Deep backgrounds with dramatic shadows. Muted highlights and atmospheric depth. High contrast accent colors as focal points. Mysterious, immersive, cinematic aesthetic.

## Expressive

- Playful: Rounded shapes and bright, cheerful colors. Whimsical typography choices. Fun micro-animations and delightful interactions. Approachable and friendly without being childish.
- Warm & Inviting: Earth tones and warm color palette. Rounded corners with soft textures. Cozy, approachable feel. Comfortable spacing that draws users in rather than pushing them away.
- Creative: Asymmetric layouts breaking conventional rules. Unexpected color combinations. Artistic expression prioritized. Rule-breaking design that surprises and engages.
- Artistic: Hand-drawn elements and organic shapes. Unique color stories with creative typography. Expressive, gallery-like presentation. Design as art rather than pure function.

## Business

- Professional: Structured grid layouts with muted, trustworthy colors. Classic serif/sans-serif pairing. Conveying competence and reliability. Corporate-appropriate while avoiding sterility.
- Corporate: Professional blue/gray palette with structured layouts. Trustworthy and enterprise-ready appearance. Clear information hierarchy. Reliable, established, institutional feel.
- Technical: Monospace fonts with grid overlays. Data-focused layouts with functional aesthetic. Exposed structure and systematic organization. Developer/engineer-oriented visual language.

## Atmospheric

- Rich & Detailed: Layered textures and intricate patterns. Visual depth through overlapping elements. Ornate decorative touches balanced with usability. Dense information architecture that rewards exploration.
- Heritage: The subject's own era and place, taken seriously. Ornament, borders and motifs from that tradition, built in CSS and SVG. Display serif type and a palette drawn from surviving artifacts, kept at full contrast. If no era is given, use the subject's own history. Never sepia costume.
- Immersive: Atmosphere before information. A full-bleed hero that establishes a place, then sections staged like scenes down one page: deep layering, large scale shifts, restrained scroll-cued motion that respects prefers-reduced-motion. Any light level, not only dark. Legibility survives the mood.

## Layouts

- Compact: Dense and information-first: tight 4-12px gaps, a smaller type scale, no tall hero, as much legible content as fits on the first desktop screen, lists and tables over big cards.
- Spacious: Generous room: 96px or more between sections, a narrow reading width, few items per row, one idea per screen height.
- Single Column: One centred column about 720px wide holds everything from top to bottom, with no sidebars or side-by-side grids at any width.
- Split Screen: Two halves side by side on desktop, one staying put (headline, picture or form) while the other scrolls the content; on a phone they stack.
- Sidebar Navigation: A fixed left sidebar holds the navigation and the list of sections, and the content scrolls beside it, as in documentation or settings; on a phone it becomes a menu button.
- Card Grid: A grid of equal cards, 3 or 4 across on desktop, each built the same way, with filters or tabs above it.
- Bento: An uneven grid of tiles in different sizes, one large and several small, fitting together into a rectangle, one idea per tile.
- Dashboard: An app screen, not a web page: a top bar, a side menu and a main area of panels, figures, charts and tables, all on one desktop screen without the page scrolling.
- Magazine: An editorial page: a lead story with a large picture, then columns of mixed widths holding stories of different sizes, pull quotes and lines between columns.
- Long-Scroll Story: One long page told in full-width chapters about a screen tall each, arranged differently from one to the next, with a clear story from top to bottom.
- List and Detail: A list of items on the left and the chosen item's full detail on the right, on one screen; choosing an item updates the detail in place, and on a phone the list opens the detail.
- Tabbed Panels: Everything on one screen, the content split into tabs or steps that switch in place, so the page itself barely scrolls.

Compact and Spacious are about density and the other 10 about structure; a design has at most one layout. With layouts ticked, Pair Up (the default) gives each model as many designs as the longer list, styles or layouts, pairing each style with a layout and shifting the pairs per model; Every Mix makes every style in every layout. Both count against the same limits.
