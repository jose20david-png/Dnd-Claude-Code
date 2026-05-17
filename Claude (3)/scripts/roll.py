#!/usr/bin/env python3
import sys
import secrets
import webbrowser
import os
import tempfile
from pathlib import Path

def roll_die(sides):
    return secrets.randbelow(sides) + 1

def read_template():
    script_dir = Path(__file__).parent
    html_file = script_dir / "dice.html"
    if not html_file.exists():
        return None
    return html_file.read_text(encoding='utf-8')

def main():
    if len(sys.argv) < 2:
        print("Usage: roll.py <sides> [mode] [modifier] [--label \"text\"] [--no-animate]")
        sys.exit(1)

    sides = int(sys.argv[1])
    mode = 'normal'
    modifier = 0
    label = ""
    no_animate = False

    # Parse positional args
    pos_args = [a for a in sys.argv[2:] if not a.startswith('--')]
    if len(pos_args) >= 1:
        mode = pos_args[0]
    if len(pos_args) >= 2:
        try:
            modifier = int(pos_args[1])
        except ValueError:
            modifier = 0

    # Parse flags
    args = sys.argv[1:]
    for i, arg in enumerate(args):
        if arg == '--label' and i + 1 < len(args):
            label = args[i + 1]
        elif arg == '--no-animate':
            no_animate = True

    # Roll
    if mode == 'advantage':
        roll1 = roll_die(sides)
        roll2 = roll_die(sides)
        result = max(roll1, roll2)
        rolls_str = f"{roll1},{roll2}"
    elif mode == 'disadvantage':
        roll1 = roll_die(sides)
        roll2 = roll_die(sides)
        result = min(roll1, roll2)
        rolls_str = f"{roll1},{roll2}"
    else:
        result = roll_die(sides)
        rolls_str = str(result)

    final = result + modifier

    # Print result to console
    print(f"d{sides} [{mode}]: {result}" + (f" + {modifier} = {final}" if modifier != 0 else f" = {final}"))

    if no_animate:
        sys.exit(0)

    # Load template and inject values directly into JS
    template = read_template()
    if not template:
        print("dice.html not found — cannot animate")
        sys.exit(0)

    # Inject roll data as JS variables at the top of the script
    injection = f"""
<script>
  window.ROLL_DATA = {{
    sides: {sides},
    result: {result},
    modifier: {modifier},
    final: {final},
    rolls: "{rolls_str}",
    label: "{label}",
    mode: "{mode}"
  }};
</script>
"""
    # Insert right before closing </head>
    html = template.replace('</head>', injection + '</head>', 1)

    # Write to temp file and open
    tmp = tempfile.NamedTemporaryFile(
        delete=False, suffix='.html', mode='w', encoding='utf-8'
    )
    tmp.write(html)
    tmp.close()

    webbrowser.open(Path(tmp.name).as_uri())

if __name__ == '__main__':
    main()
