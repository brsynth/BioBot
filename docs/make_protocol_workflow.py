"""Draw the BioBot simulator-centred workflow (publication schema).
Writes protocol_workflow.svg and, with cairosvg, a vector PDF and a 400 dpi PNG.
Width 171 mm (RSC double column); the viewBox is scaled to that width."""
from pathlib import Path

GAP = 80                                  # room between panels, holds the big flow arrows
WA, WB, WC = 580, 615, 600                # panel widths
PA = 20; PB = PA + WA + GAP; PC = PB + WB + GAP
W, H = PC + WC + 20, 1060
MID = 470                                 # vertical middle of the panels (y 20 to 920)
INK, MUTED = "#1f2937", "#4b5563"
KIND = {  # stroke, fill, pill label
    "llm":  ("#4a3aa7", "#eeecf8", "LLM"),
    "code": ("#2a78d6", "#e8f1fb", "CODE"),
    "user": ("#13865d", "#e6f6ef", "USER"),
    "data": ("#6b7280", "#f3f4f6", "DATA"),
    "mixed": ("#2a78d6", "#e8f1fb", "SIM / LLM"),
}
FONT = "Helvetica, Arial, 'Liberation Sans', 'DejaVu Sans', sans-serif"
MONO = "'DejaVu Sans Mono', Menlo, monospace"
out = []


def text(x, y, s, size=21, weight="normal", fill=INK, anchor="start", style="normal", family=FONT, rotate=None):
    t = f' transform="rotate({rotate} {x} {y})"' if rotate else ""
    out.append(f'<text x="{x}" y="{y}" font-family="{family}" font-size="{size}" font-weight="{weight}" '
               f'font-style="{style}" fill="{fill}" text-anchor="{anchor}" xml:space="preserve"{t}>{s}</text>')


def box(x, y, w, h, kind, title, *subs):
    stroke, fill, pill = KIND[kind]
    out.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="10" fill="{fill}" stroke="{stroke}" stroke-width="2.5"/>')
    pw = 14 * len(pill) + 18
    py = y + 10 if x + 16 + 13.6 * len(title) < x + w - pw - 20 else y + h - 34
    out.append(f'<rect x="{x + w - pw - 10}" y="{py}" width="{pw}" height="24" rx="12" fill="{stroke}"/>')
    text(x + w - pw / 2 - 10, py + 18, pill, 16, "bold", "#ffffff", "middle")
    text(x + 16, y + 34, title, 24, "bold")
    for i, s in enumerate(subs):
        text(x + 16, y + 62 + 25 * i, s, 20, fill=MUTED)


