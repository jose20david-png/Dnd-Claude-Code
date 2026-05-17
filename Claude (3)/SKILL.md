---
name: roll-dice
description: Roll any polyhedral die (d4, d6, d8, d10, d12, d20, d100) with animated browser visualization. Supports advantage/disadvantage for d20. Use when you need: "roll a d20", "perception check", "advantage on the save", "roll 2d6 + 2 damage", etc.
---

# Roll Dice with Animation

Roll any standard polyhedral die with a visual browser animation. Supports:
- **All dice:** d4, d6, d8, d10, d12, d20, d100
- **Advantage/Disadvantage:** Roll 2d20, take the higher (advantage) or lower (disadvantage)
- **Modifiers:** Add bonuses/penalties (e.g., +3, -1)
- **Labels:** Name your roll (e.g., "Stealth Check", "Fire Damage")

## Usage

Run the script with:
```
python scripts/roll.py <sides> [mode] [modifier] [--label "text"] [--no-animate]
```

### Examples

**Basic rolls:**
- `python scripts/roll.py 20` — Roll a d20
- `python scripts/roll.py 6` — Roll a d6
- `python scripts/roll.py 100` — Roll a d100

**With modifiers:**
- `python scripts/roll.py 20 normal +5` — d20 + 5
- `python scripts/roll.py 8 normal -1` — d8 - 1

**Advantage/Disadvantage:**
- `python scripts/roll.py 20 advantage` — Roll 2d20, take higher
- `python scripts/roll.py 20 disadvantage` — Roll 2d20, take lower

**With label:**
- `python scripts/roll.py 20 normal 0 --label "Perception Check"`
- `python scripts/roll.py 6 normal +2 --label "Fire Damage"`

**No animation (quiet):**
- `python scripts/roll.py 20 normal 0 --no-animate`

## How It Works

1. Generates cryptographically random roll(s) using Python's `secrets` module
2. Opens a browser window showing the die animation (0.8 seconds)
3. Displays the final result clearly
4. Auto-closes after 5 seconds (or click anywhere to close)

The animation shows the die spinning/rolling, then landing on the result.
