import openai
import os
import re
import subprocess
import numpy as np
import faiss
import time
import csv
import json
from openai import OpenAI
import sys
import pickle
from config import get_api_key

# ----------- AUTHENTIFICATION -------------
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

# ----------- SUFFICIENCY CHECK -------------
def check_sufficient_info(query, history, api_key):
    """
    Fast check before any embedding or index loading.
    Prints a clarifying question to stdout and exits if info is missing.
    """
    client = get_openai_client(api_key)

    recent = [m for m in history if m["role"] != "system"][-4:]
    conversation = "\n".join(
        f"{'User' if m['role'] == 'user' else 'Assistant'}: {m['content'][:400]}"
        for m in recent
    )

    response = client.responses.create(
        model="gpt-4o-mini",
        input=[
            {
                "role": "system",
                "content": """You are BioBot, an expert assistant in lab automation and liquid handling robots.

Your job is to check whether a user's protocol request contains enough information to generate a working script.

If you judge that there are enough infomations in the whole conversation, you were given the conversation history for that, reply with exactly: SUFFICIENT
Ask kindly for more informations if you assume that there are not enough informations in order to generate the code. You are specialized, you know what informations to ask. 
Try to help with examples or suggest kindly some default set ups in order to help the user when he does not provide you with sufficient informations.

"""
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
    """
    Synthesizes a single self-contained protocol request from the full
    conversation. This ensures RAG always receives complete context even
    when the user's latest message was just providing missing parameters.
    """
    client = get_openai_client(api_key)

    recent = [m for m in history if m["role"] != "system"][-4:]
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
ALL the information provided across the entire conversation.

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

check_sufficient_info(user_query, chat_history, user_api_key)
consolidated_query = consolidate_request(user_query, chat_history, user_api_key)

# ----------- CLEANING & CHUNKING -------------
def clean_rst_content(content):
    content = re.sub(r"\.\. .*?::", "", content)
    content = re.sub(r":ref:`.*?`", "", content)
    return content

def split_rst_into_chunks(base_path, chunk_size=2048):
    chunks = []
    sources = []

    for root, dirs, files in os.walk(base_path):
        for file in files:
            if file.endswith(".rst"):
                full_path = os.path.join(root, file)
                with open(full_path, 'r', encoding='utf-8') as f:
                    content = f.read()
                    cleaned = clean_rst_content(content)

                    sections = re.split(r"\n\s*(=+|-+|~+|\^+|\++)\n", cleaned)
                    logical_sections = ["".join(pair).strip() for pair in zip(sections[::2], sections[1::2])]

                    for idx, section in enumerate(logical_sections):
                        for i in range(0, len(section), chunk_size):
                            chunk = section[i:i+chunk_size]
                            chunks.append(chunk)
                            sources.append(f"{file} (section {idx}, part {i // chunk_size})")
    return chunks, sources

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
                print(f"Rate limit hit. Retry {i+1}/{retries} in {delay} sec...")
                time.sleep(delay)
                delay *= 2
            else:
                raise
    raise RuntimeError("Failed to get embedding after retries.")

# ----------- CODE EXTRACTION -------------
def extract_code_from_response(response):
    code_blocks = re.findall(r"```(?:python)?\n(.*?)```", response, re.DOTALL)
    if code_blocks:
        return code_blocks[0].strip()

    lines = response.splitlines()
    code_lines = []
    code_started = False
    for line in lines:
        if line.strip().startswith(("import", "from", "def", "for", "while", "if", "class")) or line.strip().startswith(" "):
            code_started = True
            code_lines.append(line)
        elif code_started and line.strip() == "":
            code_lines.append(line)
        elif code_started:
            break
    return "\n".join(code_lines).strip()

# ----------- COMPLETION -------------
def run_gpt(user_message, model="gpt-5.4"):
    client = get_openai_client(user_api_key)
    messages = [
        {
            "role": "system",
            "content": "You are an expert assistant specialized in lab automation with every kind of liquid handler. Generate full, clean and functional Python code for lab automation protocols."
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

# ----------- SIMULATION -------------
def simulate_code(code, save_path="generated_script.py"):
    with open(save_path, "w") as f:
        f.write(code)
    result = subprocess.run(["opentrons_simulate", save_path], capture_output=True, text=True)
    return result.stdout, result.stderr

# ----------- REVERSE CHECK -------------
def reverse_check(user_query, generated_code):
    """
    Verify if the generated code actually matches the user's intention.
    """
    reverse_prompt = f"""
    You are an expert lab assistant in Python scripts for Opentrons laboratory robots.

    Here is a Python script :
    ```python
    {generated_code}
    
    And this is what the user requested : "{user_query}"

    Does this script match what the user requested ? Just in a general point of view, we don't need a precise comparison.
    Answer strictly with "Yes" or "No", followed by a short explanation.
    If the answer is no, ALWAYS suggest a corrected script right after.
    """
    verdict = run_gpt(reverse_prompt).strip()
    return verdict

# ----------- PROCESSUS PRINCIPAL -------------
def run_query_and_fix(question, chunks, chunk_sources, max_attempts=5):
    print("STEP:Analyzing your request...", flush=True)
    question_embedding = np.array([get_text_embedding_with_retry(question)])

    print("STEP:Searching documentation for relevant context...", flush=True)
    D, I = index.search(question_embedding, k=5)
    retrieved_chunks = [chunks[i] for i in I.tolist()[0]]
    retrieved_sources = [chunk_sources[i] for i in I.tolist()[0]]

    context = "\n\n".join(retrieved_chunks)
    prompt = f"""
Context information is below.
---------------------
{context}
---------------------
Given the context information and/or prior knowledge, answer the query.
Query: {question}
"""
    print("STEP:Generating protocol code...", flush=True)
    last_error = ""
    last_code = ""
    for attempt in range(1, max_attempts + 1):
        response = run_gpt(prompt)
        code = response

        if not code:
            break

        last_code = code

        print(f"STEP:Attempt {attempt} — running simulation check...", flush=True)
        stdout, stderr = simulate_code(code)
        if "Error" not in stderr and "Traceback" not in stderr and stdout.strip():
            print("STEP:Simulation passed — verifying semantic intent...", flush=True)
            verdict = reverse_check(question, code)
            blocks = re.findall(r"```(?:python)?\n(.*?)```", verdict, re.DOTALL)
            if blocks:
                suggested_code = blocks[0].strip()
                stdout, stderr = simulate_code(suggested_code)
            print("STEP:All checks passed! Returning final code...", flush=True)
            time.sleep(2)
            return code, retrieved_chunks, retrieved_sources, attempt, "", last_code

        print(f"STEP:Simulation failed on attempt {attempt} — correcting errors...", flush=True)
        prompt = f"""
I have some errors : 
{stderr}

Please correct accordingly this code you've given me : 
{code}

For the query : {question} 
And return the full corrected Python script, don't ask me to complete the code, don't ask me specific informations, always return a python code"""

        last_error = stderr.strip()

    return None, retrieved_chunks, retrieved_sources, attempt, last_error, last_code

# ----------- PIPELINE INIT -------------
base_path = "docs"
chunk_size = 3000
store_path = "rag_store.pkl"

if os.path.exists(store_path):
    print("STEP:Loading documentation index...", flush=True)
    with open(store_path, "rb") as f:
        store = pickle.load(f)
    chunks = store["chunks"]
    chunk_sources = store["chunk_sources"]
    text_embeddings = store["embeddings"]
    d = text_embeddings.shape[1]
    index = faiss.IndexFlatL2(d)
    index.add(text_embeddings)
else:
    print("STEP:Building documentation index (first run, this takes a moment)...", flush=True)
    chunks, chunk_sources = split_rst_into_chunks(base_path, chunk_size)
    text_embeddings = np.array([get_text_embedding_with_retry(chunk) for chunk in chunks])
    d = text_embeddings.shape[1]
    index = faiss.IndexFlatL2(d)
    index.add(text_embeddings)

    with open(store_path, "wb") as f:
        pickle.dump({
            "chunks": chunks,
            "chunk_sources": chunk_sources,
            "embeddings": text_embeddings
        }, f)
    
final_code, sources_used, file_refs, attempts, last_error, last_code = run_query_and_fix(consolidated_query, chunks, chunk_sources)

if final_code:
    print(final_code)
else:
    print("STEP:Generation failed — preparing last attempt for review...", flush=True)
    time.sleep(3)
    fail_msg = (
        "I wasn't able to generate a fully functional script after several attempts. "
        "The simulation kept returning errors that I couldn't resolve automatically. "
        "Here is the latest version of the script I generated — it may need some manual adjustments:"
    )
    print("FAILED_CODE:" + fail_msg + "___CODE_SEP___" + (last_code or "# No code was generated."), flush=True)