def arrow(d, label=None, at=None, color=INK, dash=False, anchor="start", rotate=None):
    extra = ' stroke-dasharray="7 6"' if dash else ""
    out.append(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="2.5"{extra} marker-end="url(#head{color[1:]})"/>')
    if label:
        text(*at, label, 19, "bold", color, anchor, rotate=rotate)


def flow(x0, x1, y, label=None):
    """Big block arrow in the gap between two panels."""
    sh, hh, hl = 18, 36, 30
    out.append(f'<path d="M{x0},{y - sh} H{x1 - hl} V{y - hh} L{x1},{y} L{x1 - hl},{y + hh} V{y + sh} H{x0} z" fill="{INK}"/>')
    if label:
        text((x0 + x1) / 2, y - hh - 12, label, 20, "bold", INK, "middle")


def panel(x, w, letter, title):
    out.append(f'<rect x="{x}" y="20" width="{w}" height="900" rx="14" fill="#fbfbfc" stroke="#d1d5db" stroke-width="2"/>')
    text(x + 22, 62, f"{letter}", 30, "bold")
    text(x + 52, 62, title, 26, "bold", MUTED)


LOOP = "#b45309"


def line(d, color=INK):
    """A connector without a head (it continues into another line or a big arrow)."""
    out.append(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="2.5"/>')


panel(PA, WA, "A", "Design · chat")
panel(PB, WB, "B", "Simulate · deck and playback")
panel(PC, WC, "C", "Export · device code")

# A — design: loops in the left margin, the pass line in the right margin
ax, lx = PA + 65, PA + 30
out.append(f'<rect x="{ax}" y="88" width="470" height="100" rx="10" fill="#ffffff" stroke="#9ca3af" stroke-width="2" stroke-dasharray="6 5"/>')
text(ax + 16, 122, "User request", 24, "bold")
text(ax + 16, 151, "“1:2 serial dilution of the sample across row B,", 20, style="italic", fill=MUTED)
text(ax + 16, 176, "6 points, 100 µL per well, on an Opentrons OT-2.”", 20, style="italic", fill=MUTED)
box(ax, 220, 470, 92, "llm", "Identify device, open deck", "layout drawn from the device documentation")
box(ax, 344, 470, 92, "llm", "Complete the request", "structured questions for missing values")
box(ax, 468, 470, 92, "llm", "Write the protocol", "BioBot language, from the device documentation")
box(ax, 592, 470, 92, "code", "Expand and check", "deck positions · wells · volumes · tips")
box(ax, 716, 225, 92, "code", "Final-state check", "well volumes")
box(ax + 260, 716, 210, 92, "llm", "Expected", "from request only")
for y in (188, 312, 436, 560):
    arrow(f"M{ax + 235},{y} V{y + 30}")
arrow(f"M{ax + 260},762 H{ax + 227}")
arrow(f"M{ax},638 H{lx} V514 H{ax - 2}", color=LOOP)
arrow(f"M{ax},762 H{lx} V640", color=LOOP)
text(PA + 18, 690, "fail → errors to the LLM (≤ 3)", 18, "bold", LOOP, "middle", rotate=-90)
line(f"M{ax + 112},808 V860 H{ax + 495} V{MID} H{PA + WA}")
text(ax + 127, 850, "pass", 19, "bold")
flow(PA + WA, PB, MID)

# B — simulate: input in the left margin, update loop and export line in the right margin
bx = PB + 55
loop_x, export_x = bx + 520, bx + 540
line(f"M{PB},{MID} H{PB + 20} V200")
arrow(f"M{PB + 20},200 H{bx - 2}")
out.append(f'<rect x="{bx}" y="88" width="500" height="228" rx="10" fill="#f3f4f6" stroke="#6b7280" stroke-width="2.5"/>')
out.append(f'<rect x="{bx + 350}" y="98" width="140" height="24" rx="12" fill="#6b7280"/>')
text(bx + 420, 116, "SAVED", 16, "bold", "#ffffff", "middle")
text(bx + 16, 122, "BioBot protocol", 24, "bold")
text(bx + 16, 148, "vendor-agnostic JSON · source of truth", 20, fill=MUTED)
for i, code_line in enumerate(["n_points: 6    volume_ul: 100",
                               "transfer res:A1 → plate:B2..B{n_points}",
                               "transfer res:A2 → plate:B1, 2×{volume_ul}",
                               "for i in 1..{n_points}−1:",
                               "  transfer plate:B{i} → B{i+1}, mix 3×"]):
    text(bx + 16, 186 + 26 * i, code_line, 18, family=MONO, fill=INK)
box(bx, 348, 500, 92, "code", "Expand", "steps, initial and final well contents")
box(bx, 472, 500, 100, "user", "Deck and playback", "play through steps · inspect wells and mixtures")
box(bx, 620, 240, 116, "code", "Parameter", "set value, re-expand", "no LLM call")
box(bx + 260, 620, 240, 116, "llm", "Deck edit", "labware, instrument", "then re-checked")
arrow(f"M{bx + 250},316 V346")
arrow(f"M{bx + 250},440 V470")
arrow(f"M{bx + 120},572 V618")
arrow(f"M{bx + 380},572 V618")
arrow(f"M{bx + 120},736 V780 H{loop_x} V270 H{bx + 2 + 500}", color=LOOP)
line(f"M{bx + 500},678 H{loop_x}", LOOP)
text(bx + 380, 806, "updated protocol", 19, "bold", LOOP, "middle")
line(f"M{bx + 500},134 H{export_x} V{MID} H{PB + WB}")
flow(PB + WB, PC, MID, "Export")

# C — export: input and repair loop in the left margin, regenerate loop in the right margin
cx = PC + 80
line(f"M{PC},{MID} H{PC + 20} V120")
arrow(f"M{PC + 20},120 H{cx - 2}")
box(cx, 88, 460, 92, "llm", "Generate device code", "request + simulator edits · documentation")
box(cx, 212, 460, 92, "mixed", "Validate", "vendor simulator, otherwise LLM review")
box(cx, 336, 460, 92, "llm", "Read back into BioBot language", "what the generated code actually does")
box(cx, 460, 460, 92, "code", "Compare liquid movements", "source → destination, volume, order")
for y in (180, 304, 428):
    arrow(f"M{cx + 230},{y} V{y + 30}")
arrow(f"M{cx},258 H{PC + 45} V160 H{cx - 2}", color=LOOP)
text(cx + 12, 204, "repair ≤ 5", 18, "bold", LOOP)
arrow(f"M{cx + 460},506 H{cx + 490} V134 H{cx + 462}", color=LOOP)
text(cx + 496, 320, "mismatch → regenerate (≤ 1)", 18, "bold", LOOP, "middle", rotate=90)
out.append(f'<rect x="{cx}" y="610" width="460" height="120" rx="10" fill="#ffffff" stroke="#6b7280" stroke-width="2.5"/>')
text(cx + 16, 644, "Device-specific code", 24, "bold")
text(cx + 16, 672, ".py (Opentrons) · .csv picklist (Echo)", 20, fill=MUTED)
text(cx + 16, 697, "worklist (Hamilton) · any documented format", 20, fill=MUTED)
arrow(f"M{cx + 230},552 V608", "match (else warning)", (cx + 242, 590))

# Legend and footer
x = 40
for kind in ("llm", "code", "user", "data"):
    stroke, fill, pill = KIND[kind]
    out.append(f'<rect x="{x}" y="950" width="34" height="24" rx="6" fill="{fill}" stroke="{stroke}" stroke-width="2.5"/>')
    label = {"llm": "LLM call", "code": "Deterministic code (no LLM, no generated code run)",
             "user": "User", "data": "Data"}[kind]
    text(x + 44, 969, label, 20)
    x += 44 + 10.2 * len(label) + 40
out.append(f'<path d="M{x},962 H{x + 40}" stroke="{LOOP}" stroke-width="2.5" marker-end="url(#head{LOOP[1:]})"/>')
text(x + 52, 969, "Feedback loop", 20)
text(40, 1025, "Device code is generated only at export. The simulator plays, and the system saves, the protocol — never code.", 21, style="italic", fill=MUTED)

markers = "".join(f'<marker id="head{c[1:]}" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="13" markerHeight="13" orient="auto-start-reverse">'
                  f'<path d="M0,0 L10,5 L0,10 z" fill="{c}"/></marker>' for c in (INK, LOOP))
svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="171mm" height="{171 * H / W:.1f}mm" viewBox="0 0 {W} {H}">'
       f'<defs>{markers}</defs><rect width="{W}" height="{H}" fill="#ffffff"/>' + "\n".join(out) + "</svg>")
here = Path(__file__).resolve().parent
(here / "protocol_workflow.svg").write_text(svg, encoding="utf-8")
try:
    import cairosvg
    cairosvg.svg2pdf(bytestring=svg.encode(), write_to=str(here / "protocol_workflow.pdf"))
    cairosvg.svg2png(bytestring=svg.encode(), write_to=str(here / "protocol_workflow.png"), dpi=400, output_width=round(171 / 25.4 * 400))
except ImportError:
    print("cairosvg not installed: wrote the SVG only (pip install cairosvg).")
