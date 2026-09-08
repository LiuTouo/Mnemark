"""Refresh self-hosted website fonts after editing copy.

Run from any directory:
uv run --with fonttools --with brotli python website/scripts/subset-fonts.py
The original IBM Plex license remains alongside the derived font files.
"""
from pathlib import Path
from fontTools import subset

site = Path(__file__).resolve().parents[1]
repo = site.parent
text = "".join(path.read_text(encoding="utf-8") for path in (site / "src").glob("*.ts"))
text += "".join(chr(number) for number in range(32, 127))
text += "↗↵↑↓⌘—–…，。：「」／繁中"
destination = site / "public" / "fonts"
destination.mkdir(parents=True, exist_ok=True)
for original, name in [("Regular", "regular"), ("SemiBold", "semibold")]:
    options = subset.Options()
    options.flavor = "woff2"
    font = subset.load_font(str(repo / "src" / "assets" / "fonts" / f"IBMPlexSansTC-{original}.woff2"), options)
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(text=text)
    subsetter.subset(font)
    output = destination / f"plex-{name}.woff2"
    subset.save_font(font, str(output), options)
    print(f"{output.name}: {output.stat().st_size:,} bytes")
