import os
import re
import subprocess
import numpy as np
import faiss
from datetime import datetime
import time
import json
from openai import OpenAI
import sys
import pickle
from config import get_api_key
from doc_loader import load_and_chunk_docs
from doc_fetcher import fetch_documentation

# ----------- ARGS & AUTH -------------
if len(sys.argv) > 1:
    user_query = sys.argv[1]
    chat_history = json.loads(sys.argv[2]) if len(sys.argv) > 2 else []
else:
    raise ValueError("Usage: python3 main_rag.py '<question>' '<chat_history_json>'")

user_api_key = get_api_key()
if not user_api_key:
    raise ValueError("API_KEY environment variable not set")


def get_openai_client(api_key):
    return OpenAI(api_key=api_key)


# ----------- HANDLER DETECTION -------------
HANDLERS_CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "handlers.json")

def load_handlers_config():
    """Load the handler registry from handlers.json."""
    if not os.path.exists(HANDLERS_CONFIG_PATH):
        return {
            "opentrons": {
                "name": "Opentrons",
                "docs_path": "docs/opentrons",
                "store_path": "rag_store_opentrons.pkl",
                "simulate_cmd": ["opentrons_simulate"],
                "keywords": ["opentrons", "ot-2", "ot2", "ot-3", "ot3", "flex"]
            }
        }
    with open(HANDLERS_CONFIG_PATH, "r") as f:
        return json.load(f)


def detect_handler(query, history, api_key):
    """
    Detect which liquid handler the user is referring to using LLM classification.
    If the handler isn't in handlers.json, creates a dynamic entry so
    the doc fetcher can find and download its documentation.
    """
    handlers = load_handlers_config()
    available_ids = list(handlers.keys())
    client = get_openai_client(api_key)

    # Build context from recent conversation
    recent = [m for m in history if m["role"] != "system"][-8:]
    conversation_context = "\n".join(
        f"{'User' if m['role'] == 'user' else 'Assistant'}: {m['content'][:500]}"
        for m in recent
    )

    # Build the known platforms description
    if available_ids:
        known_list = "\n".join(
            f'  - "{hid}" → {cfg["name"]}'
            for hid, cfg in handlers.items()
        )
    else:
        known_list = "  (none configured)"

    response = client.responses.create(
        model="gpt-5.4",
        input=[
            {
                "role": "system",
                "content": f"""You are an expert in lab automation and liquid handling robots.

Your task: identify which liquid handling PLATFORM (robot/instrument) the user is requesting a protocol for.

Here are the platforms already configured in our system:
{known_list}

INSTRUCTIONS:
1. Read the user's latest message AND the conversation history carefully.
2. Identify the liquid handling platform they are referring to.
3. If the platform matches one already configured, return its exact ID (the text in quotes above).
4. If the platform is NOT in the list above, return a new short lowercase ID for it. Use the brand name in lowercase, no spaces (e.g., "opentrons", "beckman", "agilent", "eppendorf", "gilson", "biomek").
5. If the user does NOT mention or imply any specific platform anywhere in the conversation, return "unknown".

IMPORTANT:
- Focus on the INSTRUMENT/ROBOT brand, not reagents, software, or lab techniques.
- Look at the ENTIRE conversation, not just the latest message — the platform may have been mentioned earlier.
- Common platforms include: Opentrons, Hamilton, Tecan, Beckman Coulter (Biomek), Agilent, Eppendorf, Gilson, PerkinElmer (JANUS), Formulatrix, Andrew Alliance, etc.

Return ONLY the platform ID. One word, lowercase, no quotes, no explanation."""
            },
            {
                "role": "user",
                "content": f"Conversation history:\n{conversation_context}\n\nLatest message: {query}"
            }
        ]
    )

    detected = response.output_text.strip().lower().strip('"').replace(" ", "_")

    # Known handler — return directly
    if detected in available_ids:
        return detected, handlers

    # "unknown" — default to first available, or opentrons
    if detected == "unknown":
        if available_ids:
            return available_ids[0], handlers
        detected = "opentrons"

    # New handler — ask the LLM for the proper display name
    name_response = client.responses.create(
        model="gpt-5.4",
        input=[
            {
                "role": "system",
                "content": "Return ONLY the official full name of this liquid handling robot platform/brand. No explanation, no punctuation, just the name (e.g., 'Opentrons OT-2', 'Hamilton STAR', 'Tecan Fluent')."
            },
            {
                "role": "user",
                "content": f"Platform ID: {detected}"
            }
        ]
    )
    handler_name = name_response.output_text.strip().strip("'\"")

    print(f"STEP:Detected new platform: {handler_name} (not in config — will search for docs)...", flush=True)
    time.sleep(2)

    handlers[detected] = {
        "name": handler_name,
        "docs_path": f"docs/{detected}",
        "store_path": f"rag_store_{detected}.pkl",
        "simulate_cmd": None,
        "validation_strategy": "llm_review",
        "output_type": "file",
        "keywords": [detected]
    }

    # Save to handlers.json so it persists across sessions
    try:
        with open(HANDLERS_CONFIG_PATH, "w") as f:
            json.dump(handlers, f, indent=4)
        print(f"STEP:Added {handler_name} to handlers config", flush=True)
    except Exception as e:
        print(f"WARNING: Could not save to handlers.json: {e}", flush=True)

    return detected, handlers


