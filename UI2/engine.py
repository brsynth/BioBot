import subprocess
import json
from openai import OpenAI
import os
from config import get_api_key
    
MODEL_NAME_CLASS = "gpt-4o-mini"
MODEL_NAME = "gpt-5.4"

def get_openai_client(api_key=None):
    return OpenAI(api_key=api_key or get_api_key())

def classify_prompt(prompt, chat_history=None, model_name=MODEL_NAME_CLASS, api_key=None):
    client = get_openai_client(api_key)

    # Build a conversation snippet (last 6 non-system messages) for context
    context_block = ""
    if chat_history:
        recent = [m for m in chat_history if m["role"] != "system"][-6:]
        if recent:
            lines = []
            for m in recent:
                role_label = "User" if m["role"] == "user" else "Assistant"
                # Truncate long messages so the classifier prompt stays small
                content = m["content"][:300] + "..." if len(m["content"]) > 300 else m["content"]
                lines.append(f"{role_label}: {content}")
            context_block = "\n\nRecent conversation:\n" + "\n".join(lines)

    classification_prompt = [
        {
            "role": "system",
            "content": """You are a classifier assistant. You will be given a user message, and optionally the recent conversation that preceded it.

Classify the LATEST user message according to 3 categories:

1. "code" : The user is asking for code generation, a protocol script, or an automation — including cases where the user is providing parameters, details, or clarifications in response to a previous assistant request for more information about a protocol (e.g. pipette type, plate name, volumes). If the conversation context shows a code generation was being discussed and the latest message continues that thread, classify as "code".
2. "general" : The user is asking a question in the field of lab automation or liquid handlers, without asking for a script.
3. "out" : The request is out of scope and unrelated to lab automation.

Return ONLY one word: code, general, or out. No explanation, no punctuation."""
        },
        {
            "role": "user",
            "content": f"Latest message: {prompt}{context_block}"
        }
    ]

    response = client.responses.create(
        model=model_name,
        input=classification_prompt
    )
    return response.output_text.strip().lower()

def run_gpt(chat_history, model=MODEL_NAME, api_key=None):
    client = get_openai_client(api_key)
    """
    chat_history: liste de dicts [{'role': 'system'/'user'/'assistant', 'content': ...}]
    """
    # On prend max 9 derniers messages + system
    system_msg = next((m for m in chat_history if m["role"] == "system"), None)
    non_system_msgs = [m for m in chat_history if m["role"] != "system"]
    non_system_msgs = non_system_msgs[-9:]
    messages = [system_msg] + non_system_msgs if system_msg else non_system_msgs

    response = client.responses.create(
        model=model,
        input=messages
    )
    assistant_reply = response.output_text
    # Met à jour l'historique
    chat_history.append({"role": "assistant", "content": assistant_reply})

    return assistant_reply

def run_gpt_stream(chat_history, model=MODEL_NAME, api_key=None):
    client = get_openai_client(api_key)
    
    system_msg = next((m for m in chat_history if m["role"] == "system"), None)
    non_system_msgs = [m for m in chat_history if m["role"] != "system"]
    non_system_msgs = non_system_msgs[-9:]
    messages = [system_msg] + non_system_msgs if system_msg else non_system_msgs

    response = client.responses.create(
        model=model,
        input=messages,
        stream=True
    )

    assistant_text = ""

    for event in response:
        if event.type == "response.output_text.delta":
            token = event.delta
            assistant_text += token
            yield token

    chat_history.append({
        "role": "assistant",
        "content": assistant_text
    })



RAG_STATUS_PREFIX = "__RAG_STATUS__:"
RAG_STEP_PREFIX = "STEP:"
RAG_FAILED_PREFIX = "FAILED_CODE:"
FAILED_CODE_MARKER = "__FAILED_CODE__:"

def process_user_query(user_query, chat_history, model, api_key=None):
    history = [msg for msg in chat_history]
    classification = classify_prompt(user_query, chat_history=history, api_key=api_key)
    print("classification:",classification)

    if classification == "code":
        def _rag_generator():
            env = os.environ.copy()
            env["API_KEY"] = api_key or get_api_key()

            proc = subprocess.Popen(
                [
                    "python3", "main_rag.py",
                    user_query,
                    json.dumps(history)
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
                env=env
            )

            final_code_lines = []
            failed_code_content = None
            is_failed = False

            for raw_line in proc.stdout:
                trimmed = raw_line.strip()
                if not trimmed:
                    if is_failed:
                        failed_code_content += "\n"
                    elif final_code_lines:
                        final_code_lines.append("\n")
                    continue
                if trimmed.startswith(RAG_STEP_PREFIX):
                    yield RAG_STATUS_PREFIX + trimmed[len(RAG_STEP_PREFIX):]
                elif trimmed.startswith(RAG_FAILED_PREFIX):
                    is_failed = True
                    failed_code_content = trimmed[len(RAG_FAILED_PREFIX):]
                elif is_failed:
                    failed_code_content += "\n" + raw_line.rstrip()
                elif trimmed.startswith("consolidated request:"):
                    continue
                else:
                    final_code_lines.append(raw_line.rstrip() + "\n")

            proc.wait()
            if proc.returncode != 0:
                stderr_out = proc.stderr.read()
                print("main_rag.py error:", stderr_out)

            if is_failed and failed_code_content:
                yield FAILED_CODE_MARKER + failed_code_content
            else:
                yield "".join(final_code_lines).strip()

        return _rag_generator()

    elif classification in {"general", "out"}:
        return run_gpt_stream(history, model, api_key=api_key)