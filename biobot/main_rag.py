import os
import re
import subprocess
import numpy as np
import time
import json
import tempfile
from openai import OpenAI
import sys
from config import get_api_key, biobot_model, light_functions_model
from documentation_index import load_or_build_index, get_text_embedding_with_retry as _embed
from feasibility_check import check_feasibility, format_feasibility_response
from handlers import detect_handler
from questionnaire import check_sufficient_info
import protocol_lang


def strip_code_fences(text):
    """Remove markdown code fences (```python ... ```) that LLMs wrap around code.
    If the text is wrapped in fences, return the inner content; otherwise return as-is."""
    stripped = text.strip()
    m = re.match(r'^```\w*\s*\n([\s\S]*?)```\s*$', stripped)
    if m:
        return m.group(1).strip()
    return stripped


# ----------- ARGS & AUTH -------------
if len(sys.argv) > 1:
    user_query = sys.argv[1]
    chat_history = json.loads(sys.argv[2]) if len(sys.argv) > 2 else []
else:
    raise ValueError("Usage: python3 main_rag.py '<question>' '<chat_history_json>'")

user_api_key = get_api_key()
if not user_api_key:
    raise ValueError("API_KEY environment variable not set")
# Export implements a saved protocol as device code; otherwise BioBot designs the protocol.
export_mode = bool(os.environ.get("BIOBOT_EXPORT"))


def get_openai_client(api_key):
    return OpenAI(api_key=api_key)




def consolidate_request(query, history, api_key):
    client = get_openai_client(api_key)

    recent = [m for m in history if m["role"] != "system"][-8:]
    conversation = "\n".join(
        f"{'User' if m['role'] == 'user' else 'Assistant'}: {m['content']}"
        for m in recent
    )

    response = client.responses.create(
        model=light_functions_model,
        input=[
            {
                "role": "system",
                "content": """You are an expert in lab automation. 
Given a conversation between a user and an assistant about a protocol request, 
write a structered, complete, self-contained protocol description that consolidates 
ALL the information provided across the entire conversation. Preserve the requested output language or file format; otherwise use the format documented for the selected device.
Preserve "Don't know" answers as delegated choices, not supplied facts. Distinguish justified defaults from unresolved essential facts, retain actual values and units, and require adopted defaults to be stated explicitly in the output.

Note that the request will be sent to an LLM. Restructure it and write it in natural langage in 3th person (the user wants to...) describing what the user wants to do, as if he had provided everything upfront.
Return ONLY the consolidated request. No preamble, no explanation."""
            },
            {
                "role": "user",
                "content": f"Conversation:\n{conversation}\n\nLatest message: {query}"
            }
        ]
    )
    return response.output_text.strip()


# ----------- EMBEDDINGS -------------
def get_text_embedding_with_retry(text, retries=5, delay=2):
    return _embed(text, user_api_key, retries, delay)


# ----------- COMPLETION -------------
def run_gpt(user_message, model=biobot_model):
    client = get_openai_client(user_api_key)
    messages = [
        {
            "role": "system",
            "content": "You are an expert assistant specialized in lab automation with every kind of liquid handler. Generate full, clean and functional file for lab automation protocols. You assist the user, don't let him finish your job or fill something. Don't let anything empty, you should be sure that you completed anything no matter the file type or liquid handler."
        },
        {
            "role": "user",
            "content": user_message
        }
    ]
    response = client.responses.create(
        model=model,
        input=messages
    )
    return response.output_text


# ----------- VALIDATION STRATEGIES -------------