# ----------- SUFFICIENCY CHECK -------------
def check_sufficient_info(query, history, api_key):
    client = get_openai_client(api_key)

    recent = [m for m in history if m["role"] != "system"][-8:]
    conversation = "\n".join(
        f"{'User' if m['role'] == 'user' else 'Assistant'}: {m['content'][:500]}"
        for m in recent
    )

    response = client.responses.create(
        model="gpt-4o-mini",
        input=[
            {
                "role": "system",
                "content": """You are BioBot, an expert assistant in lab automation and liquid handling robots.

DO NOT GENERATE CODE, your job is only to check whether a user's protocol request contains enough information to generate a working script.

If you judge that there are enough infomations in the whole conversation, cause you were given the conversation history for that, ONLY reply with exactly: SUFFICIENT , nothing more.
Ask kindly for more informations if you assume that there are not enough informations in order to generate the code. You are specialized, you know what informations to ask depending on the user query. 
Always suggest kindly a default set up in order to help the user when he does not provide you with sufficient informations.
If the user asks you to use a default set up, complete a setup, choose some parameters along with the infos he gave you, do it and don't ask for informations then. This means that you will reply ONLY with exactly : SUFFICIENT."""
            },
            {
                "role": "user",
                "content": f"Conversation so far:\n{conversation}\n\nLatest request: {query}"
            }
        ]
    )

    answer = response.output_text.strip()
    if answer != "SUFFICIENT":
        print(answer, flush=True)
        sys.exit(0)


