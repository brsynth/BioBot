import subprocess
import json
from openai import OpenAI
import os
from config import get_api_key, biobot_model, light_functions_model
    

def get_openai_client(api_key=None):
    return OpenAI(api_key=api_key or get_api_key())

def classify_prompt(prompt, chat_history=None, model_name=light_functions_model, api_key=None):
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
            "content": """You are an intent classifier for BioBot, an AI assistant specialized in laboratory automation and liquid-handling systems.

You will be given a user message, and optionally the recent conversation that preceded it. Your task is to classify ONLY the user's LATEST message into one of three categories:

1. "code"
   The user explicitly wants to generate, modify, extend, correct, or complete a laboratory automation script or protocol.

   Examples:
   - Generate an OT-2 protocol to transfer 100 µL.
   - Change the pipette to a P300.
   - Add a mixing step to the existing protocol.
   - Fix the error in the generated script.
   - The user provides missing protocol parameters requested by BioBot during an unfinished code-generation workflow.

2. "general"
   The user asks a question, requests an explanation, or seeks information about laboratory automation, liquid handlers, protocols, or previously generated code, WITHOUT requesting code generation or modification.

   Examples:
   - How does this generated protocol work?
   - How do I execute this code on my OT-2?
   - What does this function do?
   - How do I connect my Hamilton STAR?
   - What is the difference between a P300 and a P1000?
   - Why did you choose this pipette?

3. "out"
   The user's request is unrelated to laboratory automation.

IMPORTANT CLASSIFICATION RULES:

- ALWAYS prioritize the intent expressed in the latest user message.
- Use conversation history to understand references, pronouns, and the context of the request, NOT to automatically assume that the user wants to continue generating code.
- A previous code-generation request does NOT mean that subsequent messages should be classified as "code".
- Questions about previously generated code, its execution, functionality, parameters, or usage must be classified as "general" unless the user explicitly requests a modification or new code.
- If the user explicitly asks to modify, extend, correct, or regenerate code, classify as "code".
- If BioBot previously requested missing protocol parameters and the user provides those parameters, classify as "code".
- Even when a code-generation workflow is pending, an explicit informational question must be classified as "general".
- Do not interpret every message related to an existing protocol as a request to generate code.

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

def run_gpt_stream(chat_history, model=biobot_model, api_key=None):
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
RAG_FORMAT_PREFIX = "FORMAT:"
RAG_QUESTIONS_PREFIX = "QUESTIONS:"
FAILED_CODE_MARKER = "__FAILED_CODE__:"
FORMAT_MARKER = "__FORMAT__:"
QUESTIONS_MARKER = "__QUESTIONS__:"

def process_user_query(user_query, chat_history, model, api_key=None):
    history = [msg for msg in chat_history]
    classification = classify_prompt(user_query, chat_history=history, api_key=api_key)

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
            detected_format = "python"

            for raw_line in proc.stdout:
                trimmed = raw_line.strip()
                if not trimmed:
                    if is_failed:
                        failed_code_content += "\n"
                    elif final_code_lines:
                        final_code_lines.append("\n")
                    continue
                if trimmed.startswith(RAG_QUESTIONS_PREFIX):
                    # Structured questions from sufficiency check — pass through to frontend
                    yield QUESTIONS_MARKER + trimmed[len(RAG_QUESTIONS_PREFIX):]
                elif trimmed.startswith(RAG_STEP_PREFIX):
                    yield RAG_STATUS_PREFIX + trimmed[len(RAG_STEP_PREFIX):]
                elif trimmed.startswith(RAG_FORMAT_PREFIX):
                    detected_format = trimmed[len(RAG_FORMAT_PREFIX):]
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

            # Send format + content as a single yield
            if is_failed and failed_code_content:
                yield FORMAT_MARKER + detected_format + "\n" + FAILED_CODE_MARKER + failed_code_content
            else:
                content = "".join(final_code_lines).strip()
                yield FORMAT_MARKER + detected_format + "\n" + content

        return _rag_generator()

    elif classification in {"general", "out"}:
        return run_gpt_stream(history, model, api_key=api_key)
    
    else:
        return run_gpt_stream(history, model, api_key=api_key)