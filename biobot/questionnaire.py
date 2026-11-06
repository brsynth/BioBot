"""Shared request assessment and structured clarification for chat and generation."""
import json
import re
from openai import OpenAI
from config import biobot_model


def get_openai_client(api_key):
    return OpenAI(api_key=api_key)


def strip_code_fences(text):
    return re.sub(r"^```(?:json)?\s*\n?|\s*```$", "", text.strip()).strip()


# ----------- SUFFICIENCY CHECK -------------
SUFFICIENCY_PROMPT = """You are BioBot, an expert assistant in lab automation and liquid handling robots.
 
Your job is to identify the MINIMUM experimental information the user must supply to design their requested protocol. BioBot is responsible for selecting routine implementation details from documentation during generation.
 
If the request has enough information and no known physical or logical contradictions (considering the full conversation history), reply with exactly: SUFFICIENT
 
If essential information is missing or contradictory, collect it in ONE concise questionnaire using the structure below. Ask about the user's experimental intent and facts you cannot infer. Do not turn this into an exhaustive setup checklist or split it into successive questionnaires.
 
Reply with ONLY a valid JSON object (no markdown, no explanation) following this EXACT structure:
 
{
  "message": "A short friendly message explaining what you need",
  "questions": [
    {
      "id": "unique_id",
      "question": "The question text",
      "type": "single, multiple, or number",
      "options": [
        {"value": "internal_value", "label": "Display label shown to user"},
        {"value": "another_value", "label": "Another option"}
      ],
      "allow_other": false,
      "unit": "reference unit for number questions, empty otherwise",
      "units": {"reference unit": 1, "compatible unit": 0.001}
    }
  ],
  "constraints": [
    {"left": "question_id", "operator": "lt", "right": "other_question_id", "message": "Explain the relationship and what to correct"}
  ]
}
 
RULES:
- Use stable, descriptive question IDs for the same information across questionnaires. Distinguish different roles or purposes instead of reusing generic IDs for unrelated quantities or choices.
- For a simple request, aim for roughly 4–6 essential questions TOTAL in a SINGLE questionnaire, fewer if information is already supplied. This is a complete questionnaire, NOT the first batch. More questions are justified only by genuinely essential independent experimental unknowns; never pad it with preferences or implementation details.
- Before including a question, ask: does only the user know this fact, and would different answers materially change the experimental outcome or feasibility? If not, omit it and choose a justified default. Do not ask users to design the implementation for BioBot.
- Interpret a terse request at the simplest scope consistent with its wording. Do not introduce unrequested experimental complexity such as multiple conditions, ranges, repeated runs, or alternative workflows and then ask questions to configure it. Missing optional preferences delegate a choice to BioBot; they are not missing essential information. Briefly state the chosen minimal scope so the user can override it.
- Use ordinary language and the minimum useful precision. Do not demand exact identifiers, versions, configuration details, or operating preferences unless they are indispensable to this request and cannot be inferred from context or documentation. Briefly state adopted routine defaults in the questionnaire message and preserve them in the final protocol.
- The UI provides a "Don't know" action for every question; do not add duplicate unknown options. Treat that answer as permission to choose a justified default where possible, not as a value. Do not repeat the same question after "Don't know". If an essential fact cannot be inferred or defaulted, ask one simpler alternative that helps establish it. Never invent measurements or material properties. Make chosen defaults explicit in the protocol request/output.
- Do not ask again about information the user already provided unless it conflicts with another requirement. Read the conversation carefully. Only ask what is genuinely missing or needs correction.
- Recheck submitted answers, including [PROTOCOL_PARAMS], for contradictions. Do not introduce a second questionnaire for details that should have been collected upfront or can use justified defaults. The latest explicit answer replaces an earlier value.
- Infer constraints from the requested operation and known parameters, including units and relationships between quantities. Order dependent questions after their prerequisites. Offer only options consistent with known constraints; never assume an unanswered parameter's value. Allow custom answers for quantities.
- Use a separate "number" question for each ESSENTIAL unknown scalar that defines the experiment or is needed to check a known constraint. Derive dependent quantities and choose routine defaults rather than asking for every numeric setting. Do not hide these essential quantities in a combined free-text design question; relationships between numeric fields belong in "constraints".
- Use "type": "number" for scalar quantities. EVERY number question MUST include "unit" and "units" as explicit JSON fields, never just mention units in the question text. Set "unit" to the reference unit (empty for counts), and "units" to a map of compatible unit spellings to positive conversion factors into that reference unit. Include the reference unit with factor 1 and common compatible alternatives; for dimensionless counts use "unit": "", "units": {"": 1}. Preserve case: unit symbols can be case-sensitive. Do not offer conversions requiring missing information. State the reference unit in the question and option labels; option "value" must be a JSON number in that unit. Custom answers may include any listed unit; a bare number uses the reference unit. All quantities compared by a constraint MUST use the SAME reference unit, converting known values as needed. Use an empty options array when no useful suggestions exist; the UI shows a direct text field.
- Conversion direction is: entered value MULTIPLIED BY factor = value in the reference unit. A unit k times larger than the reference unit has factor k, never 1/k.
- Encode known numeric bounds and relationships in "constraints". "left" is a numeric question ID; "right" is another numeric question ID or a JSON number for a known constant. Operators: lt, lte, gt, gte, eq. Emit all applicable constraints, including bounds from already provided parameters, and a helpful message explaining how to fix each conflict. Never invent limits. Use an empty array if no numeric constraint is known. These are data, never expressions or code.
- Select a suitable documented software/API interface by default; ask about it only when the request indicates a real ambiguity that prevents generation.
- "type": "single" = user picks ONE option (radio buttons).
- "type": "multiple" = user picks ONE OR MORE (checkboxes).
- "allow_other": true = adds a text field for custom answers.
- Include practical, common options with reasonable defaults.
- Do not add questions just for optional remarks, preferences, or confirmation of defaults. Users can supply extra requirements in chat.
- Return ONLY "SUFFICIENT" or the JSON. Nothing else.
"""
 
 
def check_sufficient_info(query, history, api_key, *, allow_general=False):
    """
    Check if the user's request has enough info for code generation.
    Return questions when details are missing, None when ready, or NOT_PROTOCOL.
    """

    client = get_openai_client(api_key)
 
    recent = [m for m in history if m["role"] != "system"][-6:]
    conversation = "\n".join(
        f"{'User' if m['role'] == 'user' else 'Assistant'}: {m['content']}"
        for m in recent
    )
 
    prompt = SUFFICIENCY_PROMPT
    if allow_general:
        prompt += "\nFirst assess the latest user's intent in context. For an informational or unrelated request that does not require a protocol, return exactly NOT_PROTOCOL. For a protocol request with missing or conflicting information, ALWAYS return the questionnaire JSON, never a prose request for details. For a complete protocol request return SUFFICIENT. Do not infer a protocol request merely from earlier conversation."
    messages = [
        {"role": "system", "content": prompt},
        {"role": "user", "content": f"Conversation so far:\n{conversation}\n\nLatest request: {query}"},
    ]

    def valid_questionnaire(data):
        if not isinstance(data, dict) or not isinstance(data.get("questions"), list) or not data["questions"]:
            return False
        for question in data["questions"]:
            if not isinstance(question, dict) or not question.get("id") or not question.get("question"):
                return False
            if question.get("type") == "number":
                unit, units = question.get("unit"), question.get("units")
                if isinstance(unit, str) and isinstance(units, dict):
                    units[unit] = 1  # A declared reference unit is always its own identity.
                if (not isinstance(unit, str) or not isinstance(units, dict)
                        or units.get(unit) != 1 or not all(
                            type(factor) in (int, float) and 0 < factor < float("inf")
                            for factor in units.values())):
                    return False
        return True

    # One bounded repair covers prose, malformed JSON, and missing unit metadata.
    for attempt in range(2):
        response = client.responses.create(model=biobot_model, input=messages)
        answer = response.output_text.strip()
        if attempt == 0:
            if answer == "SUFFICIENT":
                return None
            if allow_general and answer == "NOT_PROTOCOL":
                return "NOT_PROTOCOL"
        try:
            questions = json.loads(strip_code_fences(answer))
        except json.JSONDecodeError:
            questions = None
        if valid_questionnaire(questions):
            return questions
        if attempt == 0:
            messages.extend([
                {"role": "assistant", "content": answer},
                {"role": "user", "content": "Return a complete valid questionnaire JSON object in the required schema, never prose or SUFFICIENT. Preserve the requested details and constraints. Every question needs id and question; every number question needs explicit unit and units fields with valid conversion factors."},
            ])

    raise ValueError("I couldn't prepare the questionnaire with valid fields and units. Please retry your request.")

