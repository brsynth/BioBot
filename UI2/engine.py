import subprocess
from openai import OpenAI
import os

def get_api_key():
    secret_path = "/run/secrets/brsbot_api_key"
    if os.path.exists(secret_path):
        with open(secret_path, "r") as f:
            return f.read().strip()
    else:
        raise ValueError("API KEY not found")
    
MODEL_NAME_CLASS = "gpt-4o-mini"
MODEL_NAME = "gpt-5"

def get_openai_client(api_key=None):
    return OpenAI(api_key=api_key or get_api_key())

def classify_prompt(prompt, model_name = MODEL_NAME_CLASS, api_key = None):
    client = get_openai_client(api_key)
    classification_prompt = [
        {
            "role": "system",
            "content": """You are a classifier assistant. Classify the user request according to 3 possibilities :

1. "code" : If the user is asking for a code generation, an automation or a script for a protocol.
2. "general" : If the user is asking a question in the field of lab, liquid handlers and lab automation, without necessarily asking for a script/code generation.
3. "out" : If the request is out of scope, and has nothing to do with the specialization of lab automation and liquid handlers and related fields.
Make in mind that the user is not talking to you, so if he seems to be talking to you, he's not. Your role is just to classify his request by giving only the name of the category and nothing more, you give only one word.
Your should answer with ONLY one word which is one of these 3 categories : code, general, or out. And nothing more. Return ONLY THE NAME OF THE CATEGORY and don't ever never give an explanation, only the name of the category. If you don't know where to classify, give the most close one and with only THE NAME of one of the 3 categories."""
        },
        {
            "role": "user",
            "content": prompt
        }
    ]

    response = client.responses.create(
        model=model_name,
        input=classification_prompt
    )
    return response.output_text

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



def process_user_query(user_query, chat_history, model, api_key=None):
    classification = classify_prompt(user_query,api_key=api_key)
    history = [msg for msg in chat_history]

    if classification == "code":
        # Exécute le RAG dans un subprocess, récupère stdout
        result = subprocess.run(["python3", "main_rag.py", user_query, api_key or get_api_key()], capture_output=True, text=True)
        if result.returncode != 0:
            print("main_rag.py error:", result.stderr)
        return result.stdout.strip()

    elif classification in {"general", "out"}:
        return run_gpt_stream(history,model, api_key =api_key)