def validate_simulation(code, handler_config, save_path=None):
    """
    Strategy: SIMULATION
    Run the handler's simulator tool against the generated code.
    Returns (passed: bool, feedback: str)
    """
    simulate_cmd = handler_config.get("simulate_cmd")
    if not simulate_cmd:
        return True, ""

    try:
        with tempfile.TemporaryDirectory(prefix="biobot-validation-") as directory:
            extension = handler_config.get("file_extension", ".txt")
            if not isinstance(extension, str) or not re.fullmatch(r"\.[a-zA-Z0-9]{1,16}", extension):
                extension = ".txt"
            path = save_path or os.path.join(directory, "protocol" + extension)
            with open(path, "w") as f:
                f.write(code)
            full_cmd = simulate_cmd + [path]
            print(f"STEP:Running simulation: {' '.join(simulate_cmd)}", flush=True)
            result = subprocess.run(full_cmd, capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired:
        return False, "Simulation timed out after 120 seconds."

    # Primary check: return code (0 = success for any CLI tool)
    if result.returncode == 0:
        print(f"STEP:Simulation passed (exit code 0)", flush=True)
        return True, ""

    # Non-zero return code — build useful feedback from stderr + stdout
    feedback_parts = []
    if result.stderr.strip():
        feedback_parts.append(result.stderr.strip())
    if result.stdout.strip():
        feedback_parts.append(result.stdout.strip())
    return False, "\n".join(feedback_parts) if feedback_parts else "Simulation failed (non-zero exit code)."


def validate_llm_review(code, handler_config, context_chunks, question):
    """
    Strategy: LLM_REVIEW
    Ask the LLM to review the generated code against the handler's documentation,
    known API patterns, syntax rules, and best practices.
    Returns (passed: bool, feedback: str)
    """
    handler_name = handler_config["name"]
    output_type = handler_config.get("output_type", "script")


    client = get_openai_client(user_api_key).with_options(timeout=120, max_retries=0)
    response = client.responses.create(
        model=biobot_model,
        tools=[{"type": "web_search"}],
        input=[
            {
                "role": "system",
                "content": f"""You are a specialized reviewer in {handler_name} liquid handling protocol automation.

Your task is to analyze and compare a generated {output_type} script for a {handler_name} robot with similar existing protocols, files and references in order to determine if it is correct and functional.

You have access to web search. USE IT to look up the official {handler_name} documentation, verify function signatures, check valid labware names, and confirm correct usage patterns.

Note that sometimes, the generated output can be a script to generate another file usable for the liquid handler (example: python script to generate csv file that will be used). Make sure to make the difference and analyze the logic of the usable file.

RESPONSE FORMAT:
- If the code is correct and would work: respond with exactly and only "PASS".
- If there are issues: explain why

Don't be strict and accurate. Minor issues are not failures. Focus on big issues that would prevent the code from working correctly on a real {handler_name} instrument. You PASS if the file has the minimal satisfied conditions."""
            },
            {
                "role": "user",
                "content": f"User's request: {question}\n\nGenerated script to review:\n```\n{code}\n```"
            }
        ]
    )

    review = response.output_text.strip()
    review = str(review)

    if "pass" in review.lower():
        return True, "PASS"
    else:
        # Extract the feedback (everything after "FAIL")
        feedback = review
        return False, feedback


def validate_code(code, handler_config, context_chunks, question, save_path=None):
    """
    Unified validation dispatcher.
    Routes to the correct strategy based on handler_config["validation_strategy"].
    Returns (passed: bool, feedback: str)
    """
    strategy = handler_config.get("validation_strategy", "llm_review")

    if strategy == "simulation":
        return validate_simulation(code, handler_config, save_path)
    elif strategy == "llm_review":
        return validate_llm_review(code, handler_config, context_chunks, question)
    else:
        # Unknown strategy — fall back to LLM review
        print(f"WARNING: Unknown validation strategy '{strategy}', using llm_review", flush=True)
        return validate_llm_review(code, handler_config, context_chunks, question)


# ----------- REVERSE CHECK -------------
def reverse_check(user_query, generated_code, handler_name):
    """
    Verify if the generated code actually matches the user's intention.
    """
    reverse_prompt = f"""
    You are an expert lab assistant in scripts for {handler_name} laboratory robots.

    Here is a script:
    ```
    {generated_code}
    ```
    
    And this is what the user requested: "{user_query}"

    Does this script match what the user requested? Just in a general point of view, we don't need a precise comparison.
    Answer strictly with "Yes" or "No", followed by a short explanation.
    If the answer is no, ALWAYS suggest a corrected script right after.
    """
    verdict = run_gpt(reverse_prompt).strip()
    return verdict


def run_query_and_fix(question, chunks, chunk_sources, index, handler_config, max_attempts=5):
    print("STEP:Analyzing your request...", flush=True)
    question_embedding = np.array([get_text_embedding_with_retry(question)])

    print("STEP:Searching documentation for relevant context...", flush=True)
    D, I = index.search(question_embedding, k=5)
    retrieved_chunks = [chunks[i] for i in I.tolist()[0]]
    retrieved_sources = [chunk_sources[i] for i in I.tolist()[0]]

    context = "\n\n".join(retrieved_chunks)
    handler_name = handler_config["name"]
    strategy = handler_config.get("validation_strategy", "llm_review")
    output_type = handler_config.get("output_type", "script")

    prompt_rag = f"""
Context information is below.
---------------------
{context}
---------------------
Given the context information and/or prior knowledge, answer the query.
Generate a complete, functional {output_type} script for the {handler_name} platform.
Query: {question}
"""
    print("STEP:Generating protocol...", flush=True)
    last_error = ""
    last_code = ""

    strategy_label = "simulation" if strategy == "simulation" else "LLM review"

    for attempt in range(1, max_attempts + 1):
        
        if attempt == 1:
            response = run_gpt(prompt_rag)
            code = strip_code_fences(response)

        else:
            response = run_gpt(prompt)
            code = strip_code_fences(response)

        if not code:
            break

        last_code = code

        print(f"STEP:Attempt {attempt} — validating via {strategy_label}...", flush=True)
        time.sleep(1)
        passed, feedback = validate_code(code, handler_config, retrieved_chunks, question)

        if passed and strategy_label == "simulation":
            print("STEP:Validation passed — verifying semantic intent...", flush=True)
            verdict = reverse_check(question, code, handler_name)
            blocks = re.findall(r"```(?:\w*)\n(.*?)```", verdict, re.DOTALL)
            if blocks:
                suggested_code = blocks[0].strip()
                # Re-validate the suggested code too
                passed2, _ = validate_code(suggested_code, handler_config, retrieved_chunks, question)
                if passed2:
                    code = suggested_code
            print("STEP:All checks passed! Returning final code...", flush=True)
            time.sleep(2)
            return code, retrieved_chunks, retrieved_sources, attempt, "", code
        
        if passed:
            print("STEP:All checks passed! Returning final code...", flush=True)
            time.sleep(2)
            return code, retrieved_chunks, retrieved_sources, attempt, "", code
            

        print(f"STEP:Validation failed on attempt {attempt} — correcting errors...", flush=True)
        prompt = f"""
The following {output_type} output for the {handler_name} platform has issues:

{feedback}

Here is the file that needs fixing:
{code}

Original user request: {question}

Please correct ALL the issues listed above and return the full corrected output.
Do not ask me to complete anything — return the complete, working output file."""

        last_error = feedback

    return None, retrieved_chunks, retrieved_sources, attempt, last_error, last_code


def _json_answer(prompt):
    return json.loads(strip_code_fences(run_gpt(prompt)))


def _expected_end_state(question, protocol):
    """Expected final volumes, written from the request alone (never from the program)."""
    answer = _json_answer(
        "From this request only, state the final volume of every well whose content follows from it. "
        f"Use these labware ids: {json.dumps(protocol.get('labware'))} and parameters: {json.dumps(protocol.get('parameters'))}. "
        'Return ONLY JSON: {"expected": [{"at": "labware_id:WELLS", "volume_ul": number}]}, WELLS as "A1", "A1,A2" or "B2..B6". '
        f"Leave out wells you cannot derive.\n\nRequest: {question}")
    return answer.get("expected", []) if isinstance(answer, dict) else []


def design_protocol(question, chunks, index, handler_config, max_attempts=3):
    """Write the request in the BioBot language, grounded in the device documentation.
    Returns (protocol text, problems): problems is empty when it expands cleanly and
    reaches the end state expected from the request."""
    print("STEP:Searching documentation for relevant context...", flush=True)
    _, found = index.search(np.array([get_text_embedding_with_retry(question)]), k=5)
    context = "\n\n".join(chunks[i] for i in found.tolist()[0])
    prompt = (f"Documentation for {handler_config['name']}:\n---\n{context}\n---\n"
              f"Write this request as a protocol for BioBot's simulator; device code is generated later.\n{protocol_lang.LANGUAGE_SPEC}\n\nRequest: {question}")
    expected, text, problems = None, "", []
    for attempt in range(1, max_attempts + 1):
        print(f"STEP:Attempt {attempt} — writing and checking the protocol...", flush=True)
        try:
            text = strip_code_fences(run_gpt(prompt))
            protocol = json.loads(text)
            protocol_lang.expand(protocol)
            if expected is None:
                expected = _expected_end_state(question, protocol)
            problems = protocol_lang.end_state_mismatches(protocol, expected)
        except ValueError as error:  # invalid JSON or a ProtocolError
            problems = [str(error)]
        if not problems:
            return json.dumps(protocol, indent=2, ensure_ascii=False), []
        prompt += f"\n\nYour previous protocol:\n{text}\nfails these checks:\n- " + "\n- ".join(problems) + "\nReturn the corrected protocol."
    return text, problems


def read_back_difference(code, handler_config, protocol):
    """Translate exported code back into the BioBot language; describe how its liquid movements differ."""
    print("STEP:Checking that the code reproduces the protocol...", flush=True)
    try:
        back = _json_answer(
            f"Translate this {handler_config['name']} script into the BioBot protocol language, describing only what the script does. "
            f"Reuse these labware and liquids declarations: {json.dumps({k: protocol.get(k) for k in ('labware', 'instruments', 'liquids')})}.\n"
            f"{protocol_lang.LANGUAGE_SPEC}\n\nScript:\n{code}")
        got, want = protocol_lang.movements(back), protocol_lang.movements(protocol)
    except ValueError as error:
        return f"the script could not be read back: {error}"
    if got == want:
        return ""
    i = next((i for i, (a, b) in enumerate(zip(got, want)) if a != b), min(len(got), len(want)))
    return (f"the script makes {len(got)} transfers instead of {len(want)}; first difference at transfer {i + 1}: "
            f"script {got[i] if i < len(got) else 'nothing'}, protocol {want[i] if i < len(want) else 'nothing'}")


# ============================================================
# EXECUTION
# ============================================================

# 1. Check if we have enough info (skip for one-shot mode)
if not os.environ.get("BIOBOT_SKIP_SUFFICIENT_CHECK"):
    try:
        questions = check_sufficient_info(user_query, chat_history, user_api_key)
    except ValueError as error:
        print(str(error), flush=True)
        sys.exit(0)
    if questions is not None:
        print("QUESTIONS:" + json.dumps(questions), flush=True)
        sys.exit(0)

# 2. Consolidate the request
if export_mode:
    consolidated_query = ("Implement exactly this structured protocol on its device. Preserve its hardware, "
                          "positions, liquids, parameters and operation order:\n" + user_query)
    feasibility_result = None
else:
    consolidated_query = consolidate_request(user_query, chat_history, user_api_key)
    # 2b. Feasibility check — is the protocol physically/logically possible?
    print("STEP:Checking protocol feasibility...", flush=True)
    feasibility_result = check_feasibility(consolidated_query, user_api_key)

if feasibility_result is not None:
    if not feasibility_result.get("feasible"):
        # Protocol is NOT feasible — tell user and stop
        print(format_feasibility_response(feasibility_result), flush=True)
        sys.exit(0)
    else:
        # Feasible with warnings — print them inline and continue
        warnings_msg = format_feasibility_response(feasibility_result)
        print(warnings_msg, flush=True)

# 3. Detect which handler the user needs
handler_id, handlers = detect_handler(consolidated_query, chat_history, user_api_key)
if handler_id is None:
    print("QUESTIONS:" + json.dumps({
        "message": "Which robot or instrument should this protocol use?",
        "questions": [{"id": "platform", "question": "Robot/instrument and model",
                       "type": "single", "options": []}]
    }), flush=True)
    sys.exit(0)
handler_config = handlers[handler_id]
print("STEP:__DEVICE__:" + handler_config.get("name", handler_id), flush=True)
print(f"STEP:Detected platform: {handler_config['name']}", flush=True)
time.sleep(1)

# 4. Load or build the index for this handler
chunks, chunk_sources, index = load_or_build_index(handler_id, handler_config, api_key=user_api_key)

if index is None or not chunks:
    print(f"STEP:No documentation available for {handler_config['name']}. "
          f"Please add documents to {handler_config['docs_path']}/", flush=True)
    # Give the user a friendly message as the final output
    print(f"I couldn't find any documentation for {handler_config['name']}. "
          f"To generate accurate protocols, please add documentation files "
          f"(PDF, RST, or TXT) to the {handler_config['docs_path']}/ folder.", flush=True)
    sys.exit(0)

# 5. Design the protocol for the simulator; device code is generated only at export.
if not export_mode:
    protocol, problems = design_protocol(consolidated_query, chunks, index, handler_config)
    print("FORMAT:json", flush=True)
    if problems:
        print("FAILED_CODE:The protocol still fails these checks:\n- " + "\n- ".join(problems) + "___CODE_SEP___" + protocol, flush=True)
    else:
        print(protocol, flush=True)
    sys.exit(0)

# Export: the code, read back into the BioBot language, should make the same liquid movements.
# A validated script is kept even if the read-back still differs; the difference is reported as a warning.
source_protocol = protocol_lang.parse(user_query)
for attempt in range(2):
    final_code, sources_used, file_refs, attempts, last_error, last_code = \
        run_query_and_fix(consolidated_query, chunks, chunk_sources, index, handler_config)
    difference = final_code and source_protocol and read_back_difference(final_code, handler_config, source_protocol)
    if not difference:
        break
    if attempt == 0:
        consolidated_query += f"\n\nA previous script did not reproduce the protocol: {difference}."
if difference:
    print(f"STEP:__WARNING__:The code passed validation, but reading it back found a difference with the protocol: {difference}. Check it before running.", flush=True)

if final_code:
    # Detect the output format from the content
    content = final_code.strip()

    # Priority 1: Check if the LLM wrapped the output in markdown fences (```format ... ```)
    fence_match = re.match(r'^```(\w+)\s*\n([\s\S]*?)```\s*$', content)
    if fence_match:
        fmt = fence_match.group(1).lower()
        content = fence_match.group(2).strip()
        # Normalize common aliases
        fmt_map = {"py": "python", "javascript": "js", "yml": "yaml"}
        fmt = fmt_map.get(fmt, fmt)
    else:
        # Priority 2: Detect from content itself
        first_line = content.split("\n")[0]
        if first_line.startswith(("import ", "from ", "def ", "class ")) or re.match(r"^#!.*\bpython[\d.]*\b", first_line):
            fmt = "python"
        elif "," in first_line and not first_line.startswith(("#", "import", "from", "def")):
            fmt = "csv"
        elif content.startswith(("{", "[")):
            fmt = "json"
        elif content.startswith("<?xml") or (content.startswith("<") and not content.startswith("#")):
            fmt = "xml"
        else:
            fmt = handler_config.get("output_format", "text")

    print(f"FORMAT:{fmt}", flush=True)
    print(content)
else:
    print("STEP:Generation failed — preparing last attempt for review...", flush=True)
    time.sleep(2)
    fail_msg = (
        "I wasn't able to generate a fully functional script after several attempts. "
        f"Validation kept failing: {(last_error or 'no details').strip()[:600]} "
        "Here is the latest version of the script I generated — it may need some manual adjustments:"
    )
    print("FAILED_CODE:" + fail_msg + "___CODE_SEP___" + (last_code or "# No code was generated."), flush=True)
