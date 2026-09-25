"""
Feasibility Check Module for BioBot RAG Pipeline
-------------------------------------------------
Validates whether a protocol described by the user is physically and logically
possible BEFORE code generation begins.  Runs after consolidation, before
handler detection / indexing / generation.

Uses gpt-4o-mini for speed and cost efficiency.
"""

import json
from openai import OpenAI
from config import get_api_key, light_functions_model

# ------------------------------------------------------------------ #
#  System prompt sent to the feasibility-check LLM                    #
# ------------------------------------------------------------------ #
FEASIBILITY_PROMPT = """\
You are a lab-automation feasibility reviewer.  You will receive a
consolidated protocol request that a user wants to execute on a liquid
handling robot.

Your job is to determine whether the described protocol is **physically
and logically feasible** given standard lab-automation constraints.

Check the following categories:

### 1. Volume feasibility
- Are requested aspiration / dispense volumes within the range of common
  pipettes?  (P20: 1-20 µL, P300: 20-300 µL, P1000: 100-1000 µL,
  multichannel equivalents, etc.)
- Does the total liquid required fit in the source labware?
- Will the destination wells overflow?  (e.g. 96-well plate max ≈ 200-360 µL
  depending on type; 384-well ≈ 80-120 µL; reservoirs ≈ 15-290 mL per well)
- Are serial-dilution ratios achievable with the stated volumes?

### 2. Labware feasibility
- Is the labware mentioned real and compatible with the platform?
  (e.g. "corning_96_wellplate_360ul_flat" is valid for Opentrons; a made-up
  name is not.)
- Are there enough wells / slots for the described operations?
- If a tiprack is mentioned, is its volume range correct for the pipette?

### 3. Operation feasibility
- Are the described liquid-handling steps logically sound?
  (e.g. you cannot aspirate from an empty well; you cannot dispense more
  than you aspirated; you cannot mix 0 µL.)
- Is the order of operations correct?  (e.g. distribute diluent before
  serial dilution, not after.)
- Are there contradictions?  (e.g. "transfer 500 µL with a P20 pipette")

### 4. Platform / hardware feasibility
- Does the robot have enough deck slots for all the labware?
  (OT-2: 11 usable slots; Flex: up to 12 + staging; Hamilton STAR:
  varies by configuration.)
- Can the requested pipette type be mounted?  (e.g. OT-2 supports up to
  2 pipettes, left + right; Flex supports up to 2.)
- If modules are mentioned (temperature, magnetic, thermocycler, heater-shaker),
  are they compatible with the platform?

### 5. Logical consistency
- Are there any internal contradictions in the protocol description?
- Do the numbers add up?  (e.g. "96 samples in a 48-well plate" is
  impossible.)

---

**Response format — you MUST return valid JSON and nothing else:**

If the protocol is feasible (possibly with minor warnings):
```json
{
  "feasible": true,
  "issues": [],
  "summary": "The protocol is feasible."
}
```

If the protocol has **warnings** (feasible but worth noting):
```json
{
  "feasible": true,
  "issues": [
    {
      "severity": "warning",
      "category": "volume",
      "description": "Total diluent required (11 mL) is close to the reservoir well capacity (15 mL). Ensure sufficient diluent is loaded.",
      "suggestion": "Consider using a larger reservoir or splitting across two wells."
    }
  ],
  "summary": "The protocol is feasible with minor considerations."
}
```

If the protocol is **NOT feasible**:
```json
{
  "feasible": false,
  "issues": [
    {
      "severity": "error",
      "category": "volume",
      "description": "The requested transfer volume of 500 µL exceeds the P20 pipette's maximum capacity (20 µL).",
      "suggestion": "Use a P1000 pipette or reduce the transfer volume."
    }
  ],
  "summary": "The protocol cannot be executed as described."
}
```

Rules:
- severity is either "error" (blocks execution) or "warning" (can proceed
  but user should know).
- category is one of: volume, labware, operation, platform, logic.
- Return ONLY the JSON object.  No markdown fences, no explanation outside
  the JSON.
- If the request is vague but nothing is obviously wrong, return feasible
  with an empty issues list.
- Be practical: do not flag unlikely edge cases.  Focus on things that WILL
  fail or are clearly wrong.
"""


# ------------------------------------------------------------------ #
#  Public API                                                         #
# ------------------------------------------------------------------ #

def check_feasibility(consolidated_query: str, api_key: str | None = None) -> dict | None:
    """Run the feasibility check on a consolidated protocol query.

    Returns
    -------
    None
        If the protocol is feasible with no issues.
    dict
        ``{"feasible": bool, "issues": [...], "summary": str}``
        if there are warnings or errors.
    """
    client = OpenAI(api_key=api_key or get_api_key())

    response = client.responses.create(
        model=light_functions_model,
        input=[
            {"role": "system", "content": FEASIBILITY_PROMPT},
            {
                "role": "user",
                "content": (
                    "Please review the following consolidated protocol request "
                    "for feasibility:\n\n"
                    f"{consolidated_query}"
                ),
            },
        ],
    )

    raw = response.output_text.strip()

    # Strip markdown fences if the model wraps them anyway
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[1] if "\n" in raw else raw[3:]
        if raw.endswith("```"):
            raw = raw[:-3]
        raw = raw.strip()

    try:
        result = json.loads(raw)
    except json.JSONDecodeError:
        # Model returned something unparseable — assume feasible so we don't
        # block the pipeline on a formatting glitch.
        return None

    # Feasible with zero issues → nothing to report
    if result.get("feasible", True) and not result.get("issues"):
        return None

    return result


def format_feasibility_response(result: dict) -> str:
    """Turn a feasibility result dict into a user-friendly chat message.

    Called when the pipeline decides to stop and inform the user.
    """
    lines: list[str] = []

    if not result.get("feasible"):
        lines.append(
            "⚠️ **Protocol feasibility check failed** — the protocol as "
            "described cannot be executed.  Here's what I found:\n"
        )
    else:
        lines.append(
            "ℹ️ **Protocol feasibility notice** — the protocol can proceed, "
            "but please review the following:\n"
        )

    for issue in result.get("issues", []):
        severity_icon = "🔴" if issue["severity"] == "error" else "🟡"
        category = issue.get("category", "general").capitalize()
        lines.append(
            f"{severity_icon} **[{category}]** {issue['description']}"
        )
        if issue.get("suggestion"):
            lines.append(f"   💡 *Suggestion:* {issue['suggestion']}")
        lines.append("")  # blank line between issues

    summary = result.get("summary", "")
    if summary:
        lines.append(f"**Summary:** {summary}")

    if not result.get("feasible"):
        lines.append(
            "\nPlease adjust your request and try again, or let me know "
            "if you'd like help modifying the protocol."
        )

    return "\n".join(lines)