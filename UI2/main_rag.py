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

# ----------- AUTHENTIFICATION -------------
if len(sys.argv) > 1:
    user_query = sys.argv[1]
    user_api_key = sys.argv[2]
else:
    raise ValueError("Usage: python3 main_rag.py '<question>' '<api_key>'")

    

def get_openai_client(api_key):
    return OpenAI(api_key=api_key)

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
def run_gpt(user_message, model="gpt-5"):
    client = get_openai_client(user_api_key)
    messages = [
        {
            "role": "system",
            "content": "You are an expert assistant specialized in lab automation with the Opentrons OT-2 robot. Generate full, clean and functional Python code for lab automation protocols."
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
    question_embedding = np.array([get_text_embedding_with_retry(question)])
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
    last_error =""
    for attempt in range(1, max_attempts + 1):
        response = run_gpt(prompt)
        code = response

        if not code:
            break

        stdout, stderr = simulate_code(code)
        if "Error" not in stderr and "Traceback" not in stderr and stdout.strip():
            verdict = reverse_check(question, code)
            blocks = re.findall(r"```(?:python)?\n(.*?)```", verdict, re.DOTALL)
            if blocks:
                suggested_code = blocks[0].strip()
                stdout, stderr = simulate_code(suggested_code)
            return code, retrieved_chunks, retrieved_sources, attempt, ""

        prompt = f"""
I have some errors : 
{stderr}

Please correct accordingly this code you've given me : 
{code}

For the query : {question} 
And return the full corrected Python script, don't ask me to complete the code, don't ask me specific informations, always return a python code"""

        last_error = stderr.strip()

    return None, retrieved_chunks, retrieved_sources, attempt, last_error

# ----------- PIPELINE INIT -------------
base_path = "docs"
chunk_size = 3000
chunks, chunk_sources = split_rst_into_chunks(base_path, chunk_size)
text_embeddings = np.array([get_text_embedding_with_retry(chunk) for chunk in chunks])
d = text_embeddings.shape[1]
index = faiss.IndexFlatL2(d)
index.add(text_embeddings)
    
final_code, sources_used, file_refs, attempts, last_error = run_query_and_fix(user_query, chunks, chunk_sources)
print(final_code)

if not final_code:
        print("\n🛑 Code non fonctionnel après plusieurs tentatives.")
        



"""
def run_gpt(user_message, model="gpt-5"):
    messages = [
        {
            "role": "system",
            "content": fYou are an expert assistant specialized in lab automation with the Opentrons OT-2 robot. 
            -Generate full, clean and functional Python code for lab automation protocols. 
            -If information is missing (- Platform (e.g., Opentrons OT-2/OT-3, Hamilton, Tecan)
            - Labware (plates/tubes, volumes, positions)
            - Pipettes/tips (models, mount, tip sizes)
            - Steps (transfers, mixes, dilutions, temps, pauses)
            - Modules (temp, magnet, heater-shaker, thermocycler)
            - Any constraints (max volume per step, speed, sterile technique)), ask for it.
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
    """