def consolidate_request(query, history, api_key):
    client = get_openai_client(api_key)

    recent = [m for m in history if m["role"] != "system"][-8:]
    conversation = "\n".join(
        f"{'User' if m['role'] == 'user' else 'Assistant'}: {m['content'][:500]}"
        for m in recent
    )

    response = client.responses.create(
        model="gpt-4o-mini",
        input=[
            {
                "role": "system",
                "content": """You are an expert in lab automation. 
Given a conversation between a user and an assistant about a protocol request, 
write a structered, complete, self-contained protocol description that consolidates 
ALL the information provided across the entire conversation. If the user mentioned the type of the output file he wants, mention it (example : txt, csv, python script, HSL etc..)

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
    client = get_openai_client(user_api_key)
    for i in range(retries):
        try:
            response = client.embeddings.create(
                model="text-embedding-3-small",
                input=text
            )
            return response.data[0].embedding
        except Exception as e:
            if "rate limit" in str(e).lower():
                print(f"Rate limit hit. Retry {i+1}/{retries} in {delay} sec...", file=sys.stderr)
                time.sleep(delay)
                delay *= 2
            else:
                raise
    raise RuntimeError("Failed to get embedding after retries.")


# ----------- COMPLETION -------------
def run_gpt(user_message, model="gpt-5.4"):
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

def validate_simulation(code, handler_config, save_path="generated_script.py"):
    """
    Strategy: SIMULATION
    Run the handler's simulator tool against the generated code.
    Returns (passed: bool, feedback: str)
    """
    simulate_cmd = handler_config.get("simulate_cmd")
    if not simulate_cmd:
        return True, ""

    with open(save_path, "w") as f:
        f.write(code)

    result = subprocess.run(simulate_cmd + [save_path], capture_output=True, text=True)
    stdout, stderr = result.stdout, result.stderr

    if "Error" not in stderr and "Traceback" not in stderr and stdout.strip():
        return True, ""
    else:
        return False, stderr.strip()


def validate_llm_review(code, handler_config, context_chunks, question):
    """
    Strategy: LLM_REVIEW
    Ask the LLM to review the generated code against the handler's documentation,
    known API patterns, syntax rules, and best practices.
    Returns (passed: bool, feedback: str)
    """
    handler_name = handler_config["name"]
    output_type = handler_config.get("output_type", "script")


    client = get_openai_client(user_api_key)
    response = client.responses.create(
        model="gpt-5.4",
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


def validate_code(code, handler_config, context_chunks, question, save_path="generated_script.py"):
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


# ----------- INDEX MANAGEMENT -------------
# Resolve all paths relative to this script's directory
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

def load_or_build_index(handler_id, handler_config, chunk_size=3000):
    """
    Load the FAISS index for a handler from its pickle store,
    or build it from the docs folder if it doesn't exist.
    """
    docs_path = os.path.join(SCRIPT_DIR, handler_config["docs_path"])
    store_path = os.path.join(docs_path, handler_config["store_path"])

    if os.path.exists(store_path):
        print(f"STEP:Loading {handler_config['name']} documentation index...", flush=True)
        time.sleep(1)
        with open(store_path, "rb") as f:
            store = pickle.load(f)
        chunks = store["chunks"]
        chunk_sources = store["chunk_sources"]
        text_embeddings = store["embeddings"]
    else:
        # Check if docs folder exists and has content (including subfolders)
        has_local_docs = False
        if os.path.exists(docs_path):
            for root, dirs, files in os.walk(docs_path):
                for f in files:
                    if os.path.splitext(f)[1].lower() in ('.rst', '.pdf', '.txt'):
                        has_local_docs = True
                        break
                if has_local_docs:
                    break

        if not has_local_docs:
            # No local docs — try to fetch from the web
            handler_name = handler_config["name"]
            handler_keywords = handler_config.get("keywords", [])
            fetched = fetch_documentation(handler_name, handler_keywords, docs_path, user_api_key)

            if not fetched:
                print(f"STEP:Could not obtain documentation for {handler_name}", flush=True)
                time.sleep(2)
                return [], [], None

        print(f"STEP:Building {handler_config['name']} documentation index...", flush=True)
        chunks, chunk_sources = load_and_chunk_docs(docs_path, chunk_size)

        if not chunks:
            print(f"STEP:No parseable documents found in {docs_path}", flush=True)
            time.sleep(2)
            return [], [], None

        text_embeddings = np.array([get_text_embedding_with_retry(chunk) for chunk in chunks])

        # Save the index for future use
        os.makedirs(os.path.dirname(store_path), exist_ok=True)
        try:
            with open(store_path, "wb") as f:
                pickle.dump({
                    "chunks": chunks,
                    "chunk_sources": chunk_sources,
                    "embeddings": text_embeddings
                }, f)
            print(f"STEP:Index saved to {store_path}", flush=True)
        except Exception as e:
            print(f"WARNING: Could not save index: {e}", flush=True)

    d = text_embeddings.shape[1]
    index = faiss.IndexFlatL2(d)
    index.add(text_embeddings)

    return chunks, chunk_sources, index


# ----------- MAIN PIPELINE -------------
def run_query_and_fix(question, chunks, chunk_sources, index, handler_config, max_attempts=3):
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
    
    prompt_nodoc = f"""
Given your prior knowledge, answer the query.
Generate a complete, functional {output_type} script for the {handler_name} platform.
Query: {question}
"""

    prompt = f"""
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
            response = run_gpt(prompt_nodoc)
            code = response
        
        else:
            
            response = run_gpt(prompt)
            code = response
            
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


# ============================================================
# EXECUTION
# ============================================================

# 1. Check if we have enough info (skip for one-shot mode)
if not os.environ.get("BIOBOT_SKIP_SUFFICIENT_CHECK"):
    check_sufficient_info(user_query, chat_history, user_api_key)

# 2. Consolidate the request
consolidated_query = consolidate_request(user_query, chat_history, user_api_key)

# 3. Detect which handler the user needs
handler_id, handlers = detect_handler(user_query, chat_history, user_api_key)
handler_config = handlers[handler_id]
print(f"STEP:Detected platform: {handler_config['name']}", flush=True)
time.sleep(1)

# 4. Load or build the index for this handler
chunks, chunk_sources, index = load_or_build_index(handler_id, handler_config)

if index is None or not chunks:
    print(f"STEP:No documentation available for {handler_config['name']}. "
          f"Please add documents to {handler_config['docs_path']}/", flush=True)
    # Give the user a friendly message as the final output
    print(f"I couldn't find any documentation for {handler_config['name']}. "
          f"To generate accurate protocols, please add documentation files "
          f"(PDF, RST, or TXT) to the {handler_config['docs_path']}/ folder.", flush=True)
    sys.exit(0)

# 5. Run the RAG pipeline
final_code, sources_used, file_refs, attempts, last_error, last_code = \
    run_query_and_fix(consolidated_query, chunks, chunk_sources, index, handler_config)

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
        if first_line.startswith(("import ", "from ", "#!/", "def ", "class ")):
            fmt = "python"
        elif "," in first_line and not first_line.startswith(("#", "import", "from", "def")):
            fmt = "csv"
        elif content.startswith(("{", "[")):
            fmt = "json"
        elif content.startswith("<?xml") or (content.startswith("<") and not content.startswith("#")):
            fmt = "xml"
        else:
            fmt = "text"

    print(f"FORMAT:{fmt}", flush=True)
    print(content)
else:
    print("STEP:Generation failed — preparing last attempt for review...", flush=True)
    time.sleep(2)
    fail_msg = (
        "I wasn't able to generate a fully functional script after several attempts. "
        "The simulation kept returning errors that I couldn't resolve automatically. "
        "Here is the latest version of the script I generated — it may need some manual adjustments:"
    )
    print("FAILED_CODE:" + fail_msg + "___CODE_SEP___" + (last_code or "# No code was generated."), flush=True)